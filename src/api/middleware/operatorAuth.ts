import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { UnauthorizedError } from '../../domain/errors';

/**
 * Operator trust model (shared by /admin and the benchmark helpers):
 * when ADMIN_TOKEN is set, the caller must send a matching `x-admin-token`;
 * when it is unset (local dev), every caller is trusted, exactly like v1 /admin.
 */
export function isTrustedOperator(req: Request, adminToken: string | undefined): boolean {
  if (!adminToken) return true;
  const given = Buffer.from(req.header('x-admin-token') ?? '');
  const expected = Buffer.from(adminToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function requireOperator(adminToken: string | undefined): RequestHandler {
  return (req, _res, next) =>
    isTrustedOperator(req, adminToken) ? next() : next(new UnauthorizedError());
}
