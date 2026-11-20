/**
 * Container HEALTHCHECK probe (no curl in slim images). Exits 0 when the
 * liveness URL answers 2xx within 3s. The worker image sets HEALTHCHECK_URL
 * to its own health port.
 */
const url = process.env.HEALTHCHECK_URL ?? 'http://127.0.0.1:3000/health/live';

fetch(url, { signal: AbortSignal.timeout(3_000) })
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
