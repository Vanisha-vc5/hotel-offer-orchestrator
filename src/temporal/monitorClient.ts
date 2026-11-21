import { setTimeout as sleep } from 'node:timers/promises';
import type { Client } from '@temporalio/client';
import { msToNumber } from '@temporalio/common/lib/time';
import type { SupplierId } from '../domain/types';
import type { Config } from '../infra/config';
import { logger } from '../infra/logger';
import {
  TASK_QUEUE,
  getStatsQuery,
  monitorWorkflowId,
  probeNowSignal,
  resetCircuitSignal,
} from './shared';
import type { MonitorInput, MonitorStats } from './shared';
import type { supplierMonitorWorkflow } from './workflows';

const SUPPLIERS: readonly SupplierId[] = ['A', 'B'];

export function monitorInput(cfg: Config, supplier: SupplierId): MonitorInput {
  return {
    supplier,
    intervalMs: msToNumber(cfg.MONITOR_INTERVAL),
    failureThreshold: cfg.CIRCUIT_FAILURE_THRESHOLD,
    cooldownMs: msToNumber(cfg.CIRCUIT_COOLDOWN),
    continueAsNewEvery: cfg.MONITOR_CONTINUE_AS_NEW_EVERY,
  };
}

/** Idempotently starts both monitors (USE_EXISTING: a running monitor is left alone). */
export async function ensureMonitors(client: Client, cfg: Config): Promise<void> {
  for (const supplier of SUPPLIERS) {
    const handle = await client.workflow.start<typeof supplierMonitorWorkflow>(
      'supplierMonitorWorkflow',
      {
        taskQueue: TASK_QUEUE,
        workflowId: monitorWorkflowId(supplier),
        args: [monitorInput(cfg, supplier)],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      },
    );
    logger.info({ supplier, runId: handle.firstExecutionRunId }, 'supplier monitor running');
  }
}

/** FEATURE_MONITOR=false: stop monitors left over from a previous run. */
export async function stopMonitors(client: Client): Promise<void> {
  for (const supplier of SUPPLIERS) {
    try {
      await client.workflow
        .getHandle(monitorWorkflowId(supplier))
        .terminate('FEATURE_MONITOR=false');
      logger.info({ supplier }, 'supplier monitor terminated (feature disabled)');
    } catch {
      // not running
    }
  }
}

export async function getMonitorStats(client: Client): Promise<Record<SupplierId, MonitorStats>> {
  const [A, B] = await Promise.all(
    SUPPLIERS.map((s) => client.workflow.getHandle(monitorWorkflowId(s)).query(getStatsQuery)),
  );
  return { A: A as MonitorStats, B: B as MonitorStats };
}

/**
 * Asks both monitors to probe immediately and waits (bounded) until each has
 * recorded the new probe, so callers can read the resulting circuit state.
 */
export async function probeNow(
  client: Client,
  timeoutMs = 5_000,
): Promise<Record<SupplierId, MonitorStats>> {
  const before = await getMonitorStats(client);
  await Promise.all(
    SUPPLIERS.map((s) => client.workflow.getHandle(monitorWorkflowId(s)).signal(probeNowSignal)),
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stats = await getMonitorStats(client);
    // Wait for a probe that started after the signal AND whose result is already in Redis,
    // so callers reading /admin/circuits right after see it.
    const done = SUPPLIERS.every(
      (s) => (stats[s].onDemandProbes ?? 0) > (before[s].onDemandProbes ?? 0),
    );
    if (done || Date.now() > deadline) return stats;
    await sleep(100);
  }
}

/** Signals both monitors to reset their circuits (best effort). */
export async function resetMonitors(client: Client): Promise<void> {
  await Promise.all(
    SUPPLIERS.map((s) =>
      client.workflow
        .getHandle(monitorWorkflowId(s))
        .signal(resetCircuitSignal)
        .catch((err: unknown) =>
          logger.warn({ supplier: s, err: (err as Error).message }, 'monitor reset signal failed'),
        ),
    ),
  );
}
