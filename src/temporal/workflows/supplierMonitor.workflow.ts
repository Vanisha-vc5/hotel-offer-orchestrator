/**
 * Long-running supplier monitor (one per supplier, IDs supplier-monitor-A/B).
 *
 * Loop: probe → update the circuit-breaker state machine → persist sample and
 * circuit to Redis → wait MONITOR_INTERVAL (a durable timer) or until a
 * `probeNow` signal. Every N iterations it continues-as-new, carrying its
 * state, so event history stays bounded no matter how long it runs.
 */
import {
  condition,
  continueAsNew,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import { CLOSED, applyProbe } from '../../domain/circuit';
import type { MonitorActivities } from '../activities/monitor.activities';
import { getStatsQuery, probeNowSignal, resetCircuitSignal } from '../shared';
import type { MonitorInput, MonitorSample, MonitorStats } from '../shared';

const RECENT_SAMPLES = 20;

const { probeSupplier } = proxyActivities<MonitorActivities>({
  // The probe has its own 2s HTTP timeout and never throws for a failed probe.
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 1 },
});
const { recordProbe, saveCircuit } = proxyActivities<MonitorActivities>({
  startToCloseTimeout: '5s',
  retry: { initialInterval: '500ms', maximumAttempts: 3 },
});

/** Workflow time: deterministic inside the sandbox (replays return recorded values). */
function now(): number {
  // eslint-disable-next-line no-restricted-properties -- Date.now() is replay-safe in Temporal workflows
  return Date.now();
}

export async function supplierMonitorWorkflow(input: MonitorInput): Promise<void> {
  const { supplier } = input;
  const policy = { failureThreshold: input.failureThreshold, cooldownMs: input.cooldownMs };
  let circuit = input.carry?.circuit ?? CLOSED;
  const recent: MonitorSample[] = [...(input.carry?.recent ?? [])];
  let probeCount = input.carry?.probeCount ?? 0;
  const generation = input.carry?.generation ?? 0;
  let iterations = 0;
  let pendingProbes = 0;
  let resetPending = false;
  let onDemandProbes = input.carry?.onDemandProbes ?? 0;
  let onDemand = false; // the probe about to run was triggered by probeNow

  setHandler(probeNowSignal, () => {
    pendingProbes++;
  });
  setHandler(resetCircuitSignal, () => {
    // Reset synchronously so an in-flight probe applies to the reset state.
    circuit = CLOSED;
    resetPending = true;
  });
  setHandler(getStatsQuery, (): MonitorStats => ({
    supplier,
    circuit,
    recent,
    probeCount,
    iterations,
    generation,
    onDemandProbes,
  }));

  for (;;) {
    const result = await probeSupplier(supplier);
    const sample: MonitorSample = { at: now(), ...result };
    const before = circuit.state;
    circuit = applyProbe(circuit, result.ok, sample.at, policy);
    recent.push(sample);
    if (recent.length > RECENT_SAMPLES) recent.splice(0, recent.length - RECENT_SAMPLES);
    probeCount++;
    iterations++;
    await recordProbe(supplier, sample, circuit);
    if (onDemand) onDemandProbes++; // only once the circuit is in Redis
    onDemand = false;
    if (before !== circuit.state) {
      log.warn('circuit state changed', { supplier, from: before, to: circuit.state, ...result });
    }

    if (iterations >= input.continueAsNewEvery || workflowInfo().continueAsNewSuggested) {
      log.info('monitor continuing as new', { supplier, probeCount, generation: generation + 1 });
      await continueAsNew<typeof supplierMonitorWorkflow>({
        ...input,
        carry: { circuit, recent, probeCount, generation: generation + 1, onDemandProbes },
      });
    }

    // Durable timer: wait for the interval, an on-demand probe, or a reset.
    for (;;) {
      await condition(() => pendingProbes > 0 || resetPending, input.intervalMs);
      if (resetPending) {
        resetPending = false;
        await saveCircuit(supplier, circuit);
        log.info('circuit reset', { supplier });
        continue; // keep waiting; a reset is not a probe
      }
      if (pendingProbes > 0) {
        pendingProbes--;
        onDemand = true;
      }
      break;
    }
  }
}
