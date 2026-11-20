import type { Config } from '../../infra/config';
import type { HotelRepository } from '../../infra/hotelRepository';
import type { MonitorStore } from '../../infra/monitorStore';
import { createMonitorActivities } from './monitor.activities';
import type { MonitorActivities } from './monitor.activities';
import { createCacheActivities } from './cache.activities';
import type { CacheActivities } from './cache.activities';
import { createSupplierActivities } from './supplier.activities';
import type { SupplierActivities } from './supplier.activities';

export interface ActivityDeps {
  repository: HotelRepository;
  cfg: Config;
  /** FEATURE_MONITOR: circuit state + probe history. */
  monitorStore?: MonitorStore;
}

/** Everything the workflow can call. Workflow code imports this type only. */
export type HotelActivities = SupplierActivities & CacheActivities;
export type AllActivities = HotelActivities & MonitorActivities;

/** Activities are built from injected dependencies, which keeps them testable. */
export function createActivities({
  repository,
  cfg,
  monitorStore,
}: ActivityDeps): HotelActivities | AllActivities {
  const base: HotelActivities = {
    ...createSupplierActivities(cfg, cfg.FEATURE_MONITOR ? monitorStore : undefined),
    ...createCacheActivities(repository, cfg),
  };
  return monitorStore ? { ...base, ...createMonitorActivities(monitorStore, cfg) } : base;
}
