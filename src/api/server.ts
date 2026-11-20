import type { Server } from 'node:http';
import { createApp } from './app';
import { config, ConfigError, loadConfig } from '../infra/config';
import { logger } from '../infra/logger';
import { closeRedis, getRedis } from '../infra/redis';
import { ChaosStore } from '../mocks/chaos';

async function main(): Promise<void> {
  const cfg = config();
  const app = createApp({ chaos: new ChaosStore(getRedis()) });
  const server: Server = app.listen(cfg.PORT, () => {
    logger.info({ port: cfg.PORT, env: cfg.NODE_ENV }, 'api listening');
  });
  installShutdown(server, cfg.SHUTDOWN_TIMEOUT_MS);
}

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests drain
 * (bounded by SHUTDOWN_TIMEOUT_MS), then close Redis and Temporal.
 */
function installShutdown(server: Server, timeoutMs: number): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
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
