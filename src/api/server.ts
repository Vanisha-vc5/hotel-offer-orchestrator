import type { Server } from 'node:http';
import { ConfigError, config, loadConfig } from '../infra/config';
import type { Config } from '../infra/config';
import { HotelRepository } from '../infra/hotelRepository';
import { logger } from '../infra/logger';
import { closeRedis, getRedis } from '../infra/redis';
import { ChaosStore } from '../mocks/chaos';
import { SupplierMetrics } from '../mocks/supplierMetrics';
import { closeTemporalClient, getTemporalClient, runHotelOffersWorkflow } from '../temporal/client';
import { formatCircuitHeader } from '../domain/circuit';
import { MonitorStore } from '../infra/monitorStore';
import { probeNow, resetMonitors } from '../temporal/monitorClient';
import { createApp } from './app';
import type { AppDeps } from './app';
import { monitorAdminRoutes } from './routes/monitor.routes';
import { warmupAdminRoutes } from './routes/warmup.routes';
import { createToolCaller } from '../infra/llm';
import { supplierAHotels } from '../mocks/supplierA.data';
import { supplierBHotels } from '../mocks/supplierB.data';
import { AskService, LlmQueryParser, RulesQueryParser } from './services/askService';
import type { QueryParser } from './services/askService';
import { DuplicateService } from './services/duplicateService';
import { runDuplicateReview } from '../temporal/duplicateClient';
import { runWarmupNow, warmupStatus } from '../temporal/warmupClient';
import { HealthService } from './services/healthService';
import { HotelService } from './services/hotelService';

function buildDeps(cfg: Config): AppDeps {
  const redis = getRedis();
  const repository = new HotelRepository(redis);

  const hotelService = new HotelService(async (input) => {
    const client = await getTemporalClient();
    return runHotelOffersWorkflow(client, input, cfg);
  }, repository);

  // Enhancement 2: monitor + circuit breaker (Redis view + Temporal control plane).
  const monitorStore = cfg.FEATURE_MONITOR ? new MonitorStore(redis) : undefined;

  const healthService = new HealthService(
    cfg,
    repository,
    async (deadlineMs) => {
      const client = await getTemporalClient();
      await client.connection.withDeadline(Date.now() + deadlineMs, () =>
        client.connection.workflowService.getSystemInfo({}),
      );
    },
    monitorStore ? (supplier) => monitorStore.summary(supplier) : undefined,
  );

  const deps: AppDeps = {
    cfg,
    repository,
    hotelService,
    healthService,
    chaos: new ChaosStore(redis),
    metrics: cfg.FEATURE_BENCHMARK ? new SupplierMetrics(redis) : undefined,
    onChaosReset: [],
    adminExtensions: [],
  };

  if (monitorStore) {
    deps.circuitHeader = async () => {
      const c = await monitorStore.getAllCircuits();
      return formatCircuitHeader({ A: c.A.state, B: c.B.state });
    };
    deps.adminExtensions?.push(
      monitorAdminRoutes(monitorStore, {
        probeNow: async () => probeNow(await getTemporalClient()),
      }),
    );
    deps.onChaosReset?.push(async () => {
      await monitorStore.resetCircuits();
      await resetMonitors(await getTemporalClient()).catch(() => undefined);
    });
  }

  if (cfg.FEATURE_ASK) {
    const knownCities = [
      ...new Set([...supplierAHotels, ...supplierBHotels].map((h) => h.city.toLowerCase())),
      ...cfg.WARMUP_CITIES,
    ];
    const llm = createToolCaller(cfg);
    const parsers: QueryParser[] = [
      ...(llm ? [new LlmQueryParser(llm)] : []),
      new RulesQueryParser([...new Set(knownCities)]),
    ];
    deps.askService = new AskService(parsers, hotelService, redis);
    logger.info(
      { provider: cfg.LLM_PROVIDER, model: llm?.model },
      'natural-language search enabled',
    );
  }

  if (cfg.FEATURE_DUPLICATES) {
    deps.duplicateService = new DuplicateService(repository, async (city) =>
      runDuplicateReview(await getTemporalClient(), city, cfg),
    );
  }

  if (cfg.FEATURE_WARMUP) {
    deps.adminExtensions?.push(
      warmupAdminRoutes({
        status: async () => warmupStatus(await getTemporalClient(), cfg),
        runNow: async () => runWarmupNow(await getTemporalClient()),
      }),
    );
    // A warm-up during a chaos test can cache partial data; drop it on reset.
    deps.onChaosReset?.push(async () => {
      await Promise.all(cfg.WARMUP_CITIES.map((city) => repository.deleteCity(city)));
    });
  }

  return deps;
}

async function main(): Promise<void> {
  const cfg = config();
  const deps = buildDeps(cfg);
  const app = createApp(deps);
  const server: Server = app.listen(cfg.PORT, () => {
    logger.info({ port: cfg.PORT, env: cfg.NODE_ENV }, 'api listening');
  });
  // Warm the Temporal connection; failures are retried lazily per request.
  getTemporalClient().catch(() => undefined);
  installShutdown(server, cfg.SHUTDOWN_TIMEOUT_MS, () => deps.healthService.markShuttingDown());
}

/**
 * Graceful shutdown: fail readiness, stop accepting connections, let in-flight
 * requests drain (bounded by SHUTDOWN_TIMEOUT_MS), then close Temporal and Redis.
 */
function installShutdown(server: Server, timeoutMs: number, onStart: () => void): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    onStart();
    logger.info({ signal }, 'shutdown started: draining in-flight requests');

    const forceTimer = setTimeout(() => {
      logger.warn('drain timeout reached; closing remaining connections');
      server.closeAllConnections();
    }, timeoutMs);
    forceTimer.unref();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    clearTimeout(forceTimer);

    await closeTemporalClient();
    await closeRedis();
    logger.info('shutdown complete');
    logger.flush();
    process.exit(0);
  };
  process.on('SIGINT', (s) => void shutdown(s));
  process.on('SIGTERM', (s) => void shutdown(s));
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

main().catch((err: unknown) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
