import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupplierHotel, SupplierId } from '../../src/domain/types';
import { loadConfig } from '../../src/infra/config';
import { supplierAHotels } from '../../src/mocks/supplierA.data';
import { supplierBHotels } from '../../src/mocks/supplierB.data';
import type { HotelActivities } from '../../src/temporal/activities';
import { runHotelOffersWorkflow } from '../../src/temporal/client';
import { TASK_QUEUE } from '../../src/temporal/shared';

/**
 * Uses the real Temporal dev server (createLocal): the Java time-skipping test
 * server does not implement workflowIdConflictPolicy.
 */
describe('request coalescing (real Temporal dev server)', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createLocal();
  });
  afterAll(async () => {
    await env?.teardown();
  });

  it('20 concurrent requests for one city share ONE workflow execution', async () => {
    const calls: Record<SupplierId, number> = { A: 0, B: 0 };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const activities: HotelActivities = {
      async fetchSupplierHotels(supplier, city) {
        calls[supplier]++;
        await gate; // keep the run open until every request has attached
        const list = supplier === 'A' ? supplierAHotels : supplierBHotels;
        return list.filter((h: SupplierHotel) => h.city === city || city.startsWith('coalesce'));
      },
      async persistOffers() {
        return { ttlSeconds: 300 };
      },
    };

    const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowBundle: await bundleWorkflowCode({
        workflowsPath: path.resolve(__dirname, '../../src/temporal/workflows/index.ts'),
        logger: silent,
      }),
      activities,
    });
    const city = `coalesce-${randomUUID().slice(0, 8)}`;
    const cfg = loadConfig({ NODE_ENV: 'test' });
    let burstCalls: Record<SupplierId, number> = { A: 0, B: 0 };

    const { runs, next } = await worker.runUntil(async () => {
      const pending = Array.from({ length: 20 }, (_, i) =>
        runHotelOffersWorkflow(env.client, { city, requestId: `req-${i}` }, cfg),
      );
      await new Promise((r) => setTimeout(r, 1_000));
      release();
      const all = await Promise.all(pending);
      burstCalls = { ...calls };
      // Once the run has closed, ALLOW_DUPLICATE lets the next request start a fresh run.
      const after = await runHotelOffersWorkflow(env.client, { city, requestId: 'req-after' }, cfg);
      return { runs: all, next: after };
    });

    expect(new Set(runs.map((r) => r.workflowId))).toEqual(new Set([`hotel-offers-${city}`]));
    expect(new Set(runs.map((r) => r.runId)).size).toBe(1);
    expect(burstCalls).toEqual({ A: 1, B: 1 }); // suppliers hit once, not 20 times
    expect(runs[0]?.result.resultStatus).toBe('complete');

    expect(next.runId).not.toBe(runs[0]?.runId);
  });
});
