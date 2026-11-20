import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

/** Random letters so the hour-long parser cache never leaks between test runs. */
const tag = (): string =>
  Array.from({ length: 8 }, () => 'abcdefghij'[Math.floor(Math.random() * 10)]).join('');

describe('Enhancement 4: POST /api/hotels/ask (LLM_PROVIDER=none → rules parser)', () => {
  let t: TestApp;
  let api: ReturnType<typeof request>;

  beforeAll(async () => {
    t = await startTestApp();
    api = request(t.baseUrl);
  });
  beforeEach(async () => {
    await t.repository.deleteCity('delhi');
  });
  afterAll(() => t.close());

  it('interprets the query and reuses the GET service (Redis filter)', async () => {
    const res = await api
      .post('/api/hotels/ask')
      .send({ query: `hotels in Delhi between 5k and 9k ${tag()}` })
      .expect(200);
    expect(res.body).toEqual({
      query: expect.stringContaining('hotels in Delhi between 5k and 9k'),
      interpretedAs: { city: 'delhi', minPrice: 5000, maxPrice: 9000 },
      parser: 'rules',
      results: [
        { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
        { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
        { name: 'Hyatt Regency', price: 8400, supplier: 'Supplier B', commissionPct: 16 },
      ],
    });
    expect(res.headers['x-parser']).toBe('rules');
    expect(res.headers['x-workflow-id']).toBe('hotel-offers-delhi');
  });

  it('caches the interpretation by query hash', async () => {
    const query = `cheap hotels in goa under 6k ${tag()}`;
    expect((await api.post('/api/hotels/ask').send({ query })).headers['x-parser-cache']).toBe(
      'MISS',
    );
    expect((await api.post('/api/hotels/ask').send({ query })).headers['x-parser-cache']).toBe(
      'HIT',
    );
  });

  it('runs the unfiltered path when no price is given', async () => {
    const res = await api
      .post('/api/hotels/ask')
      .send({ query: `everything in delhi ${tag()}` })
      .expect(200);
    expect(res.body.interpretedAs).toEqual({ city: 'delhi', minPrice: null, maxPrice: null });
    expect(res.body.results).toHaveLength(7);
  });

  it('returns 422 with examples when no city can be found', async () => {
    const res = await api
      .post('/api/hotels/ask')
      .send({ query: `cheap hotels under 5k ${tag()}` })
      .expect(422);
    expect(res.body.error.code).toBe('UNPROCESSABLE_QUERY');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('validates the body (missing, too long, unknown fields)', async () => {
    await api.post('/api/hotels/ask').send({}).expect(400);
    await api
      .post('/api/hotels/ask')
      .send({ query: 'x'.repeat(301) })
      .expect(400);
    await api.post('/api/hotels/ask').send({ query: 'delhi', extra: 1 }).expect(400);
  });
});

describe('Enhancement 4 with FEATURE_ASK=false (v1 behaviour)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ FEATURE_ASK: 'false' });
  });
  afterAll(() => t.close());

  it('has no /api/hotels/ask', async () => {
    await request(t.baseUrl).post('/api/hotels/ask').send({ query: 'delhi' }).expect(404);
  });
});
