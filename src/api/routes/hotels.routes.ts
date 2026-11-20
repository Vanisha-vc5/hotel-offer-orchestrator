import { Router } from 'express';
import type { Response } from 'express';
import { buildInsights } from '../../domain/insights';
import type { HotelOffer } from '../../domain/types';
import { isTrustedOperator } from '../middleware/operatorAuth';
import { elapsedMs } from '../middleware/requestId';
import type { DuplicateService } from '../services/duplicateService';
import type { HotelService, OffersResult } from '../services/hotelService';
import { HotelsQuerySchema, InsightsQuerySchema } from '../validation';

/**
 * The public contract: exactly these four keys, in this order, nothing else.
 * Projecting explicitly guarantees no internal field can ever leak into the body.
 */
function toPublicOffer(o: HotelOffer): HotelOffer {
  return { name: o.name, price: o.price, supplier: o.supplier, commissionPct: o.commissionPct };
}

function setMetaHeaders(res: Response, r: OffersResult): void {
  res.setHeader('X-Workflow-Id', r.workflowId);
  res.setHeader('X-Workflow-Run-Id', r.runId);
  res.setHeader('X-Suppliers-Status', r.suppliersStatus);
  res.setHeader('X-Result-Status', r.resultStatus);
  res.setHeader('X-Cache', r.cache);
}

export interface HotelsRouterOptions {
  /** FEATURE_BENCHMARK: honour `X-Coalescing: off` from trusted operators. */
  allowCoalescingOverride: boolean;
  adminToken?: string;
  /** FEATURE_MONITOR: value for the X-Circuit-State header, e.g. `A=closed;B=open`. */
  circuitHeader?: () => Promise<string>;
  /** FEATURE_DUPLICATES: adds `possibleDuplicates` to insights. */
  duplicates?: DuplicateService;
}

export function hotelsRouter(service: HotelService, opts: HotelsRouterOptions): Router {
  const router = Router();
  const coalesceFor = (req: Parameters<typeof isTrustedOperator>[0]): boolean =>
    !(
      opts.allowCoalescingOverride &&
      req.header('x-coalescing') === 'off' &&
      isTrustedOperator(req, opts.adminToken)
    );

  /**
   * GET /api/hotels?city=delhi[&minPrice=&maxPrice=][&refresh=true]
   * 200 → bare JSON array; all metadata lives in response headers.
   */
  router.get('/hotels', async (req, res) => {
    const q = HotelsQuerySchema.parse(req.query);
    const filtered = q.minPrice !== undefined || q.maxPrice !== undefined;

    const result = filtered
      ? await service.getFilteredOffers(
          q.city,
          { minPrice: q.minPrice, maxPrice: q.maxPrice },
          { refresh: q.refresh, requestId: req.requestId, coalesce: coalesceFor(req) },
        )
      : await service.getOffers(q.city, req.requestId, coalesceFor(req));

    req.log.info(
      {
        city: q.city,
        minPrice: q.minPrice,
        maxPrice: q.maxPrice,
        cache: result.cache,
        winners: result.offers.length,
        workflowId: result.workflowId,
        runId: result.runId,
        resultStatus: result.resultStatus,
        suppliersStatus: result.suppliersStatus,
      },
      'hotels served',
    );
    setMetaHeaders(res, result);
    if (opts.circuitHeader) {
      const circuits = await opts.circuitHeader().catch(() => undefined);
      if (circuits) res.setHeader('X-Circuit-State', circuits);
    }
    res.setHeader('X-Response-Time', elapsedMs(req));
    res.status(200).json(result.offers.map(toPublicOffer));
  });

  /** GET /api/hotels/insights?city=delhi — why each offer won (separate from the contract). */
  router.get('/hotels/insights', async (req, res) => {
    const { city, refresh } = InsightsQuerySchema.parse(req.query);
    const { meta, decisions, cache } = await service.getInsights(city, {
      refresh,
      requestId: req.requestId,
    });
    const report = buildInsights(decisions);
    let possibleDuplicates: unknown;
    if (opts.duplicates) {
      try {
        possibleDuplicates = await opts.duplicates.get(city);
      } catch (err) {
        // Report-only feature: never fail insights because the review is unavailable.
        req.log.warn({ err: (err as Error).message, city }, 'duplicate review unavailable');
      }
    }

    res.setHeader('X-Cache', cache);
    res.setHeader('X-Workflow-Id', meta.workflowId);
    res.setHeader('X-Response-Time', elapsedMs(req));
    res.json({
      city,
      fetchedAt: meta.fetchedAt,
      workflowId: meta.workflowId,
      runId: meta.runId,
      resultStatus: meta.resultStatus,
      suppliersStatus: meta.suppliersStatus,
      ...report,
      ...(possibleDuplicates !== undefined ? { possibleDuplicates } : {}),
    });
  });

  return router;
}
