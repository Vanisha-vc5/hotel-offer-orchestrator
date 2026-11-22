import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

describe('Duplicate detection: possibleDuplicates in insights (FEATURE_DUPLICATES=true)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  beforeEach(async () => {
    await t.repository.deleteCity('jaipur');
    await t.repository.deleteCity('delhi');
  });
  afterAll(() => t.close());

  it('adds possibleDuplicates for jaipur and keeps every existing insights field', async () => {
    const res = await request(t.baseUrl).get('/api/hotels/insights?city=jaipur').expect(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('hotels');
    const dups = res.body.possibleDuplicates as Array<Record<string, unknown>>;
    expect(dups.filter((d) => d.verdict === 'likely_same')).toHaveLength(3);
    expect(dups[0]).toEqual({
      a: { name: 'Hotel Pearl Palace', supplier: 'Supplier A', price: 2600 },
      b: { name: 'Pearl Palace', supplier: 'Supplier B', price: 2500 },
      similarity: 1,
      verdict: 'likely_same',
      decidedBy: 'similarity',
      reason: expect.stringContaining('Names match'),
      potentialSavings: 100,
    });
    expect(dups.find((d) => (d.a as { name: string }).name === 'Taj Rambagh Palace')).toMatchObject(
      {
        verdict: 'uncertain',
        decidedBy: 'similarity',
      },
    );
  });

  it('caches the review in Redis meta until the data is refreshed', async () => {
    const runs = t.duplicateReviews.runs;
    await request(t.baseUrl).get('/api/hotels/insights?city=jaipur').expect(200);
    await request(t.baseUrl).get('/api/hotels/insights?city=jaipur').expect(200);
    expect(t.duplicateReviews.runs).toBe(runs + 1);

    await request(t.baseUrl).get('/api/hotels?city=jaipur').expect(200); // refresh rewrites meta
    await request(t.baseUrl).get('/api/hotels/insights?city=jaipur').expect(200);
    expect(t.duplicateReviews.runs).toBe(runs + 2);
  });

  it('reports an empty list for a city without near-duplicates', async () => {
    const res = await request(t.baseUrl).get('/api/hotels/insights?city=delhi').expect(200);
    expect(res.body.possibleDuplicates).toEqual([]);
    expect(res.body.summary.hotels).toBe(7);
  });

  it('never creates cache meta for an uncached city (that would fake a cache HIT)', async () => {
    expect(await t.repository.savePossibleDuplicates('jaipur', [])).toBe(false);
    expect(await t.repository.filterByPrice('jaipur')).toEqual({ hit: false });
  });
});

describe('Duplicate detection with FEATURE_DUPLICATES=false (v1 behaviour)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ FEATURE_DUPLICATES: 'false' });
  });
  afterAll(() => t.close());

  it('insights has no possibleDuplicates field', async () => {
    await t.repository.deleteCity('jaipur');
    const res = await request(t.baseUrl).get('/api/hotels/insights?city=jaipur').expect(200);
    expect(res.body).not.toHaveProperty('possibleDuplicates');
  });
});
