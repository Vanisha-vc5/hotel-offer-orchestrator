import type { Router } from 'express';
import type { MonitorStore } from '../../infra/monitorStore';

/** Control plane for the monitor workflows (Temporal signals/queries behind an interface). */
export interface MonitorControl {
  probeNow(): Promise<unknown>;
}

/**
 * Supplier monitor admin routes (FEATURE_MONITOR):
 *   GET  /admin/circuits          current circuit state per supplier (Redis)
 *   POST /admin/monitor/probe-now probe both suppliers now and wait for the result
 */
export function monitorAdminRoutes(
  store: MonitorStore,
  control: MonitorControl,
): (router: Router) => void {
  return (router: Router): void => {
    router.get('/circuits', async (_req, res) => {
      const circuits = await store.getAllCircuits();
      res.json(
        Object.fromEntries(
          Object.entries(circuits).map(([supplier, c]) => [
            supplier,
            {
              state: c.state,
              consecutiveFailures: c.consecutiveFailures,
              openUntil: c.openUntil ? new Date(c.openUntil).toISOString() : null,
              lastCheckedAt: c.lastCheckedAt ? new Date(c.lastCheckedAt).toISOString() : null,
            },
          ]),
        ),
      );
    });

    router.post('/monitor/probe-now', async (req, res) => {
      const stats = await control.probeNow();
      req.log.info('on-demand monitor probe');
      res.json(stats);
    });
  };
}
