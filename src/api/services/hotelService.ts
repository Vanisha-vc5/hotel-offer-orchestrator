import { RedisUnavailableError } from '../../domain/errors';
import type { Decision, HotelOffer, ResultStatus } from '../../domain/types';
import type {
  CityMeta,
  FilterResult,
  HotelRepository,
  PriceRange,
} from '../../infra/hotelRepository';
import type { WorkflowRun } from '../../temporal/client';
import { formatSuppliersStatus } from '../../temporal/shared';

export interface RunInput {
  city: string;
  requestId: string;
  /** false = start a dedicated run (benchmark comparison only). Default true. */
  coalesce?: boolean;
}

export type WorkflowRunner = (input: RunInput) => Promise<WorkflowRun>;

export type CacheStatus = 'HIT' | 'MISS';

/** Everything a hotels response needs: the body (offers) plus header metadata. */
export interface OffersResult {
  offers: HotelOffer[];
  workflowId: string;
  runId: string;
  suppliersStatus: string;
  resultStatus: ResultStatus;
  cache: CacheStatus;
  /** Only for workflow-backed responses: true when this request joined an existing run. */
  coalesced?: boolean;
  /** Duration of the Redis Lua price filter (filtered requests only). */
  filterMs?: number;
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
  async getOffers(city: string, requestId: string, coalesce = true): Promise<OffersResult> {
    const run = await this.runWorkflow({ city, requestId, coalesce });
    return {
      offers: run.result.offers,
      workflowId: run.workflowId,
      runId: run.runId,
      suppliersStatus: formatSuppliersStatus(run.result.suppliersStatus),
      resultStatus: run.result.resultStatus,
      cache: 'MISS',
      coalesced: run.coalesced,
    };
  }

  /** Runs the Lua price filter inside Redis and times it. */
  private async filter(city: string, range: PriceRange): Promise<[FilterResult, number]> {
    const started = performance.now();
    const result = await this.repository.filterByPrice(city, range);
    return [result, Math.round((performance.now() - started) * 10) / 10];
  }

  /**
   * Filtered: price filtering always happens inside Redis (Lua). A cached city
   * is a HIT; otherwise (or with refresh) the workflow runs first and persists.
   */
  async getFilteredOffers(
    city: string,
    range: PriceRange,
    opts: { refresh: boolean; requestId: string; coalesce?: boolean },
  ): Promise<OffersResult> {
    if (!opts.refresh) {
      const [cached, filterMs] = await this.filter(city, range);
      if (cached.hit) {
        return {
          offers: cached.offers,
          workflowId: cached.meta.workflowId,
          runId: cached.meta.runId,
          suppliersStatus: cached.meta.suppliersStatus,
          resultStatus: cached.meta.resultStatus,
          cache: 'HIT',
          filterMs,
        };
      }
    }

    const run = await this.runWorkflow({
      city,
      requestId: opts.requestId,
      coalesce: opts.coalesce ?? true,
    });
    const [fresh, filterMs] = await this.filter(city, range);
    if (!fresh.hit) {
      // The workflow persisted successfully, so this means the entry vanished (eviction/flush).
      throw new RedisUnavailableError('Cache entry missing right after it was written');
    }
    // The cache may legitimately hold ANOTHER run's data: a partial run never replaces a
    // still-valid complete entry. Headers must then describe the data actually served.
    const servedByThisRun = !fresh.meta.runId || fresh.meta.runId === run.runId;
    return {
      offers: fresh.offers,
      workflowId: servedByThisRun ? run.workflowId : fresh.meta.workflowId,
      runId: servedByThisRun ? run.runId : fresh.meta.runId,
      suppliersStatus: servedByThisRun
        ? formatSuppliersStatus(run.result.suppliersStatus)
        : fresh.meta.suppliersStatus,
      resultStatus: servedByThisRun ? run.result.resultStatus : fresh.meta.resultStatus,
      cache: servedByThisRun ? 'MISS' : 'HIT',
      coalesced: run.coalesced,
      filterMs,
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
