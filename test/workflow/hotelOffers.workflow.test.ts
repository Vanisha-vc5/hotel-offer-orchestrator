import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ApplicationFailure, WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupplierHotel, SupplierId } from '../../src/domain/types';
import { supplierAHotels } from '../../src/mocks/supplierA.data';
import { supplierBHotels } from '../../src/mocks/supplierB.data';
import type { HotelActivities } from '../../src/temporal/activities';
import type {
  HotelOffersWorkflowResult,
  PersistPayload,
  WorkflowStatus,
} from '../../src/temporal/shared';
import type { hotelOffersWorkflow } from '../../src/temporal/workflows';

const workflowsPath = path.resolve(__dirname, '../../src/temporal/workflows/index.ts');
const delhi = (list: SupplierHotel[]): SupplierHotel[] => list.filter((h) => h.city === 'delhi');
const FIXTURES: Record<SupplierId, SupplierHotel[]> = {
  A: delhi(supplierAHotels),
  B: delhi(supplierBHotels),
};

interface Recorder {
  attempts: Record<SupplierId, number>;
  persisted: PersistPayload[];
}

type FetchImpl = (supplier: SupplierId, city: string) => Promise<SupplierHotel[]>;

function mockActivities(
  fetchImpl: FetchImpl,
  rec: Recorder,
  persistFails = false,
): HotelActivities {
  return {
    async fetchSupplierHotels(supplier, city) {
      rec.attempts[supplier]++;
      return fetchImpl(supplier, city);
    },
    async persistOffers(_city, result) {
      if (persistFails) throw new Error('redis down');
      rec.persisted.push(result);
      return { ttlSeconds: 300 };
    },
  };
}

const ok: FetchImpl = async (supplier) => FIXTURES[supplier];

describe('hotelOffersWorkflow', () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: WorkflowBundleWithSourceMap;

  beforeAll(async () => {
    const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    Runtime.install({
      logger: silent,
      telemetryOptions: { logging: { filter: { core: 'ERROR', other: 'ERROR' } } },
    });
    // Bundle once; every test worker reuses it.
    workflowBundle = await bundleWorkflowCode({ workflowsPath, logger: silent });
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });
  afterAll(async () => {
    await env?.teardown();
  });

  async function withWorker<T>(
    activities: HotelActivities,
    fn: (taskQueue: string) => Promise<T>,
  ): Promise<T> {
    const taskQueue = `test-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities,
    });
    return worker.runUntil(fn(taskQueue));
  }

  function execute(taskQueue: string, city = 'delhi'): Promise<HotelOffersWorkflowResult> {
    return env.client.workflow.execute<typeof hotelOffersWorkflow>('hotelOffersWorkflow', {
      taskQueue,
      workflowId: `wf-${randomUUID()}`,
      args: [{ city, requestId: 'req-test' }],
    });
  }

  const newRecorder = (): Recorder => ({ attempts: { A: 0, B: 0 }, persisted: [] });

  it('happy path: merges both suppliers and persists a complete result', async () => {
    const rec = newRecorder();
    const result = await withWorker(mockActivities(ok, rec), (tq) => execute(tq));

    expect(result.resultStatus).toBe('complete');
    expect(result.suppliersStatus).toEqual({ A: 'up', B: 'up' });
    expect(result.offers.map((o) => `${o.name}:${o.price}:${o.supplier}`)).toEqual([
      'Ibis:2900:Supplier B',
      'Lemon Tree:3200:Supplier A',
      'Holtin:5340:Supplier B',
      'Radison:5900:Supplier A',
      'Hyatt Regency:8400:Supplier B',
      'The Leela:9800:Supplier A',
      'Taj Palace:11900:Supplier B',
    ]);
    expect(result.decisions).toHaveLength(7);
    expect(rec.attempts).toEqual({ A: 1, B: 1 });
    expect(rec.persisted).toHaveLength(1);
    expect(rec.persisted[0]).toMatchObject({ requestId: 'req-test', resultStatus: 'complete' });
    expect(rec.persisted[0]?.workflowId).toMatch(/^wf-/);
    expect(rec.persisted[0]?.runId).toBeTruthy();
  });

  it('supplier B throws: retries, then returns a partial result with B down', async () => {
    const rec = newRecorder();
    const fetchImpl: FetchImpl = async (supplier) => {
      if (supplier === 'B') throw new Error('connection refused');
      return FIXTURES.A;
    };
    const result = await withWorker(mockActivities(fetchImpl, rec), (tq) => execute(tq));

    expect(result.resultStatus).toBe('partial');
    expect(result.suppliersStatus).toEqual({ A: 'up', B: 'down' });
    expect(result.offers).toHaveLength(6);
    expect(result.offers.every((o) => o.supplier === 'Supplier A')).toBe(true);
    expect(rec.attempts.B).toBe(3); // maximumAttempts
    expect(rec.persisted[0]?.resultStatus).toBe('partial');
  });

  it('does not retry non-retryable supplier errors', async () => {
    const rec = newRecorder();
    const fetchImpl: FetchImpl = async (supplier) => {
      if (supplier === 'A')
        throw ApplicationFailure.nonRetryable('bad request', 'SupplierClientError');
      return FIXTURES.B;
    };
    const result = await withWorker(mockActivities(fetchImpl, rec), (tq) => execute(tq));
    expect(rec.attempts.A).toBe(1);
    expect(result.suppliersStatus).toEqual({ A: 'down', B: 'up' });
  });

  it('both suppliers throw: fails with AllSuppliersUnavailable and persists nothing', async () => {
    const rec = newRecorder();
    const fail: FetchImpl = async () => {
      throw new Error('boom');
    };
    const err = await withWorker(mockActivities(fail, rec), (tq) => execute(tq)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(WorkflowFailedError);
    const cause = (err as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe('AllSuppliersUnavailable');
    expect(rec.persisted).toHaveLength(0);
  });

  it('fails with CacheUnavailable when persisting keeps failing', async () => {
    const rec = newRecorder();
    const err = await withWorker(mockActivities(ok, rec, true), (tq) => execute(tq)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkflowFailedError);
    expect(((err as WorkflowFailedError).cause as ApplicationFailure).type).toBe(
      'CacheUnavailable',
    );
  });

  it('status query reports progress while fetching and the final state when done', async () => {
    const rec = newRecorder();
    let releaseB: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (releaseB = resolve));
    const fetchImpl: FetchImpl = async (supplier) => {
      if (supplier === 'B') {
        await gate;
        throw ApplicationFailure.nonRetryable('B rejected', 'SupplierClientError');
      }
      return FIXTURES.A;
    };

    await withWorker(mockActivities(fetchImpl, rec), async (taskQueue) => {
      const handle = await env.client.workflow.start<typeof hotelOffersWorkflow>(
        'hotelOffersWorkflow',
        {
          taskQueue,
          workflowId: `wf-${randomUUID()}`,
          args: [{ city: 'delhi', requestId: 'req-query' }],
        },
      );

      let midFlight: WorkflowStatus | undefined;
      for (let i = 0; i < 50; i++) {
        midFlight = await handle.query<WorkflowStatus>('status');
        if (midFlight.suppliers.A === 'up') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(midFlight).toEqual({
        step: 'fetching',
        city: 'delhi',
        suppliers: { A: 'up', B: 'pending' },
      });

      releaseB();
      await handle.result();
      expect(await handle.query<WorkflowStatus>('status')).toEqual({
        step: 'done',
        city: 'delhi',
        suppliers: { A: 'up', B: 'down' },
      });
    });
  });
});
