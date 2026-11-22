import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

const TOKEN = 'bench-token-0123456789';

describe('Coalescing benchmark: supplier call metrics + coalescing override (FEATURE_BENCHMARK=true)', () => {
  let t: TestApp;
  let api: ReturnType<typeof request>;

  beforeAll(async () => {
    t = await startTestApp({ ADMIN_TOKEN: TOKEN });
    api = request(t.baseUrl);
  });
  beforeEach(async () => {
    await api.delete('/admin/metrics/suppliers').set('x-admin-token', TOKEN).expect(200);
  });
  afterAll(() => t.close());

  it('counts supplier data calls, but not health probes', async () => {
    const admin = (): ReturnType<typeof api.get> =>
      api.get('/admin/metrics/suppliers').set('x-admin-token', TOKEN);
    expect((await admin().expect(200)).body).toEqual({ A: 0, B: 0 });
    await api.get('/supplierA/hotels?city=delhi').expect(200);
    await api.get('/supplierA/hotels').expect(200);
    await api.get('/supplierB/hotels').expect(200);
    await api.get('/supplierB/hotels').set('x-health-probe', 'true').expect(200);
    await api.get('/health').expect(200); // probes both suppliers with x-health-probe
    expect((await admin()).body).toEqual({ A: 2, B: 1 });
  });

  it('X-Coalescing: off with a valid token gives the request its own workflow id', async () => {
    const on = await api.get('/api/hotels?city=delhi').expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(true);
    expect(on.headers['x-workflow-id']).toBe('hotel-offers-delhi');

    const off = await api
      .get('/api/hotels?city=delhi')
      .set('x-admin-token', TOKEN)
      .set('x-coalescing', 'off')
      .expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(false);
    expect(off.headers['x-workflow-id']).toMatch(/^hotel-offers-delhi--/);
    expect(Object.keys(off.body[0])).toEqual(['name', 'price', 'supplier', 'commissionPct']);
  });

  it('ignores X-Coalescing: off without the token or with a wrong one', async () => {
    await api.get('/api/hotels?city=delhi').set('x-coalescing', 'off').expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(true);
    await api
      .get('/api/hotels?city=delhi')
      .set('x-coalescing', 'off')
      .set('x-admin-token', 'wrong-token-0123456789')
      .expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(true);
  });

  it('x-benchmark: 1 bypasses the rate limit only with a valid token', async () => {
    const limited = await startTestApp({ RATE_LIMIT_MAX: '3', ADMIN_TOKEN: TOKEN });
    try {
      const rl = request(limited.baseUrl);
      for (let i = 0; i < 5; i++) {
        await rl
          .get('/api/hotels?city=goa')
          .set('x-benchmark', '1')
          .set('x-admin-token', TOKEN)
          .expect(200);
      }
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await rl.get('/api/hotels?city=goa').set('x-benchmark', '1')).status);
      }
      expect(statuses).toContain(429);
    } finally {
      await limited.close();
    }
  });
});

describe('Coalescing benchmark without ADMIN_TOKEN configured', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ RATE_LIMIT_MAX: '2' });
  });
  afterAll(() => t.close());

  it('never honours the override or the rate-limit bypass (a valid token is mandatory)', async () => {
    const api = request(t.baseUrl);
    await api
      .get('/api/hotels?city=delhi')
      .set('x-coalescing', 'off')
      .set('x-benchmark', '1')
      .expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(true);
    await api.get('/api/hotels?city=delhi').set('x-benchmark', '1').expect(200);
    await api.get('/api/hotels?city=delhi').set('x-benchmark', '1').expect(429);
  });
});

describe('Coalescing benchmark under NODE_ENV=production', () => {
  it('disables the override entirely, even with a valid token', async () => {
    const t = await startTestApp({
      NODE_ENV: 'production',
      ADMIN_TOKEN: TOKEN,
      RATE_LIMIT_MAX: '2',
    });
    try {
      const api = request(t.baseUrl);
      await api
        .get('/api/hotels?city=delhi')
        .set('x-coalescing', 'off')
        .set('x-admin-token', TOKEN)
        .expect(200);
      expect(t.runner.lastInput?.coalesce).toBe(true);
      await api
        .get('/api/hotels?city=delhi')
        .set('x-benchmark', '1')
        .set('x-admin-token', TOKEN)
        .expect(200);
      await api
        .get('/api/hotels?city=delhi')
        .set('x-benchmark', '1')
        .set('x-admin-token', TOKEN)
        .expect(429);
    } finally {
      await t.close();
    }
  });

  it('re-enables it only with ALLOW_COALESCING_OVERRIDE=true (and still needs the token)', async () => {
    const t = await startTestApp({
      NODE_ENV: 'production',
      ADMIN_TOKEN: TOKEN,
      ALLOW_COALESCING_OVERRIDE: 'true',
    });
    try {
      const api = request(t.baseUrl);
      await api.get('/api/hotels?city=delhi').set('x-coalescing', 'off').expect(200);
      expect(t.runner.lastInput?.coalesce).toBe(true);
      await api
        .get('/api/hotels?city=delhi')
        .set('x-coalescing', 'off')
        .set('x-admin-token', TOKEN)
        .expect(200);
      expect(t.runner.lastInput?.coalesce).toBe(false);
    } finally {
      await t.close();
    }
  });
});

describe('Coalescing benchmark with FEATURE_BENCHMARK=false (v1 behaviour)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ FEATURE_BENCHMARK: 'false', RATE_LIMIT_MAX: '2', ADMIN_TOKEN: TOKEN });
  });
  afterAll(() => t.close());

  it('has no metrics endpoints, no override and no rate-limit bypass', async () => {
    const api = request(t.baseUrl);
    await api.get('/admin/metrics/suppliers').set('x-admin-token', TOKEN).expect(404);
    await api.get('/api/hotels?city=delhi').expect(200); // 1 of 2 allowed
    await api
      .get('/api/hotels?city=delhi')
      .set('x-coalescing', 'off')
      .set('x-admin-token', TOKEN)
      .expect(200);
    expect(t.runner.lastInput?.coalesce).toBe(true);
    await api
      .get('/api/hotels?city=delhi')
      .set('x-benchmark', '1')
      .set('x-admin-token', TOKEN)
      .expect(429);
  });
});
