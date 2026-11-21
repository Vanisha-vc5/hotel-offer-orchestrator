import { Router } from 'express';
import type { RequestHandler } from 'express';
import { NotFoundError } from '../../domain/errors';
import type { HotelRepository } from '../../infra/hotelRepository';
import type { ChaosStore } from '../../mocks/chaos';
import { ChaosUpdateSchema, SupplierParamSchema } from '../../mocks/chaos';
import type { SupplierMetrics } from '../../mocks/supplierMetrics';
import { requireOperator } from '../middleware/operatorAuth';
import { CityParamSchema } from '../validation';

export interface AdminDeps {
  chaos: ChaosStore;
  repository: HotelRepository;
  chaosEnabled: boolean;
  adminToken?: string;
  /** Fail closed: /admin rejects everyone when no ADMIN_TOKEN is configured (production). */
  production?: boolean;
  /** FEATURE_BENCHMARK: supplier call counters. */
  metrics?: SupplierMetrics;
  /**
   * Extra work for `DELETE /admin/chaos` (e.g. reset circuits, clear warm-up
   * caches) so test suites that toggle chaos stay repeatable.
   */
  onChaosReset?: Array<() => Promise<void>>;
  /** Feature modules mount their own admin routes here. */
  extensions?: Array<(router: Router) => void>;
}

export function adminRouter(deps: AdminDeps): Router {
  const { chaos, repository } = deps;
  const router = Router();
  router.use(requireOperator(deps.adminToken, deps.production ?? false));

  const notFound = (req: Parameters<RequestHandler>[0]): NotFoundError =>
    new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`);
  const chaosOnly: RequestHandler = (req, _res, next) =>
    deps.chaosEnabled ? next() : next(notFound(req));

  router.get('/chaos', chaosOnly, async (_req, res) => {
    res.json(await chaos.getAll());
  });

  router.post('/chaos/suppliers/:supplier', chaosOnly, async (req, res) => {
    const supplier = SupplierParamSchema.parse(req.params.supplier);
    const update = ChaosUpdateSchema.parse(req.body ?? {});
    const state = await chaos.set(supplier, update);
    req.log.warn({ supplier, ...state }, 'chaos mode changed');
    res.json({ supplier, ...state });
  });

  router.delete('/chaos', chaosOnly, async (req, res) => {
    await chaos.reset();
    await Promise.all((deps.onChaosReset ?? []).map((fn) => fn()));
    req.log.warn('chaos reset');
    res.json(await chaos.getAll());
  });

  router.delete('/cache/:city', async (req, res) => {
    const { city } = CityParamSchema.parse(req.params);
    const deletedKeys = await repository.deleteCity(city);
    req.log.info({ city, deletedKeys }, 'cache cleared');
    res.json({ city, deletedKeys });
  });

  if (deps.metrics) {
    const metrics = deps.metrics;
    router.get('/metrics/suppliers', async (_req, res) => {
      res.json(await metrics.get());
    });
    router.delete('/metrics/suppliers', async (_req, res) => {
      res.json(await metrics.reset());
    });
  }

  for (const extend of deps.extensions ?? []) extend(router);
  return router;
}
