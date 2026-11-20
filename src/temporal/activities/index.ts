import type { Config } from '../../infra/config';
import type { HotelRepository } from '../../infra/hotelRepository';
import { createCacheActivities } from './cache.activities';
import type { CacheActivities } from './cache.activities';
import { createSupplierActivities } from './supplier.activities';
import type { SupplierActivities } from './supplier.activities';

export interface ActivityDeps {
  repository: HotelRepository;
  cfg: Config;
}

/** Everything the workflow can call. Workflow code imports this type only. */
export type HotelActivities = SupplierActivities & CacheActivities;

/** Activities are built from injected dependencies, which keeps them testable. */
export function createActivities({ repository, cfg }: ActivityDeps): HotelActivities {
  return {
    ...createSupplierActivities(cfg),
    ...createCacheActivities(repository, cfg),
  };
}
