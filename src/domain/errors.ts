/**
 * Typed application errors. Every error that crosses the HTTP boundary is an
 * AppError (or is mapped to one) so the error body shape is always identical.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'UNPROCESSABLE_QUERY'
  | 'SUPPLIERS_UNAVAILABLE'
  | 'TEMPORAL_UNAVAILABLE'
  | 'REDIS_UNAVAILABLE'
  | 'WORKFLOW_TIMEOUT'
  | 'WORKFLOW_FAILED'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  path?: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly details: ErrorDetail[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: ErrorDetail[] = []) {
    super('VALIDATION_ERROR', 400, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Route not found') {
    super('NOT_FOUND', 404, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid x-admin-token header') {
    super('UNAUTHORIZED', 401, message);
  }
}

export class SuppliersUnavailableError extends AppError {
  constructor(message = 'All suppliers are currently unavailable', cause?: unknown) {
    super('SUPPLIERS_UNAVAILABLE', 503, message, [], { cause });
  }
}

export class TemporalUnavailableError extends AppError {
  constructor(message = 'Workflow engine (Temporal) is unreachable', cause?: unknown) {
    super('TEMPORAL_UNAVAILABLE', 503, message, [], { cause });
  }
}

export class RedisUnavailableError extends AppError {
  constructor(message = 'Cache (Redis) is unreachable', cause?: unknown) {
    super('REDIS_UNAVAILABLE', 503, message, [], { cause });
  }
}

export class WorkflowTimeoutError extends AppError {
  constructor(message = 'Workflow did not complete in time', cause?: unknown) {
    super('WORKFLOW_TIMEOUT', 504, message, [], { cause });
  }
}

export class WorkflowExecutionError extends AppError {
  constructor(message = 'Workflow failed', cause?: unknown) {
    super('WORKFLOW_FAILED', 502, message, [], { cause });
  }
}

/** ApplicationFailure `type` values shared by workflow, activities and the API error mapper. */
export const FailureTypes = {
  AllSuppliersUnavailable: 'AllSuppliersUnavailable',
  SupplierClientError: 'SupplierClientError',
  SupplierInvalidPayload: 'SupplierInvalidPayload',
  CacheUnavailable: 'CacheUnavailable',
  /** Enhancement 2: the supplier's circuit is open; fail fast without an HTTP call. */
  CircuitOpen: 'CircuitOpen',
} as const;
