import { RedisUnavailableError } from '../../domain/errors';
import type { Decision, HotelOffer, ResultStatus } from '../../domain/types';
import type { CityMeta, HotelRepository, PriceRange } from '../../infra/hotelRepository';
import type { WorkflowRun } from '../../temporal/client';
import { formatSuppliersStatus } from '../../temporal/shared';

export type WorkflowRunner = (input: { city: string; requestId: string }) => Promise<WorkflowRun>;

export type CacheStatus = 'HIT' | 'MISS';

/** Everything a hotels response needs: the body (offers) plus header metadata. */
export interface OffersResult {
  offers: HotelOffer[];
  workflowId: string;
  runId: string;
  suppliersStatus: string;
  resultStatus: ResultStatus;
  cache: CacheStatus;
}

export interface InsightsResult {
  meta: CityMeta;
  decisions: Decision[];
  cache: CacheStatus;
}

/** Orchestrates "run the workflow" vs "serve from Redis". Routes stay thin. */
export class HotelService {
  constructor(
    private readonly runWorkflow: WorkflowRunner,
    private readonly repository: HotelRepository,
  ) {}

  /** Unfiltered: always a fresh workflow run (which also refreshes the cache). */
  async getOffers(city: string, requestId: string): Promise<OffersResult> {
    const run = await this.runWorkflow({ city, requestId });
    return {
      offers: run.result.offers,
      workflowId: run.workflowId,
      runId: run.runId,
      suppliersStatus: formatSuppliersStatus(run.result.suppliersStatus),
      resultStatus: run.result.resultStatus,
      cache: 'MISS',
    };
  }

  /**
   * Filtered: price filtering always happens inside Redis (Lua). A cached city
   * is a HIT; otherwise (or with refresh) the workflow runs first and persists.
   */
  async getFilteredOffers(
    city: string,
    range: PriceRange,
    opts: { refresh: boolean; requestId: string },
  ): Promise<OffersResult> {
    if (!opts.refresh) {
      const cached = await this.repository.filterByPrice(city, range);
      if (cached.hit) {
        return {
          offers: cached.offers,
          workflowId: cached.meta.workflowId,
          runId: cached.meta.runId,
          suppliersStatus: cached.meta.suppliersStatus,
          resultStatus: cached.meta.resultStatus,
          cache: 'HIT',
        };
      }
    }

    const run = await this.runWorkflow({ city, requestId: opts.requestId });
    const fresh = await this.repository.filterByPrice(city, range);
    if (!fresh.hit) {
      // The workflow persisted successfully, so this means the entry vanished (eviction/flush).
      throw new RedisUnavailableError('Cache entry missing right after it was written');
    }
    return {
      offers: fresh.offers,
      workflowId: run.workflowId,
      runId: run.runId,
      suppliersStatus: formatSuppliersStatus(run.result.suppliersStatus),
      resultStatus: run.result.resultStatus,
      cache: 'MISS',
    };
  }

  /** Decision log for a city, from Redis meta (runs the workflow on a cache miss). */
  async getInsights(
    city: string,
    opts: { refresh: boolean; requestId: string },
  ): Promise<InsightsResult> {
    if (!opts.refresh) {
      const cached = await this.repository.getInsightsSource(city);
      if (cached) return { ...cached, cache: 'HIT' };
    }
    await this.runWorkflow({ city, requestId: opts.requestId });
    const fresh = await this.repository.getInsightsSource(city);
    if (!fresh) throw new RedisUnavailableError('Cache entry missing right after it was written');
    return { ...fresh, cache: 'MISS' };
  }
}
