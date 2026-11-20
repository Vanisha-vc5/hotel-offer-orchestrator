import type { ErrorRequestHandler, RequestHandler } from 'express';
import {
  ApplicationFailure,
  ServiceError,
  TimeoutFailure,
  WorkflowFailedError,
  isGrpcServiceError,
} from '@temporalio/client';
import { ZodError } from 'zod';
import {
  AppError,
  FailureTypes,
  NotFoundError,
  RedisUnavailableError,
  SuppliersUnavailableError,
  TemporalUnavailableError,
  ValidationError,
  WorkflowExecutionError,
  WorkflowTimeoutError,
} from '../../domain/errors';
import { config } from '../../infra/config';

/** Walks a Temporal failure's `cause` chain and returns the innermost relevant failure. */
function findCause<T>(err: unknown, ctor: abstract new (...args: never[]) => T): T | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 10; depth++) {
    if (current instanceof ctor) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Translates any thrown value into a typed AppError (HTTP status + stable code). */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new ValidationError(
      'Invalid request',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }

  if (err instanceof WorkflowFailedError) {
    const app = findCause(err, ApplicationFailure);
    if (app?.type === FailureTypes.AllSuppliersUnavailable) {
      return new SuppliersUnavailableError(app.message, err);
    }
    if (app?.type === FailureTypes.CacheUnavailable) {
      return new RedisUnavailableError(app.message, err);
    }
    if (findCause(err, TimeoutFailure)) return new WorkflowTimeoutError(undefined, err);
    return new WorkflowExecutionError(app?.message ?? err.message, err);
  }

  if (err instanceof ServiceError || isGrpcServiceError(err)) {
    return new TemporalUnavailableError(undefined, err);
  }

  // body-parser / express errors carry an HTTP status
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new ValidationError((err as Error).message);
  }

  return new AppError('INTERNAL_ERROR', 500, 'Internal server error', [], { cause: err });
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appErr = toAppError(err);
  const log = req.log;
  if (appErr.status >= 500) {
    log?.error({ err, code: appErr.code }, appErr.message);
  } else {
    log?.info({ code: appErr.code, details: appErr.details }, appErr.message);
  }

  if (res.headersSent) return;
  const exposeStack = config().NODE_ENV === 'development';
  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      details: appErr.details,
      requestId: req.requestId,
      ...(exposeStack && err instanceof Error ? { stack: err.stack } : {}),
    },
  });
};
