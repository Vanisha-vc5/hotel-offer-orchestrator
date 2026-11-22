import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLOSED } from '../../src/domain/circuit';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

const OPEN = {
  state: 'open' as const,
  consecutiveFailures: 3,
  openUntil: Date.now() + 30_000,
  lastCheckedAt: Date.now(),
};

describe('Supplier monitor: circuit breaker surface (FEATURE_MONITOR=true)', () => {
  let t: TestApp;
  let api: ReturnType<typeof request>;

  beforeAll(async () => {
    t = await startTestApp();
    api = request(t.baseUrl);
  });
  beforeEach(async () => {
    await t.monitorStore.resetCircuits();
    await t.repository.deleteCity('delhi');
  });
  afterAll(() => t.close());

  it('GET /admin/circuits reports both suppliers', async () => {
    const res = await api.get('/admin/circuits').expect(200);
    expect(res.body).toEqual({
      A: { state: 'closed', consecutiveFailures: 0, openUntil: null, lastCheckedAt: null },
      B: { state: 'closed', consecutiveFailures: 0, openUntil: null, lastCheckedAt: null },
    });
  });

  it('adds X-Circuit-State without touching the frozen headers or body', async () => {
    await t.monitorStore.setCircuit('B', OPEN);
    const res = await api.get('/api/hotels?city=delhi').expect(200);
    expect(res.headers['x-circuit-state']).toBe('A=closed;B=open');
    expect(res.headers['x-suppliers-status']).toBe('A=up;B=up'); // fake runner: suppliers answered
    expect(res.body).toHaveLength(7);

    const filtered = await api
      .get('/api/hotels?city=delhi&minPrice=5000&maxPrice=9000')
      .expect(200);
    expect(filtered.headers['x-circuit-state']).toBe('A=closed;B=open');
  });

  it('adds a monitor block under each supplier in /health (existing fields unchanged)', async () => {
    await t.monitorStore.saveProbe(
      'B',
      { at: Date.now(), ok: false, latencyMs: 5, status: 503, error: 'HTTP 503' },
      OPEN,
    );
    await t.monitorStore.saveProbe(
      'A',
      { at: Date.now(), ok: true, latencyMs: 4, status: 200 },
      CLOSED,
    );
    const res = await api.get('/health').expect(200);
    const { supplierA, supplierB } = res.body.dependencies;
    expect(supplierA).toMatchObject({
      status: 'up',
      monitor: { circuit: 'closed', consecutiveFailures: 0 },
    });
    expect(typeof supplierA.latencyMs).toBe('number');
    expect(supplierB.monitor).toMatchObject({ circuit: 'open', consecutiveFailures: 3 });
    expect(supplierB.monitor.uptimePctLastHour).toBeGreaterThanOrEqual(0);
    expect(supplierB.monitor.lastCheckedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('POST /admin/monitor/probe-now goes through the monitor control plane', async () => {
    const before = t.monitorControl.probeCalls;
    await api.post('/admin/monitor/probe-now').expect(200);
    expect(t.monitorControl.probeCalls).toBe(before + 1);
  });

  it('DELETE /admin/chaos also resets circuits (keeps Postman runs repeatable)', async () => {
    await t.monitorStore.setCircuit('B', OPEN);
    const resets = t.monitorControl.resets;
    await api.delete('/admin/chaos').expect(200);
    expect(t.monitorControl.resets).toBe(resets + 1);
    expect((await api.get('/admin/circuits')).body.B.state).toBe('closed');
  });
});

describe('Supplier monitor with FEATURE_MONITOR=false (v1 behaviour)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ FEATURE_MONITOR: 'false' });
  });
  afterAll(() => t.close());

  it('has no circuit header, no monitor fields and no circuit routes', async () => {
    const api = request(t.baseUrl);
    const res = await api.get('/api/hotels?city=delhi').expect(200);
    expect(res.headers['x-circuit-state']).toBeUndefined();
    const health = await api.get('/health').expect(200);
    expect(health.body.dependencies.supplierA.monitor).toBeUndefined();
    await api.get('/admin/circuits').expect(404);
    await api.post('/admin/monitor/probe-now').expect(404);
  });
});
