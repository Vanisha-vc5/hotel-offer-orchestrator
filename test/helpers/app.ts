import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ApplicationFailure,
  ServiceError,
  TimeoutFailure,
  WorkflowFailedError,
} from '@temporalio/client';
import type { Redis } from 'ioredis';
import { createApp } from '../../src/api/app';
import type { AppDeps } from '../../src/api/app';
import { HealthService } from '../../src/api/services/healthService';
import { HotelService } from '../../src/api/services/hotelService';
import type { WorkflowRunner } from '../../src/api/services/hotelService';
import { selectBestOffers } from '../../src/domain/selectBestOffers';
import type { SupplierHotel, SupplierId, SuppliersStatus } from '../../src/domain/types';
import { loadConfig } from '../../src/infra/config';
import { HotelRepository } from '../../src/infra/hotelRepository';
import { createRedis } from '../../src/infra/redis';
import { ChaosStore } from '../../src/mocks/chaos';
import { SupplierMetrics } from '../../src/mocks/supplierMetrics';
import { supplierAHotels } from '../../src/mocks/supplierA.data';
import { supplierBHotels } from '../../src/mocks/supplierB.data';
import { connectTestRedis } from './redis';

export type RunnerMode = 'ok' | 'B-down' | 'both-down' | 'temporal-down' | 'timeout';

/**
 * Stand-in for the Temporal client: computes the same result the real
 * workflow would (selectBestOffers on the mock data) and persists it through
 * the real repository, or throws the same errors the Temporal client throws.
 */
export class FakeWorkflowRunner {
  mode: RunnerMode = 'ok';
  calls = 0;
  lastInput?: Parameters<WorkflowRunner>[0];
  private runSeq = 0;

  constructor(private readonly repository: HotelRepository) {}

  readonly run: WorkflowRunner = async (input) => {
    const { city, requestId } = input;
    this.calls++;
    this.lastInput = input;
    if (this.mode === 'temporal-down') {
      throw new ServiceError('Failed to start Workflow', { cause: new Error('14 UNAVAILABLE') });
    }
    if (this.mode === 'both-down') {
      throw new WorkflowFailedError(
        'Workflow execution failed',
        ApplicationFailure.create({
          type: 'AllSuppliersUnavailable',
          message: 'All suppliers are unavailable',
          nonRetryable: true,
        }),
        'NON_RETRYABLE_FAILURE',
      );
    }
    if (this.mode === 'timeout') {
      throw new WorkflowFailedError(
        'Workflow execution timed out',
        new TimeoutFailure(undefined, undefined, 'START_TO_CLOSE'),
        'TIMEOUT',
      );
    }

    const forCity = (list: SupplierHotel[]): SupplierHotel[] =>
      list.filter((h) => h.city.toLowerCase() === city);
    const suppliersStatus: SuppliersStatus = { A: 'up', B: this.mode === 'B-down' ? 'down' : 'up' };
    const lists: Partial<Record<SupplierId, SupplierHotel[]>> = { A: forCity(supplierAHotels) };
    if (suppliersStatus.B === 'up') lists.B = forCity(supplierBHotels);

    const { offers, decisions } = selectBestOffers(lists);
    const resultStatus = suppliersStatus.B === 'up' ? 'complete' : 'partial';
    const result = { offers, decisions, suppliersStatus, resultStatus } as const;
    const workflowId =
      input.coalesce === false
        ? `hotel-offers-${city}--${this.runSeq + 1}`
        : `hotel-offers-${city}`;
    const runId = `run-${++this.runSeq}`;
    await this.repository.saveCityOffers(
      city,
      { ...result, workflowId, runId, requestId },
      resultStatus === 'partial' ? 30 : 300,
    );
    return { result, workflowId, runId };
  };
}

export interface TestApp {
  baseUrl: string;
  server: Server;
  runner: FakeWorkflowRunner;
  repository: HotelRepository;
  chaos: ChaosStore;
  redis: Redis;
  temporalUp: { value: boolean };
  close(): Promise<void>;
}

/**
 * Starts the real Express app on an ephemeral port (so /health can call the
 * mock supplier endpoints over HTTP), with a fake Temporal and real Redis.
 */
export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const redis = await connectTestRedis();
  const repository = new HotelRepository(redis);
  const chaos = new ChaosStore(redis);
  const runner = new FakeWorkflowRunner(repository);
  const temporalUp = { value: true };

  // Supplier URLs need the port, so listen first and attach the app afterwards.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const cfg = loadConfig({
    NODE_ENV: 'test',
    SUPPLIER_A_URL: `${baseUrl}/supplierA/hotels`,
    SUPPLIER_B_URL: `${baseUrl}/supplierB/hotels`,
    HEALTH_CHECK_TIMEOUT_MS: '500',
    ...env,
  });
  const deps: AppDeps = {
    cfg,
    repository,
    chaos,
    metrics: cfg.FEATURE_BENCHMARK ? new SupplierMetrics(redis) : undefined,
    hotelService: new HotelService(runner.run, repository),
    healthService: new HealthService(cfg, repository, async () => {
      if (!temporalUp.value) throw new Error('14 UNAVAILABLE: connection refused');
    }),
  };
  server.on('request', createApp(deps));

  return {
    baseUrl,
    server,
    runner,
    repository,
    chaos,
    redis,
    temporalUp,
    async close() {
      await chaos.reset();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await redis.quit();
    },
  };
}

/** A repository whose Redis is unreachable (for 503 REDIS_UNAVAILABLE tests). */
export function deadRedisRepository(): { repository: HotelRepository; redis: Redis } {
  const redis = createRedis('redis://127.0.0.1:1', 'dead-redis');
  redis.connect().catch(() => undefined);
  return { repository: new HotelRepository(redis), redis };
}
