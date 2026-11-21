import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { selectBestOffers } from '../../src/domain/selectBestOffers';
import type { HotelOffer, SupplierHotel } from '../../src/domain/types';
import { HotelRepository, cityKeys } from '../../src/infra/hotelRepository';
import { supplierAHotels } from '../../src/mocks/supplierA.data';
import { supplierBHotels } from '../../src/mocks/supplierB.data';
import type { PersistPayload } from '../../src/temporal/shared';
import { connectTestRedis, uniqueCity } from '../helpers/redis';

const delhi = (list: SupplierHotel[]): SupplierHotel[] => list.filter((h) => h.city === 'delhi');

function payload(offers: HotelOffer[], partial = false): PersistPayload {
  return {
    offers,
    decisions: [],
    suppliersStatus: { A: 'up', B: partial ? 'down' : 'up' },
    resultStatus: partial ? 'partial' : 'complete',
    workflowId: 'hotel-offers-test',
    runId: 'run-1',
    requestId: 'req-1',
  };
}

const delhiOffers = selectBestOffers({
  A: delhi(supplierAHotels),
  B: delhi(supplierBHotels),
}).offers;
const names = (offers: HotelOffer[]): string[] => offers.map((o) => o.name);

describe('HotelRepository (real Redis)', () => {
  let redis: Redis;
  let repo: HotelRepository;
  const cities: string[] = [];
  const city = (): string => {
    const c = uniqueCity('repo');
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

  it('reports a MISS for an uncached city', async () => {
    expect(await repo.filterByPrice(city())).toEqual({ hit: false });
  });

  it('returns all offers sorted by price for an open-ended range', async () => {
    const c = city();
    await repo.saveCityOffers(c, payload(delhiOffers), 60);
    const res = await repo.filterByPrice(c);
    expect(res.hit).toBe(true);
    if (!res.hit) return;
    expect(res.offers).toEqual(delhiOffers);
    expect(res.meta).toMatchObject({
      count: 7,
      resultStatus: 'complete',
      suppliersStatus: 'A=up;B=up',
    });
  });

  it('filters with inclusive min/max boundaries', async () => {
    const c = city();
    await repo.saveCityOffers(c, payload(delhiOffers), 60);
    const res = await repo.filterByPrice(c, { minPrice: 5340, maxPrice: 8400 });
    expect(res.hit && names(res.offers)).toEqual(['Holtin', 'Radison', 'Hyatt Regency']);

    const exact = await repo.filterByPrice(c, { minPrice: 5900, maxPrice: 5900 });
    expect(exact.hit && names(exact.offers)).toEqual(['Radison']);

    const spec = await repo.filterByPrice(c, { minPrice: 5000, maxPrice: 9000 });
    expect(spec.hit && names(spec.offers)).toEqual(['Holtin', 'Radison', 'Hyatt Regency']);
  });

  it('supports only-min and only-max ranges', async () => {
    const c = city();
    await repo.saveCityOffers(c, payload(delhiOffers), 60);
    const min = await repo.filterByPrice(c, { minPrice: 9000 });
    expect(min.hit && names(min.offers)).toEqual(['The Leela', 'Taj Palace']);
    const max = await repo.filterByPrice(c, { maxPrice: 3000 });
    expect(max.hit && names(max.offers)).toEqual(['Ibis']);
  });

  it('returns a HIT with [] when no offer is in range', async () => {
    const c = city();
    await repo.saveCityOffers(c, payload(delhiOffers), 60);
    expect(await repo.filterByPrice(c, { minPrice: 50_000 })).toMatchObject({
      hit: true,
      offers: [],
    });
  });

  it('treats a cached empty city as a HIT', async () => {
    const c = city();
    await repo.saveCityOffers(c, payload([]), 60);
    const res = await repo.filterByPrice(c);
    expect(res).toMatchObject({ hit: true, offers: [], meta: { count: 0 } });
  });

  it('applies the TTL to every key', async () => {
    const c = city();
    await repo.saveCityOffers(c, payload(delhiOffers), 120);
    const k = cityKeys(c);
    for (const key of [k.byPrice, k.offers, k.meta]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(110);
      expect(ttl).toBeLessThanOrEqual(120);
    }
  });

  it('atomically replaces old data on rewrite', async () => {
    // Starts from a PARTIAL entry: by policy a partial never replaces a complete one
    // (covered by the cache-policy tests below); partial → partial must fully replace.
    const c = city();
    await repo.saveCityOffers(c, payload(delhiOffers, true), 60);
    const fresh: HotelOffer[] = [
      { name: 'Only One', price: 100, supplier: 'Supplier A', commissionPct: 5 },
    ];
    await repo.saveCityOffers(c, payload(fresh, true), 30);

    const res = await repo.filterByPrice(c);
    expect(res.hit && res.offers).toEqual(fresh);
    expect(res.hit && res.meta.resultStatus).toBe('partial');
    expect(await redis.zcard(cityKeys(c).byPrice)).toBe(1);
    expect(await redis.hlen(cityKeys(c).offers)).toBe(1);
    expect(await redis.ttl(cityKeys(c).meta)).toBeLessThanOrEqual(30);
  });

  it('uses hash-tagged keys so a city lives in one cluster slot', () => {
    expect(cityKeys('delhi')).toEqual({
      byPrice: 'hotels:{delhi}:by_price',
      offers: 'hotels:{delhi}:offers',
      meta: 'hotels:{delhi}:meta',
    });
  });

  it('stores exactly the four public fields per offer', async () => {
    const c = city();
    const dirty = { ...delhiOffers[0], extra: 'x' } as unknown as HotelOffer;
    await repo.saveCityOffers(c, payload([dirty]), 60);
    const res = await repo.filterByPrice(c);
    expect(res.hit && Object.keys(res.offers[0] ?? {})).toEqual([
      'name',
      'price',
      'supplier',
      'commissionPct',
    ]);
  });
});
