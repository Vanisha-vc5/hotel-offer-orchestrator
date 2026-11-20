import type { Redis } from 'ioredis';
import { RedisUnavailableError } from '../domain/errors';
import { normalizeName } from '../domain/selectBestOffers';
import type { PossibleDuplicate } from '../domain/duplicates';
import type { Decision, HotelOffer, ResultStatus } from '../domain/types';
import type { PersistPayload } from '../temporal/shared';
import { formatSuppliersStatus } from '../temporal/shared';

/**
 * Hash-tagged keys: `{city}` makes all three keys of a city hash to the same
 * slot, so MULTI and the Lua script stay valid on Redis Cluster.
 */
export function cityKeys(city: string): { byPrice: string; offers: string; meta: string } {
  const tag = `hotels:{${city}}`;
  return { byPrice: `${tag}:by_price`, offers: `${tag}:offers`, meta: `${tag}:meta` };
}

export interface CityMeta {
  fetchedAt: string;
  workflowId: string;
  runId: string;
  requestId: string;
  count: number;
  suppliersStatus: string;
  resultStatus: ResultStatus;
  ttlSeconds: number;
}

/** Meta fields returned by the filter script, in this order. */
const META_FIELDS = [
  'fetchedAt',
  'workflowId',
  'runId',
  'requestId',
  'count',
  'suppliersStatus',
  'resultStatus',
  'ttlSeconds',
] as const;

export type FilterResult = { hit: false } | { hit: true; offers: HotelOffer[]; meta: CityMeta };

export interface PriceRange {
  minPrice?: number;
  maxPrice?: number;
}

function toMeta(values: ReadonlyArray<string | null | undefined>): CityMeta {
  const get = (i: number): string => values[i] ?? '';
  return {
    fetchedAt: get(0),
    workflowId: get(1),
    runId: get(2),
    requestId: get(3),
    count: Number(get(4) || 0),
    suppliersStatus: get(5),
    resultStatus: get(6) === 'partial' ? 'partial' : 'complete',
    ttlSeconds: Number(get(7) || 0),
  };
}

/** Only the four public fields are ever stored, in a fixed key order. */
function toStoredOffer(o: HotelOffer): HotelOffer {
  return { name: o.name, price: o.price, supplier: o.supplier, commissionPct: o.commissionPct };
}

const HSET_IF_EXISTS =
  "if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end return -1";

async function guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new RedisUnavailableError(`Cache (Redis) operation failed: ${op}`, err);
  }
}

/** The ONLY module that reads/writes hotel data in Redis. */
export class HotelRepository {
  constructor(private readonly redis: Redis) {}

  /**
   * Atomically replaces a city's cached result: DEL → ZADD → HSET offers →
   * HSET meta → EXPIRE, all inside one MULTI/EXEC. Readers never observe a
   * half-written city. Meta is written even for an empty result so that
   * "no hotels in this city" is itself a cache HIT.
   */
  async saveCityOffers(
    city: string,
    payload: PersistPayload,
    ttlSeconds: number,
    fetchedAt: Date = new Date(),
  ): Promise<void> {
    const k = cityKeys(city);
    const tx = this.redis.multi().del(k.byPrice, k.offers, k.meta);

    if (payload.offers.length > 0) {
      const zargs: Array<string | number> = [];
      const hash: Record<string, string> = {};
      for (const offer of payload.offers) {
        const member = normalizeName(offer.name);
        zargs.push(offer.price, member);
        hash[member] = JSON.stringify(toStoredOffer(offer));
      }
      tx.zadd(k.byPrice, ...zargs).hset(k.offers, hash);
    }

    tx.hset(k.meta, {
      fetchedAt: fetchedAt.toISOString(),
      workflowId: payload.workflowId,
      runId: payload.runId,
      requestId: payload.requestId,
      count: String(payload.offers.length),
      suppliersStatus: formatSuppliersStatus(payload.suppliersStatus),
      resultStatus: payload.resultStatus,
      ttlSeconds: String(ttlSeconds),
      decisions: JSON.stringify(payload.decisions),
    })
      .expire(k.byPrice, ttlSeconds)
      .expire(k.offers, ttlSeconds)
      .expire(k.meta, ttlSeconds);

    const results = await guard('saveCityOffers', () => tx.exec());
    const failed = results?.find(([err]) => err);
    if (!results || failed) {
      throw new RedisUnavailableError('Cache transaction failed', failed?.[0] ?? 'EXEC aborted');
    }
  }

  /**
   * Price filter executed INSIDE Redis by filterByPrice.lua: cache check +
   * ZRANGEBYSCORE (inclusive, ±inf) + HMGET in one atomic round trip.
   * Results come back ordered by (price, normalized name).
   */
  async filterByPrice(city: string, range: PriceRange = {}): Promise<FilterResult> {
    const k = cityKeys(city);
    const min = range.minPrice === undefined ? '-inf' : String(range.minPrice);
    const max = range.maxPrice === undefined ? '+inf' : String(range.maxPrice);
    const reply = await guard('filterByPrice', () =>
      this.redis.filterByPrice(k.byPrice, k.offers, k.meta, min, max, ...META_FIELDS),
    );
    if (reply === null) return { hit: false };

    const [metaValues, offerJsons] = reply;
    const offers: HotelOffer[] = [];
    for (const json of offerJsons) {
      if (json) offers.push(JSON.parse(json) as HotelOffer);
    }
    return { hit: true, offers, meta: toMeta(metaValues) };
  }

  /** Cached meta + decision log for a city, or null if not cached. */
  async getInsightsSource(city: string): Promise<{ meta: CityMeta; decisions: Decision[] } | null> {
    const raw = await guard('getMeta', () => this.redis.hgetall(cityKeys(city).meta));
    if (!raw.fetchedAt) return null;
    return {
      meta: toMeta(META_FIELDS.map((f) => raw[f])),
      decisions: raw.decisions ? (JSON.parse(raw.decisions) as Decision[]) : [],
    };
  }

  /** Enhancement 6: cached duplicate review for the city's current data, or null. */
  async getPossibleDuplicates(city: string): Promise<PossibleDuplicate[] | null> {
    const raw = await guard('getPossibleDuplicates', () =>
      this.redis.hget(cityKeys(city).meta, 'possibleDuplicates'),
    );
    return raw ? (JSON.parse(raw) as PossibleDuplicate[]) : null;
  }

  /**
   * Stores the review in the city's meta hash ONLY if that meta still exists
   * (one atomic script). Creating meta here would fake a cache HIT. The review
   * disappears with the meta on the next refresh, so it never outlives its data.
   */
  async savePossibleDuplicates(city: string, review: PossibleDuplicate[]): Promise<boolean> {
    const result = await guard('savePossibleDuplicates', () =>
      this.redis.eval(
        HSET_IF_EXISTS,
        1,
        cityKeys(city).meta,
        'possibleDuplicates',
        JSON.stringify(review),
      ),
    );
    return result !== -1;
  }

  async ttl(city: string): Promise<number> {
    return guard('ttl', () => this.redis.ttl(cityKeys(city).meta));
  }

  /** Removes a city's cache; returns the number of keys deleted. */
  async deleteCity(city: string): Promise<number> {
    const k = cityKeys(city);
    return guard('deleteCity', () => this.redis.del(k.byPrice, k.offers, k.meta));
  }

  /** PING round-trip in ms. Throws if Redis is unreachable. */
  async ping(): Promise<number> {
    const start = performance.now();
    await guard('ping', () => this.redis.ping());
    return Math.round(performance.now() - start);
  }
}
