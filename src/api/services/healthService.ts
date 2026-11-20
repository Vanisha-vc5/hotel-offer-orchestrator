import type { Config } from '../../infra/config';
import type { HotelRepository } from '../../infra/hotelRepository';

export type DependencyStatus = 'up' | 'down';
export type OverallStatus = 'up' | 'degraded' | 'down';

export interface DependencyHealth {
  status: DependencyStatus;
  latencyMs: number;
  error?: string;
}

export interface HealthReport {
  status: OverallStatus;
  timestamp: string;
  uptimeSec: number;
  version: string;
  dependencies: Record<'supplierA' | 'supplierB' | 'redis' | 'temporal', DependencyHealth>;
}

export interface ReadinessReport {
  status: 'up' | 'down';
  dependencies: Record<'redis' | 'temporal', DependencyHealth>;
}

/** Calls the Temporal frontend (e.g. GetSystemInfo) and resolves when it answers. */
export type TemporalProbe = (deadlineMs: number) => Promise<void>;

class TimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function probe(fn: () => Promise<void>, timeoutMs: number): Promise<DependencyHealth> {
  const start = performance.now();
  const latency = (): number => Math.round(performance.now() - start);
  try {
    await withTimeout(fn(), timeoutMs);
    return { status: 'up', latencyMs: latency() };
  } catch (err) {
    // fetch's own AbortSignal.timeout can win the race; report both the same way.
    const timedOut = err instanceof TimeoutError || (err as Error)?.name === 'TimeoutError';
    const message = timedOut
      ? `timeout after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { status: 'down', latencyMs: latency(), error: message };
  }
}

/**
 * Health model:
 *   up       → everything up
 *   degraded → exactly one supplier down (200: partial data can still be served)
 *   down     → both suppliers, Redis or Temporal down (503)
 */
export class HealthService {
  private shuttingDown = false;
  private readonly startedAt = Date.now();

  constructor(
    private readonly cfg: Config,
    private readonly repository: HotelRepository,
    private readonly temporalProbe: TemporalProbe,
  ) {}

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  private supplier(url: string): Promise<DependencyHealth> {
    const timeoutMs = this.cfg.HEALTH_CHECK_TIMEOUT_MS;
    return probe(async () => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'x-health-probe': 'true' },
      });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }, timeoutMs);
  }

  private redis(): Promise<DependencyHealth> {
    return probe(async () => {
      await this.repository.ping();
    }, this.cfg.HEALTH_CHECK_TIMEOUT_MS);
  }

  private temporal(): Promise<DependencyHealth> {
    const timeoutMs = this.cfg.HEALTH_CHECK_TIMEOUT_MS;
    return probe(() => this.temporalProbe(timeoutMs), timeoutMs);
  }

  async check(): Promise<HealthReport> {
    const [supplierA, supplierB, redis, temporal] = await Promise.all([
      this.supplier(this.cfg.SUPPLIER_A_URL),
      this.supplier(this.cfg.SUPPLIER_B_URL),
      this.redis(),
      this.temporal(),
    ]);
    const suppliersDown = [supplierA, supplierB].filter((d) => d.status === 'down').length;
    let status: OverallStatus = 'up';
    if (suppliersDown === 2 || redis.status === 'down' || temporal.status === 'down') {
      status = 'down';
    } else if (suppliersDown === 1) {
      status = 'degraded';
    }
    return {
      status,
      timestamp: new Date().toISOString(),
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      version: this.cfg.SERVICE_VERSION,
      dependencies: { supplierA, supplierB, redis, temporal },
    };
  }

  async ready(): Promise<ReadinessReport> {
    const [redis, temporal] = await Promise.all([this.redis(), this.temporal()]);
    const allUp = !this.shuttingDown && redis.status === 'up' && temporal.status === 'up';
    return { status: allUp ? 'up' : 'down', dependencies: { redis, temporal } };
  }
}
