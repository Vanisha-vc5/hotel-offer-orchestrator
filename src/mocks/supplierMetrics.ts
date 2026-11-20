import type { Redis } from 'ioredis';
import type { SupplierId } from '../domain/types';
import { logger } from '../infra/logger';

const key = (s: SupplierId): string => `metrics:supplier:${s}:calls`;

/**
 * Counts data calls served by the mock suppliers (health/monitor probes are
 * excluded), so the benchmark can show how many supplier hits a burst caused.
 */
export class SupplierMetrics {
  constructor(private readonly redis: Redis) {}

  /** Fire-and-forget friendly: never throws (metrics must not break the mock). */
  async recordCall(supplier: SupplierId): Promise<void> {
    try {
      await this.redis.incr(key(supplier));
    } catch (err) {
      logger.warn({ supplier, err: (err as Error).message }, 'supplier metrics unavailable');
    }
  }

  async get(): Promise<Record<SupplierId, number>> {
    const [a, b] = await this.redis.mget(key('A'), key('B'));
    return { A: Number(a ?? 0), B: Number(b ?? 0) };
  }

  async reset(): Promise<Record<SupplierId, number>> {
    await this.redis.del(key('A'), key('B'));
    return { A: 0, B: 0 };
  }
}
