import { setTimeout as sleep } from 'node:timers/promises';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SupplierHotel, SupplierId } from '../../domain/types';
import type { ChaosStore } from '../../mocks/chaos';
import { supplierAHotels } from '../../mocks/supplierA.data';
import { supplierBHotels } from '../../mocks/supplierB.data';
import { SupplierQuerySchema } from '../validation';

const INVENTORY: Record<SupplierId, readonly SupplierHotel[]> = {
  A: supplierAHotels,
  B: supplierBHotels,
};

function supplierError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { code: 'SUPPLIER_ERROR', message } });
}

/**
 * Mock third-party supplier APIs. They are chaos-aware so failures, latency and
 * transient errors can be demonstrated over a real HTTP hop.
 */
export function suppliersRouter(chaos: ChaosStore): Router {
  const router = Router();

  const handler = (supplier: SupplierId) => async (req: Request, res: Response) => {
    const { city } = SupplierQuerySchema.parse(req.query);
    const state = await chaos.getOrUp(supplier);
    const log = req.log.child({ supplier, chaosMode: state.mode });

    switch (state.mode) {
      case 'down':
        log.info('chaos: responding 503');
        return supplierError(res, 503, `Supplier ${supplier} is down (chaos)`);
      case 'flaky':
        if (await chaos.flakyShouldFail(supplier)) {
          log.info('chaos: flaky failure, responding 500');
          return supplierError(res, 500, `Supplier ${supplier} transient failure (chaos)`);
        }
        break;
      case 'slow': {
        // Stop waiting if the caller gives up (activity timeout) or the server shuts down.
        const aborted = new AbortController();
        res.once('close', () => aborted.abort());
        log.info({ latencyMs: state.latencyMs }, 'chaos: delaying response');
        try {
          await sleep(state.latencyMs, undefined, { signal: aborted.signal });
        } catch {
          return; // client disconnected
        }
        break;
      }
      case 'up':
        break;
    }

    const hotels = city
      ? INVENTORY[supplier].filter((h) => h.city.toLowerCase() === city)
      : INVENTORY[supplier];
    res.json(hotels);
  };

  router.get('/supplierA/hotels', handler('A'));
  router.get('/supplierB/hotels', handler('B'));
  return router;
}
