import { Router } from 'express';

export function healthRouter(): Router {
  const router = Router();
  router.get('/live', (_req, res) => {
    res.json({ status: 'up' });
  });
  return router;
}
