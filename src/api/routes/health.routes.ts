import { Router } from 'express';
import type { HealthService } from '../services/healthService';

export function healthRouter(health: HealthService): Router {
  const router = Router();

  /** Full dependency report. 200 for up/degraded, 503 for down. */
  router.get('/', async (_req, res) => {
    const report = await health.check();
    res.status(report.status === 'down' ? 503 : 200).json(report);
  });

  /** Liveness: no dependency calls (used by the container HEALTHCHECK). */
  router.get('/live', (_req, res) => {
    res.json({ status: 'up' });
  });

  /** Readiness: can this instance serve traffic (Redis + Temporal reachable)? */
  router.get('/ready', async (_req, res) => {
    const report = await health.ready();
    res.status(report.status === 'up' ? 200 : 503).json(report);
  });

  return router;
}
