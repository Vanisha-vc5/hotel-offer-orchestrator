import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { UnauthorizedError } from '../../domain/errors';

/** True only when ADMIN_TOKEN is configured AND the request carries it (constant-time compare). */
export function hasValidAdminToken(req: Request, adminToken: string | undefined): boolean {
  if (!adminToken) return false;
  const given = Buffer.from(req.header('x-admin-token') ?? '');
  const expected = Buffer.from(adminToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Trust model for /admin/*:
 *  - ADMIN_TOKEN set → the caller must send a matching `x-admin-token`;
 *  - ADMIN_TOKEN unset → open in development/test (local demos, exactly like v1),
 *    but CLOSED in production (fail closed, even if REQUIRE_ADMIN_TOKEN was missed).
 */
export function isTrustedOperator(
  req: Request,
  adminToken: string | undefined,
  production = false,
): boolean {
  if (!adminToken) return !production;
  return hasValidAdminToken(req, adminToken);
}

export function requireOperator(
  adminToken: string | undefined,
  production = false,
): RequestHandler {
  return (req, _res, next) =>
    isTrustedOperator(req, adminToken, production) ? next() : next(new UnauthorizedError());
}
