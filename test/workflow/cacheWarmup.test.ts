import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupplierHotel, SupplierId } from '../../src/domain/types';
import { loadConfig } from '../../src/infra/config';
import { supplierAHotels } from '../../src/mocks/supplierA.data';
import { supplierBHotels } from '../../src/mocks/supplierB.data';
import type { HotelActivities } from '../../src/temporal/activities';
import { TASK_QUEUE } from '../../src/temporal/shared';
import type { WarmupResult } from '../../src/temporal/shared';
import {
  deleteWarmupSchedule,
  ensureWarmupSchedule,
  runWarmupNow,
  warmupStatus,
} from '../../src/temporal/warmupClient';
import type { cacheWarmupWorkflow, hotelOffersWorkflow } from '../../src/temporal/workflows';

const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const workflowsPath = path.resolve(__dirname, '../../src/temporal/workflows/index.ts');
const forCity = (list: SupplierHotel[], city: string): SupplierHotel[] =>
  list.filter((h) => h.city === city);

function installRuntime(): void {
  try {
    Runtime.install({
      logger: silent,
      telemetryOptions: { logging: { filter: { core: 'ERROR', other: 'ERROR' } } },
    });
  } catch {
    // already installed by another test file in this process
  }
}

function activities(opts: { gate?: Promise<void>; failCity?: string } = {}): HotelActivities {
  return {
    async fetchSupplierHotels(supplier: SupplierId, city: string) {
      if (opts.gate && city === 'delhi') await opts.gate;
      if (city === opts.failCity) throw new Error('boom');
      return forCity(supplier === 'A' ? supplierAHotels : supplierBHotels, city);
    },
    async persistOffers() {
      return { ttlSeconds: 300 };
    },
  };
}

describe('cacheWarmupWorkflow (time-skipping)', () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: WorkflowBundleWithSourceMap;

  beforeAll(async () => {
    installRuntime();
    workflowBundle = await bundleWorkflowCode({ workflowsPath, logger: silent });
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });
  afterAll(async () => {
    await env?.teardown();
  });

  it('refreshes every city through child workflows with the user-request IDs', async () => {
    const taskQueue = `warmup-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: activities({ failCity: 'goa' }),
    });
    const result: WarmupResult = await worker.runUntil(
      env.client.workflow.execute<typeof cacheWarmupWorkflow>('cacheWarmupWorkflow', {
        taskQueue,
        workflowId: `warmup-${randomUUID()}`,
        args: [{ cities: ['mumbai', 'bangalore', 'goa'] }],
      }),
    );
    expect(result.cities).toEqual([
      expect.objectContaining({
        city: 'mumbai',
        status: 'refreshed',
        resultStatus: 'complete',
        offers: 6, // 5 + 5 records; 4 overlap, the malformed empty-name record is skipped
      }),
      expect.objectContaining({ city: 'bangalore', status: 'refreshed', resultStatus: 'complete' }),
      expect.objectContaining({ city: 'goa', status: 'failed' }),
    ]);
    // the child for mumbai ran under the shared request ID
    const child = await env.client.workflow.getHandle('hotel-offers-mumbai').describe();
    expect(child.status.name).toBe('COMPLETED');
  });

  it('reports a city as coalesced when a user run is already in flight for it', async () => {
    const taskQueue = `warmup-${randomUUID()}`;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: activities({ gate }),
    });
    const result = await worker.runUntil(async () => {
      const user = await env.client.workflow.start<typeof hotelOffersWorkflow>(
        'hotelOffersWorkflow',
        {
          taskQueue,
          workflowId: 'hotel-offers-delhi',
          args: [{ city: 'delhi', requestId: 'user-1' }],
        },
      );
      const warm = await env.client.workflow.execute<typeof cacheWarmupWorkflow>(
        'cacheWarmupWorkflow',
        {
          taskQueue,
          workflowId: `warmup-${randomUUID()}`,
          args: [{ cities: ['delhi', 'mumbai'] }],
        },
      );
      release();
      await user.result();
      return warm;
    });
    expect(result.cities.map((c) => [c.city, c.status])).toEqual([
      ['delhi', 'coalesced'],
      ['mumbai', 'refreshed'],
    ]);
  });
});

/** Schedules are not supported by the time-skipping server; use the real dev server. */
describe('cache-warmup Schedule (real Temporal dev server)', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    installRuntime();
    env = await TestWorkflowEnvironment.createLocal();
  });
  afterAll(async () => {
    await env?.teardown();
  });

  it('is created idempotently, updated in place, and run-now returns per-city results', async () => {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowBundle: await bundleWorkflowCode({ workflowsPath, logger: silent }),
      activities: activities(),
    });
    await worker.runUntil(async () => {
      const cfg = loadConfig({
        NODE_ENV: 'test',
        WARMUP_CITIES: 'delhi,mumbai',
        WARMUP_INTERVAL: '2m',
      });
      await ensureWarmupSchedule(env.client, cfg);
      // second call must update, not fail
      const updated = loadConfig({
        NODE_ENV: 'test',
        WARMUP_CITIES: 'delhi,mumbai,bangalore',
        WARMUP_INTERVAL: '5m',
      });
      await ensureWarmupSchedule(env.client, updated);

      const desc = await env.client.schedule.getHandle('cache-warmup').describe();
      expect(desc.policies.overlap).toBe('SKIP');
      expect(desc.spec.intervals?.[0]?.every).toBe(5 * 60 * 1000);

      const now = await runWarmupNow(env.client);
      expect(now.triggered).toBe(true);
      expect(now.run?.status).toBe('COMPLETED');
      expect(now.run?.results?.map((r) => r.city)).toEqual(['delhi', 'mumbai', 'bangalore']);
      expect(now.run?.results?.every((r) => r.status === 'refreshed')).toBe(true);

      const status = await warmupStatus(env.client, updated);
      expect(status).toMatchObject({ scheduleId: 'cache-warmup', paused: false, totalRuns: 1 });
      expect(status.nextRunAt).toMatch(/^\d{4}-/);
      expect(status.lastRun?.results).toHaveLength(3);

      await deleteWarmupSchedule(env.client);
      await deleteWarmupSchedule(env.client); // idempotent
    });
  });
});
