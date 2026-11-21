import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import { config } from './config';

/**
 * Never log secrets: request auth headers, and any secret-looking field one or two
 * levels deep (e.g. an accidentally logged config object or error context).
 */
export const REDACT_PATHS = [
  'req.headers["x-admin-token"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...[
    'ADMIN_TOKEN',
    'LLM_API_KEY',
    'TEMPORAL_API_KEY',
    'apiKey',
    'token',
    'password',
    'secret',
  ].flatMap((k) => [k, `*.${k}`]),
];

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
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // pino-pretty is a devDependency and is only resolved in an interactive dev shell.
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}

export const logger: PinoLogger = buildLogger();
export type Logger = PinoLogger;
