import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const ms = z.coerce.number().int().positive();

/**
 * Every tunable lives here. Values are validated once at startup; an invalid
 * environment aborts the process with a readable list of problems instead of
 * failing later at the first request.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  SERVICE_VERSION: z.string().default('1.0.0'),

  // HTTP API
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY: bool.default(false),
  RATE_LIMIT_WINDOW_MS: ms.default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  SHUTDOWN_TIMEOUT_MS: ms.default(10_000),
  HEALTH_CHECK_TIMEOUT_MS: ms.default(2_000),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  PARTIAL_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),

  // Temporal
  TEMPORAL_ADDRESS: z.string().min(1).default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
  TEMPORAL_API_KEY: z.string().optional(),
  TEMPORAL_TLS: bool.default(false),
  TEMPORAL_TLS_CERT_PATH: z.string().optional(),
  TEMPORAL_TLS_KEY_PATH: z.string().optional(),
  TEMPORAL_TLS_SERVER_NAME: z.string().optional(),
  TEMPORAL_CONNECT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  // Workflow + activity tuning (passed into the workflow as input, see shared.ts)
  WORKFLOW_EXECUTION_TIMEOUT: z.string().default('30s'),
  SUPPLIER_ACTIVITY_TIMEOUT: z.string().default('4s'),
  SUPPLIER_HTTP_TIMEOUT_MS: ms.default(3_500),
  SUPPLIER_RETRY_INITIAL_INTERVAL: z.string().default('300ms'),
  SUPPLIER_RETRY_BACKOFF: z.coerce.number().min(1).default(2),
  SUPPLIER_RETRY_MAX_INTERVAL: z.string().default('2s'),
  SUPPLIER_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  PERSIST_ACTIVITY_TIMEOUT: z.string().default('5s'),
  PERSIST_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // Suppliers
  SUPPLIER_A_URL: z.string().url().default('http://localhost:3000/supplierA/hotels'),
  SUPPLIER_B_URL: z.string().url().default('http://localhost:3000/supplierB/hotels'),

  // Chaos / admin
  ENABLE_CHAOS: bool.default(true),
  ADMIN_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as "unset" so `FOO=` in .env falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const cfg = parsed.data;
  if (Boolean(cfg.TEMPORAL_TLS_CERT_PATH) !== Boolean(cfg.TEMPORAL_TLS_KEY_PATH)) {
    throw new ConfigError([
      'TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH must be set together (mTLS)',
    ]);
  }
  return cfg;
}

let cached: Config | undefined;

/** Lazily-loaded process-wide config. */
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
