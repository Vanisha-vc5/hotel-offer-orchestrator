import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { NotFoundError, UnauthorizedError } from '../../domain/errors';
import type { HotelRepository } from '../../infra/hotelRepository';
import type { ChaosStore } from '../../mocks/chaos';
import { ChaosUpdateSchema, SupplierParamSchema } from '../../mocks/chaos';
import { CityParamSchema } from '../validation';

export interface AdminOptions {
  chaosEnabled: boolean;
  adminToken?: string;
}

function requireToken(token: string | undefined): RequestHandler {
  return (req, _res, next) => {
    if (!token) return next();
    const given = Buffer.from(req.header('x-admin-token') ?? '');
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return next(new UnauthorizedError());
    }
    next();
  };
}

export function adminRouter(
  chaos: ChaosStore,
  repository: HotelRepository,
  opts: AdminOptions,
): Router {
  const router = Router();
  router.use(requireToken(opts.adminToken));

  const chaosOnly: RequestHandler = (req, _res, next) =>
    opts.chaosEnabled
      ? next()
      : next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`));

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
    req.log.warn('chaos reset');
    res.json(await chaos.getAll());
  });

  router.delete('/cache/:city', async (req, res) => {
    const { city } = CityParamSchema.parse(req.params);
    const deletedKeys = await repository.deleteCity(city);
    req.log.info({ city, deletedKeys }, 'cache cleared');
    res.json({ city, deletedKeys });
  });

  return router;
}
