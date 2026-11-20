import type { Duration } from '@temporalio/common';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const ms = z.coerce.number().int().positive();

/** Temporal duration string such as '300ms', '4s', '1.5m'. */
const duration = z
  .string()
  .regex(/^\d+(\.\d+)?(ms|s|m|h|d)$/, 'expected a duration like 300ms, 4s or 2m')
  .transform((v) => v as Duration);

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
  /** gRPC deadline for starting a workflow from the API (fail fast → 503). */
  TEMPORAL_START_TIMEOUT_MS: ms.default(5_000),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  // Workflow + activity tuning (passed into the workflow as input, see shared.ts)
  WORKFLOW_EXECUTION_TIMEOUT: duration.default('30s'),
  SUPPLIER_ACTIVITY_TIMEOUT: duration.default('4s'),
  SUPPLIER_HTTP_TIMEOUT_MS: ms.default(3_500),
  SUPPLIER_RETRY_INITIAL_INTERVAL: duration.default('300ms'),
  SUPPLIER_RETRY_BACKOFF: z.coerce.number().min(1).default(2),
  SUPPLIER_RETRY_MAX_INTERVAL: duration.default('2s'),
  SUPPLIER_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  PERSIST_ACTIVITY_TIMEOUT: duration.default('5s'),
  PERSIST_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // Suppliers
  SUPPLIER_A_URL: z.string().url().default('http://localhost:3000/supplierA/hotels'),
  SUPPLIER_B_URL: z.string().url().default('http://localhost:3000/supplierB/hotels'),

  // v2 feature flags (all on by default; off = exact v1 behaviour)
  /** Enhancement 1: supplier call counters, X-Coalescing override, benchmark rate-limit bypass. */
  FEATURE_BENCHMARK: bool.default(true),
  /** Request coalescing (one workflow run per city). false only for comparisons. */
  COALESCING_ENABLED: bool.default(true),

  /** Enhancement 2: supplier monitor workflows + circuit breaker. */
  FEATURE_MONITOR: bool.default(true),
  MONITOR_INTERVAL: duration.default('15s'),
  MONITOR_PROBE_TIMEOUT_MS: ms.default(2_000),
  MONITOR_CONTINUE_AS_NEW_EVERY: z.coerce.number().int().positive().default(100),
  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  CIRCUIT_COOLDOWN: duration.default('30s'),

  /** Enhancement 3: Temporal Schedule that pre-warms the cache. */
  FEATURE_WARMUP: bool.default(true),
  WARMUP_CITIES: z
    .string()
    .default('delhi,mumbai,bangalore')
    .transform((v) =>
      v
        .split(',')
        .map((c) => c.trim().replace(/\s+/g, ' ').toLowerCase())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(
          z
            .string()
            .max(50)
            .regex(/^[\p{L} -]+$/u, 'invalid city in WARMUP_CITIES'),
        )
        .min(1),
    ),
  WARMUP_INTERVAL: duration.default('2m'),

  /** Enhancement 4: POST /api/hotels/ask natural-language search. */
  FEATURE_ASK: bool.default(true),
  LLM_PROVIDER: z.enum(['none', 'anthropic', 'openai-compatible']).default('none'),
  /** anthropic default: claude-haiku-4-5. Required for openai-compatible. */
  LLM_MODEL: z.string().optional(),
  /** anthropic: optional (SDK falls back to ANTHROPIC_API_KEY / ant profile). */
  LLM_API_KEY: z.string().optional(),
  /** openai-compatible base URL, e.g. https://api.groq.com/openai/v1 or http://localhost:11434/v1 */
  LLM_BASE_URL: z.string().url().optional(),
  LLM_TIMEOUT_MS: ms.default(5_000),

  /** Enhancement 6: report-only near-duplicate detection in insights. */
  FEATURE_DUPLICATES: bool.default(true),

  /** Enhancement 7: ops console at /console. */
  FEATURE_CONSOLE: bool.default(true),
  /** Base URL of the Temporal UI, used for workflow links in the console. */
  TEMPORAL_UI_URL: z.string().url().default('http://localhost:8080'),

  // Chaos / admin
  ENABLE_CHAOS: bool.default(true),
  /** Enhancement 5: production refuses to start without a strong ADMIN_TOKEN. */
  REQUIRE_ADMIN_TOKEN: bool.default(false),
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
  if (cfg.REQUIRE_ADMIN_TOKEN && (!cfg.ADMIN_TOKEN || cfg.ADMIN_TOKEN.length < 16)) {
    throw new ConfigError([
      'ADMIN_TOKEN is required (at least 16 characters) when REQUIRE_ADMIN_TOKEN=true',
    ]);
  }
  if (cfg.LLM_PROVIDER === 'openai-compatible' && (!cfg.LLM_BASE_URL || !cfg.LLM_MODEL)) {
    throw new ConfigError(['LLM_PROVIDER=openai-compatible requires LLM_BASE_URL and LLM_MODEL']);
  }
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
