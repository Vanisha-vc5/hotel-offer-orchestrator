import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    startedAt: bigint;
  }
}

/**
 * Accepts a caller-supplied X-Request-Id (if it is safe to log) or generates one.
 * The id is echoed back and later stored in the workflow memo so a single request
 * can be traced through API → workflow → activity logs.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.startedAt = process.hrtime.bigint();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/** Milliseconds since the request started, formatted for X-Response-Time. */
export function elapsedMs(req: Request): string {
  const ns = process.hrtime.bigint() - req.startedAt;
  return `${(Number(ns) / 1e6).toFixed(1)}ms`;
}

/**
 * Stamps X-Response-Time on every response (including errors) just before the
 * headers are flushed. Routes may set it earlier; an existing value is kept.
 */
export function responseTime(req: Request, res: Response, next: NextFunction): void {
  const writeHead = res.writeHead;
  // writeHead has several overloads; we forward the original arguments untouched.
  res.writeHead = function patchedWriteHead(this: Response, ...args: unknown[]) {
    if (!res.getHeader('X-Response-Time')) res.setHeader('X-Response-Time', elapsedMs(req));
    return (writeHead as (...a: unknown[]) => Response).apply(this, args);
  } as Response['writeHead'];
  next();
}
