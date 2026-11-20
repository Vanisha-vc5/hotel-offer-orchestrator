import { ApplicationFailure, Context, log } from '@temporalio/activity';
import { z } from 'zod';
import { FailureTypes } from '../../domain/errors';
import type { SupplierHotel, SupplierId } from '../../domain/types';
import type { Config } from '../../infra/config';

/** Strict per-record contract; anything else is dropped (not fatal). */
export const SupplierRecordSchema = z.object({
  hotelId: z.string().min(1),
  name: z.string().trim().min(1),
  price: z.number().finite().nonnegative(),
  city: z.string().min(1),
  commissionPct: z.number().finite().min(0).max(100),
});

/** Transient failure types (retried by Temporal). */
export const RetryableSupplierErrors = {
  Timeout: 'SupplierTimeout',
  Network: 'SupplierNetworkError',
  Server: 'SupplierServerError',
} as const;

/** Errors that will never succeed on retry. Also listed in the retry policy. */
export const NON_RETRYABLE_SUPPLIER_ERRORS = [
  FailureTypes.SupplierClientError,
  FailureTypes.SupplierInvalidPayload,
];

function supplierUrl(cfg: Config, supplier: SupplierId, city: string): URL {
  const url = new URL(supplier === 'A' ? cfg.SUPPLIER_A_URL : cfg.SUPPLIER_B_URL);
  url.searchParams.set('city', city);
  return url;
}

export interface SupplierActivities {
  fetchSupplierHotels(
    supplier: SupplierId,
    city: string,
    requestId?: string,
  ): Promise<SupplierHotel[]>;
}

export function createSupplierActivities(cfg: Config): SupplierActivities {
  return {
    /**
     * GETs a supplier's hotels for a city.
     *  - 5xx / network error / timeout → retryable (Temporal retry policy applies)
     *  - 4xx / payload that is not a JSON array → non-retryable
     *  - individual malformed records → dropped and logged
     */
    async fetchSupplierHotels(supplier, city, requestId) {
      const ctx = Context.current();
      const attempt = ctx.info.attempt;
      const meta = { supplier, city, attempt, requestId };
      const timeoutMs = cfg.SUPPLIER_HTTP_TIMEOUT_MS;
      const timeout = AbortSignal.timeout(timeoutMs);
      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);

      ctx.heartbeat({ attempt });
      let res: Response;
      try {
        res = await fetch(supplierUrl(cfg, supplier, city), {
          signal: AbortSignal.any([timeout, ctx.cancellationSignal]),
          headers: requestId ? { 'x-request-id': requestId } : {},
        });
      } catch (err) {
        if (timeout.aborted) {
          log.warn('supplier timeout', { ...meta, latencyMs: elapsed(), timeoutMs });
          throw ApplicationFailure.retryable(
            `Supplier ${supplier} timeout after ${timeoutMs}ms`,
            RetryableSupplierErrors.Timeout,
          );
        }
        log.warn('supplier network error', { ...meta, latencyMs: elapsed(), err: String(err) });
        throw ApplicationFailure.retryable(
          `Supplier ${supplier} network error: ${(err as Error).message}`,
          RetryableSupplierErrors.Network,
        );
      }

      if (res.status >= 500) {
        log.warn('supplier server error', { ...meta, status: res.status, latencyMs: elapsed() });
        throw ApplicationFailure.retryable(
          `Supplier ${supplier} responded ${res.status}`,
          RetryableSupplierErrors.Server,
        );
      }
      if (res.status >= 400) {
        log.error('supplier client error', { ...meta, status: res.status, latencyMs: elapsed() });
        throw ApplicationFailure.nonRetryable(
          `Supplier ${supplier} rejected the request (${res.status})`,
          FailureTypes.SupplierClientError,
        );
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      if (!Array.isArray(body)) {
        log.error('supplier invalid payload', { ...meta, latencyMs: elapsed() });
        throw ApplicationFailure.nonRetryable(
          `Supplier ${supplier} returned a payload that is not a JSON array`,
          FailureTypes.SupplierInvalidPayload,
        );
      }

      const hotels: SupplierHotel[] = [];
      let dropped = 0;
      for (const [index, record] of body.entries()) {
        const parsed = SupplierRecordSchema.safeParse(record);
        if (parsed.success) {
          hotels.push(parsed.data);
        } else {
          dropped++;
          log.warn('supplier record dropped', {
            ...meta,
            index,
            hotelId: (record as { hotelId?: unknown } | null)?.hotelId,
            issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          });
        }
      }

      log.info('supplier fetched', {
        ...meta,
        latencyMs: elapsed(),
        received: body.length,
        accepted: hotels.length,
        dropped,
      });
      return hotels;
    },
  };
}
