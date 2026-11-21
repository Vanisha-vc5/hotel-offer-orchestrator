/**
 * Cache correctness against a real Redis: three cache states, TTLs on every key,
 * versioned writes (no rollback by older runs), the partial-result policy, and
 * proof that price filtering executes inside Redis.
 */
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HotelOffer } from '../../src/domain/types';
import { HotelRepository, cityKeys } from '../../src/infra/hotelRepository';
import type { PersistPayload } from '../../src/temporal/shared';
import { connectTestRedis, uniqueCity } from '../helpers/redis';

const offer = (
  name: string,
  price: number,
  supplier: 'Supplier A' | 'Supplier B' = 'Supplier A',
): HotelOffer => ({
  name,
  price,
  supplier,
  commissionPct: 10,
});

function payload(
  offers: HotelOffer[],
  opts: { partial?: boolean; generation?: number; runId?: string } = {},
): PersistPayload {
  return {
    offers,
    decisions: [],
    suppliersStatus: { A: 'up', B: opts.partial ? 'down' : 'up' },
    resultStatus: opts.partial ? 'partial' : 'complete',
    workflowId: 'hotel-offers-test',
    runId: opts.runId ?? 'run',
    requestId: 'req',
    generation: opts.generation,
  };
}

const names = (offers: HotelOffer[]): string[] => offers.map((o) => o.name);

describe('cache policy (real Redis)', () => {
  let redis: Redis;
  let repo: HotelRepository;
  const cities: string[] = [];
  const city = (): string => {
    const c = uniqueCity('policy');
    cities.push(c);
    return c;
  };

  beforeAll(async () => {
    redis = await connectTestRedis();
    repo = new HotelRepository(redis);
  });
  afterEach(async () => {
    for (const c of cities.splice(0)) await repo.deleteCity(c);
  });
  afterAll(async () => {
    await redis.quit();
  });

  describe('three cache states', () => {
    it('miss: nothing cached → hit:false (the caller must run the workflow)', async () => {
      expect(await repo.filterByPrice(city())).toEqual({ hit: false });
    });

    it('cached empty: a successful lookup with no hotels is a HIT with []', async () => {
      const c = city();
      expect(await repo.saveCityOffers(c, payload([]), 60)).toBe('written');
      expect(await repo.filterByPrice(c)).toMatchObject({
        hit: true,
        offers: [],
        meta: { count: 0 },
      });
      expect(await redis.exists(cityKeys(c).byPrice)).toBe(0); // no members, meta only
    });

    it('cached non-empty: offers are returned from Redis', async () => {
      const c = city();
      await repo.saveCityOffers(c, payload([offer('A', 100), offer('B', 200)]), 60);
      const res = await repo.filterByPrice(c);
      expect(res.hit && names(res.offers)).toEqual(['A', 'B']);
    });
  });

  describe('TTL', () => {
    it('applies the given TTL to every key of the city, and the entry disappears after it', async () => {
      const c = city();
      await repo.saveCityOffers(c, payload([offer('A', 100)]), 1);
      const k = cityKeys(c);
      for (const key of [k.byPrice, k.offers, k.meta]) {
        expect(await redis.pttl(key)).toBeGreaterThan(0);
        expect(await redis.pttl(key)).toBeLessThanOrEqual(1000);
      }
      await new Promise((r) => setTimeout(r, 1_300));
      expect(await repo.filterByPrice(c)).toEqual({ hit: false });
      expect(await redis.exists(k.byPrice, k.offers, k.meta)).toBe(0);
    });
  });

  describe('versioned writes (no rollback by an older run)', () => {
    it('rejects a write older than the cached generation and keeps the newer data', async () => {
      const c = city();
      expect(
        await repo.saveCityOffers(c, payload([offer('New', 100)], { generation: 2_000 }), 60),
      ).toBe('written');
      expect(
        await repo.saveCityOffers(c, payload([offer('Old', 50)], { generation: 1_000 }), 60),
      ).toBe('stale');
      const res = await repo.filterByPrice(c);
      expect(res.hit && names(res.offers)).toEqual(['New']);
      expect(await redis.hget(cityKeys(c).meta, 'generation')).toBe('2000');
    });

    it('accepts the same generation (idempotent retry of the same run) and newer ones', async () => {
      const c = city();
      await repo.saveCityOffers(c, payload([offer('X', 1)], { generation: 5 }), 60);
      expect(await repo.saveCityOffers(c, payload([offer('X', 1)], { generation: 5 }), 60)).toBe(
        'written',
      );
      expect(await repo.saveCityOffers(c, payload([offer('Y', 2)], { generation: 6 }), 60)).toBe(
        'written',
      );
      const res = await repo.filterByPrice(c);
      expect(res.hit && names(res.offers)).toEqual(['Y']);
    });

    it('concurrent writers: the newest generation always wins, whatever the arrival order', async () => {
      const c = city();
      const gens = [7, 3, 9, 1, 8, 2, 6, 4, 5];
      const outcomes = await Promise.all(
        gens.map((g) =>
          repo.saveCityOffers(c, payload([offer(`gen-${g}`, g)], { generation: g }), 60),
        ),
      );
      expect(outcomes.filter((o) => o === 'written').length).toBeGreaterThanOrEqual(1);
      const res = await repo.filterByPrice(c);
      expect(res.hit && names(res.offers)).toEqual(['gen-9']);
      expect(await redis.zcard(cityKeys(c).byPrice)).toBe(1); // never a mix of generations
    });

    it('removes hotels that disappeared from the newer result (full replacement)', async () => {
      const c = city();
      await repo.saveCityOffers(
        c,
        payload([offer('Stays', 1), offer('Gone', 2)], { generation: 1 }),
        60,
      );
      await repo.saveCityOffers(
        c,
        payload([offer('Stays', 1), offer('Added', 3)], { generation: 2 }),
        60,
      );
      const res = await repo.filterByPrice(c);
      expect(res.hit && names(res.offers)).toEqual(['Stays', 'Added']);
    });
  });

  describe('partial results (one supplier failed)', () => {
    it('never replace a still-valid complete entry', async () => {
      const c = city();
      await repo.saveCityOffers(
        c,
        payload([offer('A1', 1), offer('B1', 2, 'Supplier B')], { generation: 1 }),
        120,
      );
      const ttlBefore = await redis.ttl(cityKeys(c).meta);
      expect(
        await repo.saveCityOffers(
          c,
          payload([offer('A1', 1)], { partial: true, generation: 2 }),
          30,
        ),
      ).toBe('kept_complete');
      const res = await repo.filterByPrice(c);
      expect(res.hit && names(res.offers)).toEqual(['A1', 'B1']);
      expect(res.hit && res.meta.resultStatus).toBe('complete');
      expect(await redis.ttl(cityKeys(c).meta)).toBeLessThanOrEqual(ttlBefore); // TTL not extended
    });

    it('fill an empty slot with the short partial TTL, and a complete result replaces them', async () => {
      const c = city();
      expect(
        await repo.saveCityOffers(
          c,
          payload([offer('A1', 1)], { partial: true, generation: 1 }),
          30,
        ),
      ).toBe('written');
      expect(await redis.ttl(cityKeys(c).meta)).toBeLessThanOrEqual(30);
      expect(
        await repo.saveCityOffers(
          c,
          payload([offer('A1', 1)], { partial: true, generation: 2 }),
          30,
        ),
      ).toBe('written');
      expect(
        await repo.saveCityOffers(
          c,
          payload([offer('A1', 1), offer('B1', 2)], { generation: 3 }),
          300,
        ),
      ).toBe('written');
      const res = await repo.filterByPrice(c);
      expect(res.hit && res.meta.resultStatus).toBe('complete');
      expect(await redis.ttl(cityKeys(c).meta)).toBeGreaterThan(30);
    });
  });

  describe('price filtering runs inside Redis', () => {
    it('is a single Lua call (EVALSHA/EVAL) with the min/max bounds, not a JS filter', async () => {
      const c = city();
      await repo.saveCityOffers(
        c,
        payload([offer('Low', 100), offer('Mid', 500), offer('High', 900)]),
        60,
      );
      const monitor = await redis.monitor();
      const seen: string[][] = [];
      monitor.on('monitor', (_time: string, args: string[]) => {
        if (args.some((a) => a.includes(`{${c}}`))) seen.push(args);
      });
      try {
        await new Promise((r) => setTimeout(r, 100));
        const res = await repo.filterByPrice(c, { minPrice: 200, maxPrice: 900 });
        expect(res.hit && names(res.offers)).toEqual(['Mid', 'High']);
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        monitor.disconnect();
      }
      const top = seen.filter((a) => /^(evalsha|eval)$/i.test(a[0] ?? ''));
      expect(top).toHaveLength(1); // one round trip, nothing else fetched by the client
      expect(top[0]).toEqual(expect.arrayContaining(['200', '900']));
      // ZRANGEBYSCORE ran inside the script, on the server
      expect(seen.some((a) => a[0]?.toLowerCase() === 'zrangebyscore')).toBe(true);
    });
  });
});
