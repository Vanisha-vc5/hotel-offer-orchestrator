import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import { config } from './config';

function buildLogger(): PinoLogger {
  const cfg = config();
  const pretty = cfg.NODE_ENV === 'development' && process.stdout.isTTY;
  return pino({
    level: cfg.NODE_ENV === 'test' ? 'silent' : cfg.LOG_LEVEL,
    base: {
      service: process.env.SERVICE_NAME ?? 'hotel-offer-orchestrator',
      version: cfg.SERVICE_VERSION,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: ['req.headers["x-admin-token"]', 'req.headers.authorization'], remove: true },
    // pino-pretty is a devDependency and is only resolved in an interactive dev shell.
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}

export const logger: PinoLogger = buildLogger();
export type Logger = PinoLogger;
