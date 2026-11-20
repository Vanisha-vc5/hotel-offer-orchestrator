import { Router } from 'express';
import { z } from 'zod';
import type { HotelOffer } from '../../domain/types';
import { elapsedMs } from '../middleware/requestId';
import type { AskService } from '../services/askService';

const AskBodySchema = z
  .object({
    query: z
      .string({ error: 'query is required' })
      .trim()
      .min(1, 'query is required')
      .max(300, 'query must be at most 300 characters'),
  })
  .strict();

const toPublicOffer = (o: HotelOffer): HotelOffer => ({
  name: o.name,
  price: o.price,
  supplier: o.supplier,
  commissionPct: o.commissionPct,
});

/**
 * Enhancement 4 (FEATURE_ASK): POST /api/hotels/ask — natural-language search.
 * A new endpoint, so it may use an envelope; `results` keeps the 4-key offer shape.
 */
export function askRouter(service: AskService): Router {
  const router = Router();
  router.post('/hotels/ask', async (req, res) => {
    const { query } = AskBodySchema.parse(req.body ?? {});
    const result = await service.ask(query, req.requestId);
    req.log.info(
      {
        parser: result.parser,
        parserCache: result.cached ? 'HIT' : 'MISS',
        interpretedAs: result.interpretedAs,
        results: result.offers.offers.length,
      },
      'natural-language search',
    );
    res.setHeader('X-Parser', result.parser);
    res.setHeader('X-Parser-Cache', result.cached ? 'HIT' : 'MISS');
    res.setHeader('X-Workflow-Id', result.offers.workflowId);
    res.setHeader('X-Cache', result.offers.cache);
    res.setHeader('X-Result-Status', result.offers.resultStatus);
    res.setHeader('X-Response-Time', elapsedMs(req));
    res.json({
      query: result.query,
      interpretedAs: result.interpretedAs,
      parser: result.parser,
      results: result.offers.offers.map(toPublicOffer),
    });
  });
  return router;
}
