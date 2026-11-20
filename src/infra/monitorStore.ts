import type { Redis } from 'ioredis';
import { CLOSED } from '../domain/circuit';
import type { CircuitSnapshot, CircuitState } from '../domain/circuit';
import type { SupplierId } from '../domain/types';

export interface ProbeSample {
  /** Epoch ms (workflow time). */
  at: number;
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

export interface MonitorSummary {
  uptimePctLastHour: number | null;
  lastCheckedAt: string | null;
  consecutiveFailures: number;
  circuit: CircuitState;
}

const HOUR_MS = 60 * 60 * 1000;
const SUPPLIERS: readonly SupplierId[] = ['A', 'B'];
const circuitKey = (s: SupplierId): string => `circuit:${s}`;
const samplesKey = (s: SupplierId): string => `monitor:${s}:samples`;

/**
 * Redis view of the supplier monitors: circuit state per supplier (hash) and a
 * one-hour probe history (sorted set, score = timestamp). The monitor workflow
 * is the writer; the API and the fetch activity are readers.
 */
export class MonitorStore {
  constructor(private readonly redis: Redis) {}

  async saveProbe(
    supplier: SupplierId,
    sample: ProbeSample,
    circuit: CircuitSnapshot,
  ): Promise<void> {
    await this.redis
      .multi()
      .zadd(samplesKey(supplier), sample.at, JSON.stringify(sample))
      .zremrangebyscore(samplesKey(supplier), '-inf', `(${sample.at - HOUR_MS}`)
      .hset(circuitKey(supplier), {
        state: circuit.state,
        consecutiveFailures: String(circuit.consecutiveFailures),
        openUntil: circuit.openUntil === null ? '' : String(circuit.openUntil),
        lastCheckedAt: circuit.lastCheckedAt === null ? '' : String(circuit.lastCheckedAt),
      })
      .exec();
  }

  async setCircuit(supplier: SupplierId, circuit: CircuitSnapshot): Promise<void> {
    await this.redis.hset(circuitKey(supplier), {
      state: circuit.state,
      consecutiveFailures: String(circuit.consecutiveFailures),
      openUntil: circuit.openUntil === null ? '' : String(circuit.openUntil),
      lastCheckedAt: circuit.lastCheckedAt === null ? '' : String(circuit.lastCheckedAt),
    });
  }

  async getCircuit(supplier: SupplierId): Promise<CircuitSnapshot> {
    const raw = await this.redis.hgetall(circuitKey(supplier));
    if (!raw.state) return CLOSED;
    const state: CircuitState =
      raw.state === 'open' || raw.state === 'half_open' ? raw.state : 'closed';
    return {
      state,
      consecutiveFailures: Number(raw.consecutiveFailures ?? 0),
      openUntil: raw.openUntil ? Number(raw.openUntil) : null,
      lastCheckedAt: raw.lastCheckedAt ? Number(raw.lastCheckedAt) : null,
    };
  }

  async getAllCircuits(): Promise<Record<SupplierId, CircuitSnapshot>> {
    const [A, B] = await Promise.all(SUPPLIERS.map((s) => this.getCircuit(s)));
    return { A: A ?? CLOSED, B: B ?? CLOSED };
  }

  /** Resets both circuits (and failure counts) to closed. Probe history is kept. */
  async resetCircuits(): Promise<void> {
    await Promise.all(SUPPLIERS.map((s) => this.setCircuit(s, CLOSED)));
  }

  async summary(supplier: SupplierId, now: number = Date.now()): Promise<MonitorSummary> {
    const [circuit, samples] = await Promise.all([
      this.getCircuit(supplier),
      this.redis.zrangebyscore(samplesKey(supplier), now - HOUR_MS, '+inf'),
    ]);
    const parsed = samples.map((s) => JSON.parse(s) as ProbeSample);
    const up = parsed.filter((s) => s.ok).length;
    return {
      uptimePctLastHour: parsed.length ? Math.round((up / parsed.length) * 1000) / 10 : null,
      lastCheckedAt: circuit.lastCheckedAt ? new Date(circuit.lastCheckedAt).toISOString() : null,
      consecutiveFailures: circuit.consecutiveFailures,
      circuit: circuit.state,
    };
  }
}
