import type { Config } from '../../infra/config';
import type { HotelRepository } from '../../infra/hotelRepository';
import type { MonitorStore } from '../../infra/monitorStore';
import type { ToolCaller } from '../../infra/llm';
import { createDuplicateActivities } from './duplicate.activities';
import type { DuplicateActivities } from './duplicate.activities';
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
  /** Duplicate detection: optional LLM judge for duplicate review. */
  toolCaller?: ToolCaller;
}

/** Everything the workflow can call. Workflow code imports this type only. */
export type HotelActivities = SupplierActivities & CacheActivities;
export type AllActivities = HotelActivities & MonitorActivities & DuplicateActivities;

/** Activities are built from injected dependencies, which keeps them testable. */
export function createActivities({
  repository,
  cfg,
  monitorStore,
  toolCaller,
}: ActivityDeps): HotelActivities | AllActivities {
  const base: HotelActivities = {
    ...createSupplierActivities(cfg, cfg.FEATURE_MONITOR ? monitorStore : undefined),
    ...createCacheActivities(repository, cfg),
  };
  const withDuplicates = { ...base, ...createDuplicateActivities(repository, toolCaller) };
  return monitorStore
    ? { ...withDuplicates, ...createMonitorActivities(monitorStore, cfg) }
    : withDuplicates;
}
