import { readFileSync } from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import type { TLSConfig } from '@temporalio/client';
import { TemporalUnavailableError } from '../domain/errors';
import type { Config } from '../infra/config';
import { config } from '../infra/config';
import { logger } from '../infra/logger';
import { retryWithBackoff } from '../infra/retry';

export interface TemporalConnectionSettings {
  address: string;
  tls?: TLSConfig | boolean;
  apiKey?: string;
}

/**
 * Connection settings shared by the API client and the worker. Supports a local
 * dev server (plaintext), Temporal Cloud with an API key, or Temporal Cloud mTLS.
 */
export function temporalConnectionSettings(cfg: Config = config()): TemporalConnectionSettings {
  const settings: TemporalConnectionSettings = { address: cfg.TEMPORAL_ADDRESS };
  if (cfg.TEMPORAL_TLS_CERT_PATH && cfg.TEMPORAL_TLS_KEY_PATH) {
    settings.tls = {
      clientCertPair: {
        crt: readFileSync(cfg.TEMPORAL_TLS_CERT_PATH),
        key: readFileSync(cfg.TEMPORAL_TLS_KEY_PATH),
      },
      ...(cfg.TEMPORAL_TLS_SERVER_NAME ? { serverNameOverride: cfg.TEMPORAL_TLS_SERVER_NAME } : {}),
    };
  } else if (cfg.TEMPORAL_TLS || cfg.TEMPORAL_API_KEY) {
    settings.tls = true;
  }
  if (cfg.TEMPORAL_API_KEY) settings.apiKey = cfg.TEMPORAL_API_KEY;
  return settings;
}

let clientPromise: Promise<Client> | undefined;

async function connect(): Promise<Client> {
  const cfg = config();
  const connection = await retryWithBackoff(
    () => Connection.connect({ ...temporalConnectionSettings(cfg), connectTimeout: '2s' }),
    {
      attempts: 3,
      initialDelayMs: 200,
      maxDelayMs: 1_000,
      onRetry: (attempt, err, delayMs) =>
        logger.warn({ attempt, delayMs, err: (err as Error).message }, 'temporal connect retry'),
    },
  );
  logger.info(
    { address: cfg.TEMPORAL_ADDRESS, namespace: cfg.TEMPORAL_NAMESPACE },
    'temporal client connected',
  );
  return new Client({ connection, namespace: cfg.TEMPORAL_NAMESPACE });
}

/**
 * Lazy singleton. A failed connect is not cached, so the next request retries
 * (reconnect with backoff) instead of the API being stuck with a dead client.
 */
export function getTemporalClient(): Promise<Client> {
  clientPromise ??= connect().catch((err: unknown) => {
    clientPromise = undefined;
    throw new TemporalUnavailableError(undefined, err);
  });
  return clientPromise;
}

export async function closeTemporalClient(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  if (!pending) return;
  try {
    const client = await pending;
    await client.connection.close();
  } catch {
    // never connected; nothing to close
  }
}
