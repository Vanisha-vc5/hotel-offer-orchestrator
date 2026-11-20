import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { HealthService } from '../../src/api/services/healthService';
import { HotelService } from '../../src/api/services/hotelService';
import { loadConfig } from '../../src/infra/config';
import { ChaosStore } from '../../src/mocks/chaos';
import { deadRedisRepository, startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

const CONTRACT_KEYS = ['name', 'price', 'supplier', 'commissionPct'];
const DELHI = [
  ['Ibis', 2900, 'Supplier B', 9],
  ['Lemon Tree', 3200, 'Supplier A', 8],
  ['Holtin', 5340, 'Supplier B', 20],
  ['Radison', 5900, 'Supplier A', 13],
  ['Hyatt Regency', 8400, 'Supplier B', 16],
  ['The Leela', 9800, 'Supplier A', 12],
  ['Taj Palace', 11900, 'Supplier B', 18],
].map(([name, price, supplier, commissionPct]) => ({ name, price, supplier, commissionPct }));

type Offer = { name: string; price: number; supplier: string; commissionPct: number };
const names = (body: Offer[]): string[] => body.map((o) => o.name);

describe('HTTP API', () => {
  let t: TestApp;
  let api: ReturnType<typeof request>;

  beforeAll(async () => {
    t = await startTestApp();
    api = request(t.baseUrl);
  });
  beforeEach(async () => {
    t.runner.mode = 'ok';
    t.runner.calls = 0;
    t.temporalUp.value = true;
    await t.chaos.reset();
    for (const c of ['delhi', 'goa', 'atlantis', 'new delhi']) await t.repository.deleteCity(c);
  });
  afterAll(() => t.close());

  describe('GET /api/hotels (contract)', () => {
    it('returns a bare array of exactly-4-key offers, sorted by price', async () => {
      const res = await api.get('/api/hotels?city=delhi').expect(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toEqual(DELHI);
      for (const item of res.body as Offer[]) expect(Object.keys(item)).toEqual(CONTRACT_KEYS);
      const prices = (res.body as Offer[]).map((o) => o.price);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    });

    it('sets all metadata headers (and only headers)', async () => {
      const res = await api.get('/api/hotels?city=delhi').expect(200);
      expect(res.headers['x-request-id']).toBeTruthy();
      expect(res.headers['x-workflow-id']).toBe('hotel-offers-delhi');
      expect(res.headers['x-workflow-run-id']).toBeTruthy();
      expect(res.headers['x-suppliers-status']).toBe('A=up;B=up');
      expect(res.headers['x-result-status']).toBe('complete');
      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.headers['x-response-time']).toMatch(/^\d+(\.\d+)?ms$/);
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('always runs the workflow for the unfiltered endpoint', async () => {
      await api.get('/api/hotels?city=delhi').expect(200);
      await api.get('/api/hotels?city=delhi').expect(200);
      expect(t.runner.calls).toBe(2);
    });

    it('normalises the city (case, surrounding and inner whitespace)', async () => {
      const res = await api.get('/api/hotels').query({ city: '  DeLHI ' }).expect(200);
      expect(res.body).toEqual(DELHI);
      expect(res.headers['x-workflow-id']).toBe('hotel-offers-delhi');
    });

    it('echoes a caller-supplied X-Request-Id', async () => {
      const res = await api
        .get('/api/hotels?city=delhi')
        .set('X-Request-Id', 'trace-123')
        .expect(200);
      expect(res.headers['x-request-id']).toBe('trace-123');
    });

    it('returns only Supplier A hotels for a single-supplier city', async () => {
      const res = await api.get('/api/hotels?city=goa').expect(200);
      expect(res.body).toHaveLength(3);
      expect((res.body as Offer[]).every((o) => o.supplier === 'Supplier A')).toBe(true);
    });

    it('returns 200 [] for a valid city with no hotels', async () => {
      const res = await api.get('/api/hotels?city=atlantis').expect(200);
      expect(res.body).toEqual([]);
    });

    it('returns a partial result when one supplier is down', async () => {
      t.runner.mode = 'B-down';
      const res = await api.get('/api/hotels?city=delhi').expect(200);
      expect(res.headers['x-result-status']).toBe('partial');
      expect(res.headers['x-suppliers-status']).toBe('A=up;B=down');
      expect(res.body).toHaveLength(6);
      expect((res.body as Offer[]).every((o) => o.supplier === 'Supplier A')).toBe(true);
    });
  });

  describe('GET /api/hotels with price filter (Redis)', () => {
    it('MISS runs the workflow, then an identical call is a HIT', async () => {
      const first = await api.get('/api/hotels?city=delhi&minPrice=5000&maxPrice=9000').expect(200);
      expect(first.headers['x-cache']).toBe('MISS');
      expect(names(first.body)).toEqual(['Holtin', 'Radison', 'Hyatt Regency']);

      const second = await api
        .get('/api/hotels?city=delhi&minPrice=5000&maxPrice=9000')
        .expect(200);
      expect(second.headers['x-cache']).toBe('HIT');
      expect(second.body).toEqual(first.body);
      expect(second.headers['x-workflow-id']).toBe('hotel-offers-delhi');
      expect(t.runner.calls).toBe(1);
      for (const item of second.body as Offer[]) expect(Object.keys(item)).toEqual(CONTRACT_KEYS);
    });

    it('supports open-ended and inclusive ranges', async () => {
      expect(names((await api.get('/api/hotels?city=delhi&minPrice=9000')).body)).toEqual([
        'The Leela',
        'Taj Palace',
      ]);
      expect(names((await api.get('/api/hotels?city=delhi&maxPrice=3000')).body)).toEqual(['Ibis']);
      expect(
        names((await api.get('/api/hotels?city=delhi&minPrice=5340&maxPrice=5340')).body),
      ).toEqual(['Holtin']);
      expect((await api.get('/api/hotels?city=delhi&minPrice=20000')).body).toEqual([]);
    });

    it('refresh=true forces a new workflow run before filtering', async () => {
      await api.get('/api/hotels?city=delhi&minPrice=0').expect(200);
      const res = await api.get('/api/hotels?city=delhi&minPrice=0&refresh=true').expect(200);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(t.runner.calls).toBe(2);
    });

    it('serves a cached empty city as a HIT', async () => {
      await api.get('/api/hotels?city=atlantis&minPrice=1').expect(200);
      const res = await api.get('/api/hotels?city=atlantis&minPrice=1').expect(200);
      expect(res.headers['x-cache']).toBe('HIT');
      expect(res.body).toEqual([]);
    });
  });

  describe('validation (400)', () => {
    const cases: Array<[string, string]> = [
      ['missing city', '/api/hotels'],
      ['empty city', '/api/hotels?city=%20%20'],
      ['invalid characters', '/api/hotels?city=delhi1'],
      ['too long', `/api/hotels?city=${'a'.repeat(51)}`],
      ['non-numeric minPrice', '/api/hotels?city=delhi&minPrice=abc'],
      ['negative price', '/api/hotels?city=delhi&maxPrice=-1'],
      ['infinite price', '/api/hotels?city=delhi&maxPrice=Infinity'],
      ['minPrice > maxPrice', '/api/hotels?city=delhi&minPrice=9000&maxPrice=5000'],
      ['unknown parameter', '/api/hotels?city=delhi&sort=desc'],
      ['repeated parameter', '/api/hotels?city=delhi&city=goa'],
      ['bad refresh flag', '/api/hotels?city=delhi&minPrice=1&refresh=maybe'],
    ];
    it.each(cases)('%s', async (_label, url) => {
      const res = await api.get(url).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
      expect(Array.isArray(res.body.error.details)).toBe(true);
      expect(res.body.error.stack).toBeUndefined();
      expect(t.runner.calls).toBe(0);
    });

    it('explains minPrice > maxPrice', async () => {
      const res = await api.get('/api/hotels?city=delhi&minPrice=9000&maxPrice=5000');
      expect(res.body.error.details).toContainEqual({
        path: 'minPrice',
        message: 'minPrice must be <= maxPrice',
      });
    });
  });

  describe('error mapping', () => {
    it('both suppliers down → 503 SUPPLIERS_UNAVAILABLE (not [])', async () => {
      t.runner.mode = 'both-down';
      const res = await api.get('/api/hotels?city=delhi').expect(503);
      expect(res.body.error.code).toBe('SUPPLIERS_UNAVAILABLE');
      expect(res.headers['x-response-time']).toBeTruthy();
    });

    it('Temporal unreachable → 503 TEMPORAL_UNAVAILABLE', async () => {
      t.runner.mode = 'temporal-down';
      const res = await api.get('/api/hotels?city=delhi').expect(503);
      expect(res.body.error.code).toBe('TEMPORAL_UNAVAILABLE');
    });

    it('workflow timeout → 504 WORKFLOW_TIMEOUT', async () => {
      t.runner.mode = 'timeout';
      const res = await api.get('/api/hotels?city=delhi').expect(504);
      expect(res.body.error.code).toBe('WORKFLOW_TIMEOUT');
    });

    it('unknown route → 404 JSON', async () => {
      const res = await api.get('/nope').expect(404);
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', details: [] });
    });
  });

  describe('GET /api/hotels/insights', () => {
    it('explains every winner with reason and savings', async () => {
      const res = await api.get('/api/hotels/insights?city=delhi').expect(200);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.body.summary).toEqual({
        hotels: 7,
        overlapping: 5,
        singleSource: 2,
        winsBySupplier: { 'Supplier A': 3, 'Supplier B': 4 },
        reasons: { cheaper: 4, tie_higher_commission: 1, tie_default: 0, single_source: 2 },
        totalSavings: 1910,
        avgWinnerCommissionPct: 13.71,
      });
      const hyatt = (res.body.hotels as Array<{ name: string }>).find(
        (h) => h.name === 'Hyatt Regency',
      );
      expect(hyatt).toMatchObject({
        winner: { supplier: 'Supplier B', price: 8400, commissionPct: 16 },
        reason: 'tie_higher_commission',
      });

      const again = await api.get('/api/hotels/insights?city=delhi').expect(200);
      expect(again.headers['x-cache']).toBe('HIT');
    });
  });

  describe('health', () => {
    it('GET /health is up when everything is up', async () => {
      const res = await api.get('/health').expect(200);
      expect(res.body).toMatchObject({
        status: 'up',
        version: '1.0.0',
        dependencies: {
          supplierA: { status: 'up' },
          supplierB: { status: 'up' },
          redis: { status: 'up' },
          temporal: { status: 'up' },
        },
      });
      expect(typeof res.body.dependencies.supplierA.latencyMs).toBe('number');
    });

    it('is degraded (200) with one supplier down, down (503) with both', async () => {
      await t.chaos.set('B', { mode: 'down' });
      const degraded = await api.get('/health').expect(200);
      expect(degraded.body.status).toBe('degraded');
      expect(degraded.body.dependencies.supplierB).toMatchObject({
        status: 'down',
        error: 'HTTP 503',
      });

      await t.chaos.set('A', { mode: 'down' });
      expect((await api.get('/health').expect(503)).body.status).toBe('down');
    });

    it('reports a slow supplier as a timeout', async () => {
      await t.chaos.set('A', { mode: 'slow', latencyMs: 2000 });
      const res = await api.get('/health').expect(200);
      expect(res.body.dependencies.supplierA).toMatchObject({
        status: 'down',
        error: 'timeout after 500ms',
      });
    });

    it('is down (503) when Temporal is unreachable; ready fails too', async () => {
      t.temporalUp.value = false;
      expect((await api.get('/health').expect(503)).body.dependencies.temporal.status).toBe('down');
      expect((await api.get('/health/ready').expect(503)).body.status).toBe('down');
    });

    it('live and ready', async () => {
      expect((await api.get('/health/live').expect(200)).body).toEqual({ status: 'up' });
      expect((await api.get('/health/ready').expect(200)).body.status).toBe('up');
    });
  });

  describe('mock suppliers + chaos admin', () => {
    it('serves supplier data, filtered case-insensitively', async () => {
      const all = await api.get('/supplierA/hotels').expect(200);
      expect(all.body.length).toBeGreaterThan(6);
      const delhi = await api.get('/supplierB/hotels?city=DELHI').expect(200);
      expect(delhi.body).toHaveLength(6);
    });

    it('sets, reads and resets chaos modes', async () => {
      await api.post('/admin/chaos/suppliers/B').send({ mode: 'down' }).expect(200);
      await api.get('/supplierB/hotels').expect(503);
      expect((await api.get('/admin/chaos')).body.B).toEqual({ mode: 'down', latencyMs: 0 });

      await api.post('/admin/chaos/suppliers/A').send({ mode: 'flaky' }).expect(200);
      await api.get('/supplierA/hotels').expect(500);
      await api.get('/supplierA/hotels').expect(500);
      await api.get('/supplierA/hotels').expect(200);

      const reset = await api.delete('/admin/chaos').expect(200);
      expect(reset.body).toEqual({
        A: { mode: 'up', latencyMs: 0 },
        B: { mode: 'up', latencyMs: 0 },
      });
    });

    it('validates chaos input', async () => {
      await api.post('/admin/chaos/suppliers/C').send({ mode: 'down' }).expect(400);
      await api.post('/admin/chaos/suppliers/A').send({ mode: 'broken' }).expect(400);
      await api.post('/admin/chaos/suppliers/A').send({ mode: 'slow', latencyMs: -1 }).expect(400);
    });

    it('clears a city cache', async () => {
      await api.get('/api/hotels?city=delhi&minPrice=0').expect(200);
      expect((await api.delete('/admin/cache/delhi').expect(200)).body).toEqual({
        city: 'delhi',
        deletedKeys: 3,
      });
      expect((await api.get('/api/hotels?city=delhi&minPrice=0')).headers['x-cache']).toBe('MISS');
    });

    it('serves OpenAPI docs', async () => {
      const spec = await api.get('/openapi.json').expect(200);
      expect(spec.body.openapi).toBe('3.0.3');
      expect(Object.keys(spec.body.paths)).toEqual(
        expect.arrayContaining(['/api/hotels', '/api/hotels/insights', '/health', '/admin/chaos']),
      );
      await api.get('/docs/').expect(200);
    });
  });
});

describe('HTTP API with ADMIN_TOKEN / chaos disabled', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ ADMIN_TOKEN: 's3cret', ENABLE_CHAOS: 'false' });
  });
  afterAll(() => t.close());

  it('requires the admin token', async () => {
    const res = await request(t.baseUrl).delete('/admin/cache/delhi').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    await request(t.baseUrl)
      .delete('/admin/cache/delhi')
      .set('x-admin-token', 's3cret')
      .expect(200);
  });

  it('hides chaos endpoints when ENABLE_CHAOS=false', async () => {
    await request(t.baseUrl).get('/admin/chaos').set('x-admin-token', 's3cret').expect(404);
  });
});

describe('HTTP API with Redis unreachable', () => {
  it('filtered request → 503 REDIS_UNAVAILABLE', async () => {
    const { repository, redis } = deadRedisRepository();
    const cfg = loadConfig({ NODE_ENV: 'test' });
    const app = createApp({
      cfg,
      repository,
      chaos: new ChaosStore(redis),
      hotelService: new HotelService(async () => {
        throw new Error('runner must not be reached');
      }, repository),
      healthService: new HealthService(cfg, repository, async () => undefined),
    });
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=1').expect(503);
    expect(res.body.error.code).toBe('REDIS_UNAVAILABLE');
    redis.disconnect();
  });
});
