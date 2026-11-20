import { setTimeout as sleep } from 'node:timers/promises';
import { ScheduleAlreadyRunning, ScheduleNotFoundError } from '@temporalio/client';
import type { Client, ScheduleOptionsStartWorkflowAction } from '@temporalio/client';
import type { Config } from '../infra/config';
import { logger } from '../infra/logger';
import { tuningFromConfig } from './client';
import { TASK_QUEUE, WARMUP_SCHEDULE_ID, WARMUP_WORKFLOW_ID } from './shared';
import type { WarmupInput, WarmupResult } from './shared';
import type { cacheWarmupWorkflow } from './workflows';

type WarmupAction = ScheduleOptionsStartWorkflowAction<typeof cacheWarmupWorkflow>;

function warmupAction(cfg: Config): WarmupAction {
  const input: WarmupInput = {
    cities: cfg.WARMUP_CITIES,
    tuning: tuningFromConfig(cfg),
    workflowExecutionTimeout: cfg.WORKFLOW_EXECUTION_TIMEOUT,
  };
  return {
    type: 'startWorkflow',
    workflowType: 'cacheWarmupWorkflow',
    workflowId: WARMUP_WORKFLOW_ID,
    taskQueue: TASK_QUEUE,
    args: [input],
    workflowExecutionTimeout: '2m',
  };
}

/**
 * Creates the `cache-warmup` Schedule, or updates it in place if it already
 * exists (so changed WARMUP_* env values take effect on the next worker boot).
 * Overlap policy SKIP: a slow tick never stacks up behind another.
 */
export async function ensureWarmupSchedule(client: Client, cfg: Config): Promise<void> {
  const spec = { intervals: [{ every: cfg.WARMUP_INTERVAL }] };
  const action = warmupAction(cfg);
  try {
    await client.schedule.create({
      scheduleId: WARMUP_SCHEDULE_ID,
      spec,
      action,
      policies: { overlap: 'SKIP', catchupWindow: '1m' },
    });
    logger.info(
      { every: cfg.WARMUP_INTERVAL, cities: cfg.WARMUP_CITIES },
      'warm-up schedule created',
    );
  } catch (err) {
    if (!(err instanceof ScheduleAlreadyRunning)) throw err;
    await client.schedule
      .getHandle(WARMUP_SCHEDULE_ID)
      .update<typeof cacheWarmupWorkflow>((prev) => ({
        ...prev,
        spec,
        action,
        policies: { ...prev.policies, overlap: 'SKIP' },
      }));
    logger.info(
      { every: cfg.WARMUP_INTERVAL, cities: cfg.WARMUP_CITIES },
      'warm-up schedule updated',
    );
  }
}

/** FEATURE_WARMUP=false: remove the schedule so the system behaves exactly like v1. */
export async function deleteWarmupSchedule(client: Client): Promise<void> {
  try {
    await client.schedule.getHandle(WARMUP_SCHEDULE_ID).delete();
    logger.info('warm-up schedule deleted (feature disabled)');
  } catch (err) {
    if (!(err instanceof ScheduleNotFoundError)) throw err;
  }
}

export interface WarmupRun {
  scheduledAt: string;
  startedAt: string;
  workflowId: string;
  runId: string;
  status: string;
  results: WarmupResult['cities'] | null;
}

export interface WarmupStatus {
  scheduleId: string;
  every: string;
  cities: string[];
  paused: boolean;
  totalRuns: number;
  nextRunAt: string | null;
  lastRun: WarmupRun | null;
}

async function lastRun(client: Client, waitMs = 0): Promise<WarmupRun | null> {
  const desc = await client.schedule.getHandle(WARMUP_SCHEDULE_ID).describe();
  const last = desc.info.recentActions.at(-1);
  if (!last) return null;
  const { workflowId, firstExecutionRunId } = last.action.workflow;
  const handle = client.workflow.getHandle<typeof cacheWarmupWorkflow>(
    workflowId,
    firstExecutionRunId,
  );
  let status = (await handle.describe()).status.name;
  if (status === 'RUNNING' && waitMs > 0) {
    await Promise.race([handle.result().catch(() => undefined), sleep(waitMs)]);
    status = (await handle.describe()).status.name;
  }
  return {
    scheduledAt: last.scheduledAt.toISOString(),
    startedAt: last.takenAt.toISOString(),
    workflowId,
    runId: firstExecutionRunId,
    status,
    results: status === 'COMPLETED' ? (await handle.result()).cities : null,
  };
}

export async function warmupStatus(client: Client, cfg: Config): Promise<WarmupStatus> {
  const desc = await client.schedule.getHandle(WARMUP_SCHEDULE_ID).describe();
  return {
    scheduleId: WARMUP_SCHEDULE_ID,
    every: String(cfg.WARMUP_INTERVAL),
    cities: cfg.WARMUP_CITIES,
    paused: desc.state.paused,
    totalRuns: desc.info.numActionsTaken,
    nextRunAt: desc.info.nextActionTimes[0]?.toISOString() ?? null,
    lastRun: await lastRun(client),
  };
}

/**
 * Triggers the schedule now and waits (bounded) for that run to finish, so the
 * caller gets per-city results. If a run is already in progress, SKIP means no
 * new run is taken; the caller then sees `triggered: false`.
 */
export async function runWarmupNow(
  client: Client,
  timeoutMs = 25_000,
): Promise<{ triggered: boolean; run: WarmupRun | null }> {
  const handle = client.schedule.getHandle(WARMUP_SCHEDULE_ID);
  const before = (await handle.describe()).info.numActionsTaken;
  await handle.trigger();
  const deadline = Date.now() + 5_000;
  let taken = false;
  while (!taken && Date.now() < deadline) {
    taken = (await handle.describe()).info.numActionsTaken > before;
    if (!taken) await sleep(100);
  }
  return { triggered: taken, run: await lastRun(client, taken ? timeoutMs : 0) };
}
