import type { Router } from 'express';

/** Temporal Schedule control plane behind an interface (testable without Temporal). */
export interface WarmupControl {
  status(): Promise<unknown>;
  runNow(): Promise<{ triggered: boolean; run: unknown }>;
}

/**
 * Cache warm-up admin routes (FEATURE_WARMUP):
 *   GET  /admin/warmup          schedule state, next run, last run with per-city results
 *   POST /admin/warmup/run-now  trigger the schedule now and wait (bounded) for the run
 */
export function warmupAdminRoutes(control: WarmupControl): (router: Router) => void {
  return (router: Router): void => {
    router.get('/warmup', async (_req, res) => {
      res.json(await control.status());
    });

    router.post('/warmup/run-now', async (req, res) => {
      const result = await control.runNow();
      req.log.info({ triggered: result.triggered }, 'warm-up triggered');
      // 202 when the overlap policy skipped the trigger (a warm-up was already running).
      res.status(result.triggered ? 200 : 202).json(result);
    });
  };
}
