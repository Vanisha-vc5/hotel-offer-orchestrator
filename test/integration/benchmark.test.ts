import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

describe('Enhancement 1: supplier call metrics + coalescing override (FEATURE_BENCHMARK=true)', () => {
  let t: TestApp;
  let api: ReturnType<typeof request>;

  beforeAll(async () => {
    t = await startTestApp({ RATE_LIMIT_MAX: '3' });
    api = request(t.baseUrl);
  });
  beforeEach(async () => {
    await api.delete('/admin/metrics/suppliers').expect(200);
  });
  afterAll(() => t.close());

  it('counts supplier data calls, but not health probes', async () => {
    expect((await api.get('/admin/metrics/suppliers').expect(200)).body).toEqual({ A: 0, B: 0 });
    await api.get('/supplierA/hotels?city=delhi').expect(200);
    await api.get('/supplierA/hotels').expect(200);
    await api.get('/supplierB/hotels').expect(200);
    await api.get('/supplierB/hotels').set('x-health-probe', 'true').expect(200);
    await api.get('/health').expect(200); // probes both suppliers with x-health-probe
    expect((await api.get('/admin/metrics/suppliers')).body).toEqual({ A: 2, B: 1 });
    expect((await api.delete('/admin/metrics/suppliers').expect(200)).body).toEqual({ A: 0, B: 0 });
  });

  it('X-Coalescing: off gives the request its own workflow id', async () => {
    const on = await api.get('/api/hotels?city=delhi').set('x-benchmark', '1').expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(true);
    expect(on.headers['x-workflow-id']).toBe('hotel-offers-delhi');

    const off = await api
      .get('/api/hotels?city=delhi')
      .set('x-benchmark', '1')
      .set('x-coalescing', 'off')
      .expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(false);
    expect(off.headers['x-workflow-id']).toMatch(/^hotel-offers-delhi--/);
    expect(Object.keys(off.body[0])).toEqual(['name', 'price', 'supplier', 'commissionPct']);
  });

  it('x-benchmark: 1 bypasses the /api rate limit; normal traffic does not', async () => {
    for (let i = 0; i < 5; i++) {
      await api.get('/api/hotels?city=goa').set('x-benchmark', '1').expect(200);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await api.get('/api/hotels?city=goa')).status);
    expect(statuses).toContain(429);
  });
});

describe('Enhancement 1 with ADMIN_TOKEN set', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ ADMIN_TOKEN: 's3cret' });
  });
  afterAll(() => t.close());

  it('ignores the override from an untrusted caller', async () => {
    await request(t.baseUrl).get('/api/hotels?city=delhi').set('x-coalescing', 'off').expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(true);
    await request(t.baseUrl)
      .get('/api/hotels?city=delhi')
      .set('x-coalescing', 'off')
      .set('x-admin-token', 's3cret')
      .expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(false);
    await request(t.baseUrl).get('/admin/metrics/suppliers').expect(401);
  });
});

describe('Enhancement 1 with FEATURE_BENCHMARK=false (v1 behaviour)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ FEATURE_BENCHMARK: 'false', RATE_LIMIT_MAX: '2' });
  });
  afterAll(() => t.close());

  it('has no metrics endpoints, no override and no rate-limit bypass', async () => {
    const api = request(t.baseUrl);
    await api.get('/admin/metrics/suppliers').expect(404);
    await api.get('/api/hotels?city=delhi').set('x-coalescing', 'off').expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(true);
    await api.get('/api/hotels?city=delhi').set('x-benchmark', '1').expect(200);
    await api.get('/api/hotels?city=delhi').set('x-benchmark', '1').expect(429);
  });
});
