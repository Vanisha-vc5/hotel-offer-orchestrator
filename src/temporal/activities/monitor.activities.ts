import { log } from '@temporalio/activity';
import type { CircuitSnapshot } from '../../domain/circuit';
import type { SupplierId } from '../../domain/types';
import type { Config } from '../../infra/config';
import type { MonitorStore, ProbeSample } from '../../infra/monitorStore';

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

export interface MonitorActivities {
  probeSupplier(supplier: SupplierId): Promise<ProbeResult>;
  recordProbe(supplier: SupplierId, sample: ProbeSample, circuit: CircuitSnapshot): Promise<void>;
  saveCircuit(supplier: SupplierId, circuit: CircuitSnapshot): Promise<void>;
}

export function createMonitorActivities(store: MonitorStore, cfg: Config): MonitorActivities {
  return {
    /**
     * One health probe. Never throws: a failed probe is data, not an activity
     * failure, so Temporal does not retry it and the state machine sees it.
     */
    async probeSupplier(supplier) {
      const url = supplier === 'A' ? cfg.SUPPLIER_A_URL : cfg.SUPPLIER_B_URL;
      const timeoutMs = cfg.MONITOR_PROBE_TIMEOUT_MS;
      const started = performance.now();
      const latency = (): number => Math.round(performance.now() - started);
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'x-health-probe': 'monitor' },
        });
        await res.body?.cancel();
        const result: ProbeResult = res.ok
          ? { ok: true, latencyMs: latency(), status: res.status }
          : { ok: false, latencyMs: latency(), status: res.status, error: `HTTP ${res.status}` };
        log.debug('supplier probe', { supplier, ...result });
        return result;
      } catch (err) {
        const timedOut = (err as Error)?.name === 'TimeoutError';
        const result: ProbeResult = {
          ok: false,
          latencyMs: latency(),
          error: timedOut ? `timeout after ${timeoutMs}ms` : (err as Error).message,
        };
        log.debug('supplier probe', { supplier, ...result });
        return result;
      }
    },

    async recordProbe(supplier, sample, circuit) {
      await store.saveProbe(supplier, sample, circuit);
    },

    async saveCircuit(supplier, circuit) {
      await store.setCircuit(supplier, circuit);
    },
  };
}
