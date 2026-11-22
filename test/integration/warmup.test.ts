import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

describe('Cache warm-up: admin routes (FEATURE_WARMUP=true)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ WARMUP_CITIES: 'delhi,goa' });
  });
  afterAll(() => t.close());

  it('exposes GET /admin/warmup and POST /admin/warmup/run-now', async () => {
    const api = request(t.baseUrl);
    expect((await api.get('/admin/warmup').expect(200)).body).toMatchObject({
      scheduleId: 'cache-warmup',
      cities: ['delhi', 'goa'],
    });
    const run = await api.post('/admin/warmup/run-now').expect(200);
    expect(run.body).toMatchObject({ triggered: true });
    expect(t.warmupControl.runs).toBe(1);
  });

  it('DELETE /admin/chaos also clears the warm-up cities caches', async () => {
    const api = request(t.baseUrl);
    await api.get('/api/hotels?city=delhi&minPrice=1').expect(200);
    await api.get('/api/hotels?city=goa&minPrice=1').expect(200);
    await api.get('/api/hotels?city=mumbai&minPrice=1').expect(200); // not a warm-up city
    await api.delete('/admin/chaos').expect(200);
    expect((await api.get('/api/hotels?city=delhi&minPrice=1')).headers['x-cache']).toBe('MISS');
    expect((await api.get('/api/hotels?city=goa&minPrice=1')).headers['x-cache']).toBe('MISS');
    expect((await api.get('/api/hotels?city=mumbai&minPrice=1')).headers['x-cache']).toBe('HIT');
    await t.repository.deleteCity('mumbai');
  });
});

describe('Cache warm-up with FEATURE_WARMUP=false (v1 behaviour)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ FEATURE_WARMUP: 'false' });
  });
  afterAll(() => t.close());

  it('has no warm-up routes and chaos reset leaves caches alone', async () => {
    const api = request(t.baseUrl);
    await api.get('/admin/warmup').expect(404);
    await api.post('/admin/warmup/run-now').expect(404);
    await api.get('/api/hotels?city=delhi&minPrice=1').expect(200);
    await api.delete('/admin/chaos').expect(200);
    expect((await api.get('/api/hotels?city=delhi&minPrice=1')).headers['x-cache']).toBe('HIT');
    await t.repository.deleteCity('delhi');
  });
});
