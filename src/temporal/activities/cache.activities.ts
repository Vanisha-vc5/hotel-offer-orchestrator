import { ApplicationFailure, Context, log } from '@temporalio/activity';
import { FailureTypes } from '../../domain/errors';
import type { Config } from '../../infra/config';
import type { HotelRepository } from '../../infra/hotelRepository';
import type { WriteOutcome } from '../../infra/hotelRepository';
import type { PersistPayload } from '../shared';

export interface CacheActivities {
  persistOffers(
    city: string,
    result: PersistPayload,
  ): Promise<{ ttlSeconds: number; outcome?: WriteOutcome }>;
}

export function createCacheActivities(repository: HotelRepository, cfg: Config): CacheActivities {
  return {
    /**
     * Atomically writes the workflow result to Redis. Partial results get a
     * shorter TTL so the cache heals quickly once the failed supplier is back.
     */
    async persistOffers(city, result) {
      const attempt = Context.current().info.attempt;
      const ttlSeconds =
        result.resultStatus === 'partial' ? cfg.PARTIAL_CACHE_TTL_SECONDS : cfg.CACHE_TTL_SECONDS;
      let outcome: WriteOutcome;
      try {
        outcome = await repository.saveCityOffers(city, result, ttlSeconds);
      } catch (err) {
        log.warn('persist failed', {
          city,
          attempt,
          requestId: result.requestId,
          err: String(err),
        });
        throw ApplicationFailure.retryable(
          `Could not write offers for ${city} to Redis: ${(err as Error).message}`,
          FailureTypes.CacheUnavailable,
        );
      }
      const meta = {
        city,
        attempt,
        requestId: result.requestId,
        count: result.offers.length,
        resultStatus: result.resultStatus,
        generation: result.generation,
        outcome,
      };
      if (outcome === 'written') log.info('offers persisted', { ...meta, ttlSeconds });
      else log.info('cache write skipped', meta); // 'stale' or 'kept_complete' (policy, not an error)
      return { ttlSeconds, outcome };
    },
  };
}
