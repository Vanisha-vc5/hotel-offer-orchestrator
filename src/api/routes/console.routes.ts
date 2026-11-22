import path from 'node:path';
import express, { Router } from 'express';
import type { Config } from '../../infra/config';

/** Static assets live next to the compiled code: src/console (dev) or dist/console (prod). */
export const CONSOLE_DIR = path.resolve(__dirname, '..', '..', 'console');

/**
 * Ops console (FEATURE_CONSOLE): the ops console at /console. Plain static
 * files (no build step, no CDN), so helmet's strict default CSP
 * (`script-src 'self'`, no inline script) applies unchanged.
 */
export function consoleRouter(cfg: Config): Router {
  const router = Router();
  router.get('/config.json', (_req, res) => {
    res.json({
      temporalUiUrl: cfg.TEMPORAL_UI_URL.replace(/\/$/, ''),
      namespace: cfg.TEMPORAL_NAMESPACE,
      features: {
        ask: cfg.FEATURE_ASK,
        chaos: cfg.ENABLE_CHAOS,
        monitor: cfg.FEATURE_MONITOR,
        duplicates: cfg.FEATURE_DUPLICATES,
      },
    });
  });
  router.use(express.static(CONSOLE_DIR, { index: 'index.html', maxAge: '5m' }));
  return router;
}
