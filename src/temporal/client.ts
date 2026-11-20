import { readFileSync } from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import type { TLSConfig } from '@temporalio/client';
import { msToNumber } from '@temporalio/common/lib/time';
import { TemporalUnavailableError } from '../domain/errors';
import type { Config } from '../infra/config';
import { config } from '../infra/config';
import { logger } from '../infra/logger';
import { retryWithBackoff } from '../infra/retry';
import type { hotelOffersWorkflow } from './workflows';
import { TASK_QUEUE, workflowIdForCity } from './shared';
import type { ActivityTuning, HotelOffersWorkflowResult } from './shared';

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

/** Builds activity tuning from env; it travels to the workflow as input. */
export function tuningFromConfig(cfg: Config = config()): ActivityTuning {
  return {
    supplierStartToCloseTimeout: cfg.SUPPLIER_ACTIVITY_TIMEOUT,
    supplierRetry: {
      initialInterval: cfg.SUPPLIER_RETRY_INITIAL_INTERVAL,
      backoffCoefficient: cfg.SUPPLIER_RETRY_BACKOFF,
      maximumInterval: cfg.SUPPLIER_RETRY_MAX_INTERVAL,
      maximumAttempts: cfg.SUPPLIER_RETRY_MAX_ATTEMPTS,
    },
    persistStartToCloseTimeout: cfg.PERSIST_ACTIVITY_TIMEOUT,
    persistMaximumAttempts: cfg.PERSIST_RETRY_MAX_ATTEMPTS,
  };
}

export interface WorkflowRun {
  result: HotelOffersWorkflowResult;
  workflowId: string;
  runId: string;
}

/**
 * Starts (or joins) the hotel-offers workflow for a city and waits for its result.
 *
 * Request coalescing: the workflow ID is deterministic per city and the start
 * uses `workflowIdConflictPolicy: USE_EXISTING`, so concurrent requests for the
 * same city attach to the one running execution instead of each fanning out to
 * the suppliers. `workflowIdReusePolicy: ALLOW_DUPLICATE` lets a fresh run start
 * once the previous one has closed (completed or failed).
 */
export async function runHotelOffersWorkflow(
  client: Client,
  input: { city: string; requestId: string },
  cfg: Config = config(),
): Promise<WorkflowRun> {
  // Explicit gRPC deadlines: without them the SDK's retry interceptor keeps
  // retrying an unreachable server for ~90s before the API could answer 503.
  const handle = await client.connection.withDeadline(
    Date.now() + cfg.TEMPORAL_START_TIMEOUT_MS,
    () =>
      client.workflow.start<typeof hotelOffersWorkflow>('hotelOffersWorkflow', {
        taskQueue: TASK_QUEUE,
        workflowId: workflowIdForCity(input.city),
        args: [{ ...input, tuning: tuningFromConfig(cfg) }],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        workflowExecutionTimeout: cfg.WORKFLOW_EXECUTION_TIMEOUT,
        memo: { requestId: input.requestId, city: input.city },
      }),
  );
  // The workflow itself times out after WORKFLOW_EXECUTION_TIMEOUT; the margin
  // lets that timeout surface as a WorkflowFailedError (504) rather than a deadline.
  const resultDeadline = Date.now() + msToNumber(cfg.WORKFLOW_EXECUTION_TIMEOUT) + 5_000;
  const result = await client.connection.withDeadline(resultDeadline, () => handle.result());
  return { result, workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
}
