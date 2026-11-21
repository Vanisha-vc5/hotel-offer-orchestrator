import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Client } from '@temporalio/client';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import type { WorkerOptions } from '@temporalio/worker';
import { ConfigError, config, loadConfig } from '../infra/config';
import { logger } from '../infra/logger';
import { closeRedis, getRedis } from '../infra/redis';
import { retryWithBackoff } from '../infra/retry';
import { HotelRepository } from '../infra/hotelRepository';
import { MonitorStore } from '../infra/monitorStore';
import { createToolCaller } from '../infra/llm';
import { ensureMonitors, stopMonitors } from './monitorClient';
import { deleteWarmupSchedule, ensureWarmupSchedule } from './warmupClient';
import { createActivities } from './activities';
import { temporalConnectionSettings } from './client';
import { PinoTemporalLogger } from './logger';
import { TASK_QUEUE } from './shared';
import { WORKFLOW_BUNDLE_PATH } from './bundlePath';

function workflowSource(): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  if (existsSync(WORKFLOW_BUNDLE_PATH)) {
    return { workflowBundle: { codePath: WORKFLOW_BUNDLE_PATH } };
  }
  // Dev (tsx): bundle on the fly from source.
  return { workflowsPath: require.resolve('./workflows') };
}

/** Minimal liveness endpoint for the container healthcheck (worker has no Express app). */
function startHealthServer(worker: Worker, port: number): Server {
  const server = createServer((req, res) => {
    const state = worker.getState();
    const healthy = state === 'RUNNING';
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'up' : 'down', workerState: state }));
  });
  return server.listen(port, () => logger.info({ port }, 'worker health endpoint listening'));
}

async function main(): Promise<void> {
  const cfg = config();
  Runtime.install({
    logger: new PinoTemporalLogger(logger.child({ component: 'temporal' })),
    // We handle signals ourselves so shutdown order is explicit (worker → redis → connection).
    shutdownSignals: [],
    // Forward native core (Rust) logs to the same pino logger instead of raw stderr.
    telemetryOptions: { logging: { forward: {}, filter: { core: 'WARN', other: 'ERROR' } } },
  });

  const connection = await retryWithBackoff(
    () => NativeConnection.connect(temporalConnectionSettings(cfg)),
    {
      attempts: cfg.TEMPORAL_CONNECT_MAX_ATTEMPTS,
      initialDelayMs: 500,
      maxDelayMs: 5_000,
      onRetry: (attempt, err, delayMs) =>
        logger.warn(
          { attempt, delayMs, err: (err as Error).message },
          'temporal not ready; retrying connect',
        ),
    },
  );

  const repository = new HotelRepository(getRedis());
  const monitorStore = new MonitorStore(getRedis());
  const worker = await Worker.create({
    connection,
    namespace: cfg.TEMPORAL_NAMESPACE,
    taskQueue: TASK_QUEUE,
    activities: createActivities({
      repository,
      cfg,
      monitorStore,
      toolCaller: createToolCaller(cfg, getRedis()),
    }),
    ...workflowSource(),
  });

  const health = startHealthServer(worker, cfg.WORKER_HEALTH_PORT);

  // Enhancement 2: long-running supplier monitors (idempotent start at boot).
  const client = new Client({ connection, namespace: cfg.TEMPORAL_NAMESPACE });
  const monitors = cfg.FEATURE_MONITOR ? ensureMonitors(client, cfg) : stopMonitors(client);
  monitors.catch((err: unknown) =>
    logger.error({ err: (err as Error).message }, 'could not start supplier monitors'),
  );

  // Enhancement 3: cache warm-up Schedule (create or update; deleted when the flag is off).
  const warmup = cfg.FEATURE_WARMUP
    ? ensureWarmupSchedule(client, cfg)
    : deleteWarmupSchedule(client);
  warmup.catch((err: unknown) =>
    logger.error({ err: (err as Error).message }, 'could not configure warm-up schedule'),
  );
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'worker shutdown requested; finishing in-flight tasks');
    worker.shutdown();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  logger.info({ taskQueue: TASK_QUEUE, namespace: cfg.TEMPORAL_NAMESPACE }, 'worker started');
  try {
    await worker.run(); // resolves once shutdown() has drained in-flight activities
  } finally {
    health.close();
    await closeRedis();
    await connection.close();
    logger.info('worker stopped');
    logger.flush();
  }
}

try {
  loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    logger.fatal({ err }, 'worker crashed');
    process.exit(1);
  },
);
