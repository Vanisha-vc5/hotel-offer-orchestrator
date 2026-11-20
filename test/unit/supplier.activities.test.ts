import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ApplicationFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/infra/config';
import { createSupplierActivities } from '../../src/temporal/activities/supplier.activities';

const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };

/** A tiny supplier stub whose behaviour is selected by the `city` query param. */
function startStub(): Promise<Server> {
  const server = createServer((req, res) => {
    const city = new URL(req.url ?? '/', 'http://x').searchParams.get('city');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    switch (city) {
      case 'ok':
        return json(200, [
          { hotelId: 'x1', name: 'Good', price: 100, city: 'ok', commissionPct: 10 },
          { hotelId: 'x2', name: '', price: 100, city: 'ok', commissionPct: 10 }, // empty name
          { hotelId: 'x3', name: 'Neg', price: -5, city: 'ok', commissionPct: 10 }, // negative price
          'garbage',
        ]);
      case 'server-error':
        return json(500, { error: 'boom' });
      case 'client-error':
        return json(404, { error: 'nope' });
      case 'not-array':
        return json(200, { hotels: [] });
      case 'slow':
        setTimeout(() => json(200, []), 1_000);
        return;
      default:
        return json(200, []);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('fetchSupplierHotels activity', () => {
  let server: Server;
  let activities: ReturnType<typeof createSupplierActivities>;

  beforeAll(async () => {
    server = await startStub();
    const { port } = server.address() as AddressInfo;
    activities = createSupplierActivities(
      loadConfig({
        NODE_ENV: 'test',
        SUPPLIER_A_URL: `http://127.0.0.1:${port}/a`,
        SUPPLIER_B_URL: `http://127.0.0.1:${port}/b`,
        SUPPLIER_HTTP_TIMEOUT_MS: '200',
      }),
    );
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const run = (city: string): Promise<unknown> =>
    new MockActivityEnvironment({ attempt: 2 }, { logger: silent }).run(
      activities.fetchSupplierHotels,
      'A',
      city,
      'req-1',
    );

  it('returns valid records and drops malformed ones', async () => {
    expect(await run('ok')).toEqual([
      { hotelId: 'x1', name: 'Good', price: 100, city: 'ok', commissionPct: 10 },
    ]);
  });

  it('treats 5xx as retryable', async () => {
    const err = await run('server-error').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err).toMatchObject({ type: 'SupplierServerError', nonRetryable: false });
  });

  it('treats a timeout as retryable', async () => {
    const err = await run('slow').catch((e: unknown) => e);
    expect(err).toMatchObject({ type: 'SupplierTimeout', nonRetryable: false });
    expect((err as Error).message).toContain('timeout after 200ms');
  });

  it('treats 4xx as non-retryable', async () => {
    const err = await run('client-error').catch((e: unknown) => e);
    expect(err).toMatchObject({ type: 'SupplierClientError', nonRetryable: true });
  });

  it('treats a non-array payload as non-retryable', async () => {
    const err = await run('not-array').catch((e: unknown) => e);
    expect(err).toMatchObject({ type: 'SupplierInvalidPayload', nonRetryable: true });
  });

  it('treats a network error as retryable', async () => {
    const dead = createSupplierActivities(
      loadConfig({ NODE_ENV: 'test', SUPPLIER_A_URL: 'http://127.0.0.1:1/a' }),
    );
    const err = await new MockActivityEnvironment(undefined, { logger: silent })
      .run(dead.fetchSupplierHotels, 'A', 'x')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ type: 'SupplierNetworkError', nonRetryable: false });
  });

  it('fails fast with non-retryable CircuitOpen when the circuit is open (no HTTP call)', async () => {
    let httpCalls = 0;
    const counting = createServer((_req, res) => {
      httpCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
    await new Promise<void>((r) => counting.listen(0, '127.0.0.1', () => r()));
    const { port } = counting.address() as AddressInfo;
    const cfg = loadConfig({ NODE_ENV: 'test', SUPPLIER_B_URL: `http://127.0.0.1:${port}/b` });
    const state = { value: 'open' as 'open' | 'closed' };
    const circuits = {
      getCircuit: async () => ({
        state: state.value,
        consecutiveFailures: 3,
        openUntil: 1,
        lastCheckedAt: 1,
      }),
    };
    const acts = createSupplierActivities(cfg, circuits);
    const env = new MockActivityEnvironment(undefined, { logger: silent });

    const started = performance.now();
    const err = await env.run(acts.fetchSupplierHotels, 'B', 'delhi').catch((e: unknown) => e);
    expect(err).toMatchObject({ type: 'CircuitOpen', nonRetryable: true });
    expect(performance.now() - started).toBeLessThan(100);
    expect(httpCalls).toBe(0);

    state.value = 'closed';
    expect(await env.run(acts.fetchSupplierHotels, 'B', 'delhi')).toEqual([]);
    expect(httpCalls).toBe(1);
    await new Promise<void>((r) => counting.close(() => r()));
  });
});
