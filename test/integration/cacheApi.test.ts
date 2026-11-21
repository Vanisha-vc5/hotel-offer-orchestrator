/**
 * Cache behaviour through the HTTP API: supplier failures never delete or degrade
 * a valid cache, cached empty results avoid supplier calls, and the headers always
 * describe the data actually served. The 4-key body contract is unchanged throughout.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

const KEYS = ['name', 'price', 'supplier', 'commissionPct'];

describe('cache behaviour via the API', () => {
  let t: TestApp;
  let api: ReturnType<typeof request>;
  beforeAll(async () => {
    t = await startTestApp();
    api = request(t.baseUrl);
  });
  beforeEach(async () => {
    t.runner.mode = 'ok';
    t.runner.calls = 0;
    for (const c of ['delhi', 'atlantis']) await t.repository.deleteCity(c);
  });
  afterAll(() => t.close());

  it('both suppliers down: 503 for the fresh request, and the cached data survives', async () => {
    await api.get('/api/hotels?city=delhi').expect(200); // primes a complete cache
    t.runner.mode = 'both-down';
    const down = await api.get('/api/hotels?city=delhi').expect(503);
    expect(down.body.error.code).toBe('SUPPLIERS_UNAVAILABLE');

    const cached = await api.get('/api/hotels?city=delhi&minPrice=0').expect(200);
    expect(cached.headers['x-cache']).toBe('HIT');
    expect(cached.headers['x-result-status']).toBe('complete');
    expect(cached.body).toHaveLength(7);
  });

  it('one supplier down: the fresh response is partial, but the complete cache is kept', async () => {
    await api.get('/api/hotels?city=delhi').expect(200);
    t.runner.mode = 'B-down';
    const fresh = await api.get('/api/hotels?city=delhi').expect(200);
    expect(fresh.headers['x-result-status']).toBe('partial'); // unchanged partial-result contract
    expect(fresh.body).toHaveLength(6);

    const filtered = await api.get('/api/hotels?city=delhi&minPrice=0').expect(200);
    expect(filtered.headers).toMatchObject({ 'x-cache': 'HIT', 'x-result-status': 'complete' });
    expect(filtered.body).toHaveLength(7);
  });

  it('refresh=true during a partial outage: headers describe the (complete) data actually served', async () => {
    await api.get('/api/hotels?city=delhi').expect(200);
    t.runner.mode = 'B-down';
    const res = await api
      .get('/api/hotels?city=delhi&minPrice=5000&maxPrice=9000&refresh=true')
      .expect(200);
    expect(t.runner.calls).toBe(2); // the refresh really ran
    expect(res.headers).toMatchObject({
      'x-cache': 'HIT', // served from the entry the partial run was not allowed to replace
      'x-result-status': 'complete',
      'x-suppliers-status': 'A=up;B=up',
    });
    expect(res.body.map((o: { name: string }) => o.name)).toEqual([
      'Holtin',
      'Radison',
      'Hyatt Regency',
    ]);
  });

  it('a partial result fills an empty cache (short TTL) and is reported as partial', async () => {
    t.runner.mode = 'B-down';
    const res = await api.get('/api/hotels?city=delhi&minPrice=0').expect(200);
    expect(res.headers).toMatchObject({ 'x-cache': 'MISS', 'x-result-status': 'partial' });
    expect(await t.repository.ttl('delhi')).toBeLessThanOrEqual(30);
  });

  it('a cached empty result is served without running the workflow again', async () => {
    await api.get('/api/hotels?city=atlantis&minPrice=0').expect(200);
    const calls = t.runner.calls;
    for (let i = 0; i < 3; i++) {
      const res = await api.get('/api/hotels?city=atlantis&minPrice=0').expect(200);
      expect(res.body).toEqual([]);
      expect(res.headers['x-cache']).toBe('HIT');
    }
    expect(t.runner.calls).toBe(calls);
  });

  it('X-Coalesced is reported for workflow-backed responses, not for cache hits', async () => {
    const fresh = await api.get('/api/hotels?city=delhi').expect(200);
    expect(fresh.headers['x-coalesced']).toBe('false');
    const hit = await api.get('/api/hotels?city=delhi&minPrice=0').expect(200);
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.headers['x-coalesced']).toBeUndefined();
    for (const o of fresh.body) expect(Object.keys(o)).toEqual(KEYS);
  });
});
