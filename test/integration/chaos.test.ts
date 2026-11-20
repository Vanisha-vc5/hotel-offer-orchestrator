import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChaosStore, DEFAULT_SLOW_LATENCY_MS } from '../../src/mocks/chaos';
import { connectTestRedis } from '../helpers/redis';

describe('ChaosStore (real Redis)', () => {
  let redis: Redis;
  let chaos: ChaosStore;

  beforeAll(async () => {
    redis = await connectTestRedis();
    chaos = new ChaosStore(redis);
  });
  beforeEach(() => chaos.reset());
  afterAll(async () => {
    await chaos.reset();
    await redis.quit();
  });

  it('defaults every supplier to up', async () => {
    expect(await chaos.getAll()).toEqual({
      A: { mode: 'up', latencyMs: 0 },
      B: { mode: 'up', latencyMs: 0 },
    });
  });

  it('uses the default latency for slow mode', async () => {
    expect(await chaos.set('B', { mode: 'slow' })).toEqual({
      mode: 'slow',
      latencyMs: DEFAULT_SLOW_LATENCY_MS,
    });
    expect(await chaos.get('B')).toEqual({ mode: 'slow', latencyMs: DEFAULT_SLOW_LATENCY_MS });
  });

  it('flaky fails exactly the first two calls, then recovers', async () => {
    await chaos.set('A', { mode: 'flaky' });
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(await chaos.flakyShouldFail('A'));
    expect(outcomes).toEqual([true, true, false, false]);

    await chaos.set('A', { mode: 'flaky' }); // re-arming resets the counter
    expect(await chaos.flakyShouldFail('A')).toBe(true);
  });
});
