import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CircuitSnapshot } from '../../src/domain/circuit';
import type { MonitorActivities } from '../../src/temporal/activities/monitor.activities';
import { getStatsQuery, probeNowSignal, resetCircuitSignal } from '../../src/temporal/shared';
import type { MonitorInput, MonitorStats } from '../../src/temporal/shared';
import type { supplierMonitorWorkflow } from '../../src/temporal/workflows';

const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const workflowsPath = path.resolve(__dirname, '../../src/temporal/workflows/index.ts');

describe('supplierMonitorWorkflow (time-skipping)', () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: WorkflowBundleWithSourceMap;

  beforeAll(async () => {
    try {
      Runtime.install({
        logger: silent,
        telemetryOptions: { logging: { filter: { core: 'ERROR', other: 'ERROR' } } },
      });
    } catch {
      // already installed by another test file in this process
    }
    workflowBundle = await bundleWorkflowCode({ workflowsPath, logger: silent });
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });
  afterAll(async () => {
    await env?.teardown();
  });

  interface Probe {
    recorded: CircuitSnapshot[];
    saved: CircuitSnapshot[];
  }

  /** Probe outcomes come from `script` (default ok once it runs out). */
  function activities(script: boolean[], rec: Probe): MonitorActivities {
    return {
      async probeSupplier() {
        const ok = script.length ? (script.shift() as boolean) : true;
        return ok
          ? { ok, latencyMs: 3, status: 200 }
          : { ok, latencyMs: 3, status: 503, error: 'HTTP 503' };
      },
      async recordProbe(_s, _sample, circuit) {
        rec.recorded.push(circuit);
      },
      async saveCircuit(_s, circuit) {
        rec.saved.push(circuit);
      },
    };
  }

  const input = (over: Partial<MonitorInput> = {}): MonitorInput => ({
    supplier: 'B',
    intervalMs: 600_000, // long: probes in these tests are driven by probeNow signals
    failureThreshold: 3,
    cooldownMs: 30_000,
    continueAsNewEvery: 100,
    ...over,
  });

  async function waitFor(
    handle: WorkflowHandle,
    pred: (s: MonitorStats) => boolean,
  ): Promise<MonitorStats> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      // Per-query deadline: a query that lands while the run is continuing-as-new can
      // block on the test server; time it out and poll again instead of hanging.
      const stats = await env.client.connection
        .withDeadline(Date.now() + 2_000, () => handle.query(getStatsQuery))
        .catch(() => undefined);
      if (stats && pred(stats)) return stats;
      if (Date.now() > deadline) throw new Error(`timed out; last stats ${JSON.stringify(stats)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function withMonitor(
    script: boolean[],
    over: Partial<MonitorInput>,
    fn: (handle: WorkflowHandle, rec: Probe) => Promise<void>,
  ): Promise<void> {
    const taskQueue = `monitor-${randomUUID()}`;
    const rec: Probe = { recorded: [], saved: [] };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: activities(script, rec),
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start<typeof supplierMonitorWorkflow>(
        'supplierMonitorWorkflow',
        { taskQueue, workflowId: `monitor-test-${randomUUID()}`, args: [input(over)] },
      );
      try {
        await fn(handle, rec);
      } finally {
        await handle.terminate('test done').catch(() => undefined);
      }
    });
  }

  it('opens the circuit after 3 consecutive failed probes', async () => {
    await withMonitor([false, false, false], {}, async (handle, rec) => {
      await waitFor(handle, (s) => s.probeCount === 1);
      await handle.signal(probeNowSignal);
      await waitFor(handle, (s) => s.probeCount === 2);
      expect((await handle.query(getStatsQuery)).circuit.state).toBe('closed');
      await handle.signal(probeNowSignal);
      const stats = await waitFor(handle, (s) => s.probeCount === 3);

      expect(stats.circuit).toMatchObject({ state: 'open', consecutiveFailures: 3 });
      expect(stats.circuit.openUntil).toBe((stats.circuit.lastCheckedAt ?? 0) + 30_000);
      expect(stats.recent).toHaveLength(3);
      expect(rec.recorded.map((c) => c.state)).toEqual(['closed', 'closed', 'open']);
    });
  });

  it('counts a probeNow probe only once its result is recorded (probe-now waits on this)', async () => {
    await withMonitor([false, false], {}, async (handle, rec) => {
      // The first probe runs on start, not because of a signal: it is not on-demand.
      const first = await waitFor(handle, (s) => s.probeCount === 1);
      expect(first.onDemandProbes).toBe(0);
      await handle.signal(probeNowSignal);
      const after = await waitFor(handle, (s) => (s.onDemandProbes ?? 0) === 1);
      // By the time the counter moves, the circuit has already been handed to recordProbe.
      expect(rec.recorded).toHaveLength(2);
      expect(after.probeCount).toBe(2);
      expect(after.circuit.consecutiveFailures).toBe(2);
    });
  });

  it('after the cooldown, a half-open probe that succeeds closes the circuit', async () => {
    await withMonitor([false, false, false, true], {}, async (handle) => {
      await waitFor(handle, (s) => s.probeCount === 1);
      await handle.signal(probeNowSignal);
      await waitFor(handle, (s) => s.probeCount === 2);
      await handle.signal(probeNowSignal);
      await waitFor(handle, (s) => s.circuit.state === 'open');

      await env.sleep(31_000); // durable time skips past the 30s cooldown
      await handle.signal(probeNowSignal);
      const stats = await waitFor(handle, (s) => s.probeCount === 4);
      expect(stats.circuit).toMatchObject({
        state: 'closed',
        consecutiveFailures: 0,
        openUntil: null,
      });
    });
  });

  it('a reset signal closes the circuit and persists it', async () => {
    await withMonitor([false, false, false], { failureThreshold: 1 }, async (handle, rec) => {
      await waitFor(handle, (s) => s.circuit.state === 'open');
      await handle.signal(resetCircuitSignal);
      await waitFor(handle, (s) => s.circuit.state === 'closed');
      const deadline = Date.now() + 5_000;
      while (rec.saved.length === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(rec.saved.at(-1)).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
    });
  });

  it('continues-as-new every N iterations, carrying the circuit and counters', async () => {
    await withMonitor([true, true, true, true], { continueAsNewEvery: 2 }, async (handle) => {
      const firstRunId = (await handle.describe()).runId;
      await waitFor(handle, (s) => s.probeCount === 1);
      await handle.signal(probeNowSignal);
      // 2nd probe triggers continue-as-new; the new run probes immediately (3rd probe).
      const stats = await waitFor(handle, (s) => s.generation === 1 && s.probeCount === 3);
      expect(stats.iterations).toBe(1);
      expect(stats.recent).toHaveLength(3);
      expect((await handle.describe()).runId).not.toBe(firstRunId);
    });
  });
});
