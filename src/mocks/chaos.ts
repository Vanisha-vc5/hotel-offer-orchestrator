import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { SupplierId } from '../domain/types';
import { logger } from '../infra/logger';

export const ChaosModeSchema = z.enum(['up', 'down', 'slow', 'flaky']);
export type ChaosMode = z.infer<typeof ChaosModeSchema>;

export const ChaosUpdateSchema = z
  .object({
    mode: ChaosModeSchema,
    latencyMs: z.number().int().min(0).max(60_000).optional(),
  })
  .strict();
export type ChaosUpdate = z.infer<typeof ChaosUpdateSchema>;

export const SupplierParamSchema = z.enum(['A', 'B']);

export interface SupplierChaos {
  mode: ChaosMode;
  latencyMs: number;
}

export const DEFAULT_SLOW_LATENCY_MS = 6_000;
/** `flaky` fails this many calls with 500, then recovers. */
export const FLAKY_FAILURES = 2;

const UP: SupplierChaos = { mode: 'up', latencyMs: 0 };
const SUPPLIERS: readonly SupplierId[] = ['A', 'B'];

const stateKey = (s: SupplierId): string => `chaos:supplier:${s}`;
const flakyKey = (s: SupplierId): string => `chaos:supplier:${s}:flaky_calls`;

/**
 * Per-supplier failure modes, stored in Redis so the API (which serves the mocks)
 * and any number of replicas share one view of the chaos state.
 */
export class ChaosStore {
  constructor(private readonly redis: Redis) {}

  async get(supplier: SupplierId): Promise<SupplierChaos> {
    const raw = await this.redis.hgetall(stateKey(supplier));
    const mode = ChaosModeSchema.safeParse(raw.mode);
    if (!mode.success) return UP;
    return { mode: mode.data, latencyMs: Number(raw.latencyMs ?? 0) };
  }

  /** Like get(), but fails open (supplier "up") when Redis is unreachable. */
  async getOrUp(supplier: SupplierId): Promise<SupplierChaos> {
    try {
      return await this.get(supplier);
    } catch (err) {
      logger.warn(
        { supplier, err: (err as Error).message },
        'chaos state unavailable; assuming up',
      );
      return UP;
    }
  }

  async getAll(): Promise<Record<SupplierId, SupplierChaos>> {
    const [A, B] = await Promise.all(SUPPLIERS.map((s) => this.get(s)));
    return { A: A ?? UP, B: B ?? UP };
  }

  async set(supplier: SupplierId, update: ChaosUpdate): Promise<SupplierChaos> {
    const state: SupplierChaos = {
      mode: update.mode,
      latencyMs: update.mode === 'slow' ? (update.latencyMs ?? DEFAULT_SLOW_LATENCY_MS) : 0,
    };
    await this.redis
      .multi()
      .del(flakyKey(supplier)) // every mode change restarts the flaky counter
      .hset(stateKey(supplier), { mode: state.mode, latencyMs: String(state.latencyMs) })
      .exec();
    return state;
  }

  async reset(): Promise<void> {
    await this.redis.del(...SUPPLIERS.flatMap((s) => [stateKey(s), flakyKey(s)]));
  }

  /** Records one call in flaky mode; returns true if this call should fail. */
  async flakyShouldFail(supplier: SupplierId): Promise<boolean> {
    const calls = await this.redis.incr(flakyKey(supplier));
    return calls <= FLAKY_FAILURES;
  }
}
