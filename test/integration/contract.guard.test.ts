/**
 * CONTRACT GUARD — read before editing.
 *
 * This file freezes the graded public contract of GET /api/hotels (assignment
 * spec §4) byte-for-byte: the exact JSON text of the delhi response, the exact
 * 3-hotel filtered response, and the names of the metadata headers.
 *
 * It exists so that v2 enhancements (new endpoints, headers, fields) can never
 * silently change what the assignment grades. If this test fails, the change
 * broke the contract: fix the change, do NOT update these constants.
 *
 * The expected values are deliberately literal strings rather than Vitest
 * snapshots, because `vitest -u` would "fix" a snapshot without anyone noticing.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

const FROZEN_DELHI_BODY =
  '[' +
  '{"name":"Ibis","price":2900,"supplier":"Supplier B","commissionPct":9},' +
  '{"name":"Lemon Tree","price":3200,"supplier":"Supplier A","commissionPct":8},' +
  '{"name":"Holtin","price":5340,"supplier":"Supplier B","commissionPct":20},' +
  '{"name":"Radison","price":5900,"supplier":"Supplier A","commissionPct":13},' +
  '{"name":"Hyatt Regency","price":8400,"supplier":"Supplier B","commissionPct":16},' +
  '{"name":"The Leela","price":9800,"supplier":"Supplier A","commissionPct":12},' +
  '{"name":"Taj Palace","price":11900,"supplier":"Supplier B","commissionPct":18}' +
  ']';

const FROZEN_FILTERED_BODY =
  '[' +
  '{"name":"Holtin","price":5340,"supplier":"Supplier B","commissionPct":20},' +
  '{"name":"Radison","price":5900,"supplier":"Supplier A","commissionPct":13},' +
  '{"name":"Hyatt Regency","price":8400,"supplier":"Supplier B","commissionPct":16}' +
  ']';

/** Headers the contract promises on every successful /api/hotels response. */
const REQUIRED_HEADERS = [
  'x-request-id',
  'x-workflow-id',
  'x-suppliers-status',
  'x-result-status',
  'x-cache',
  'x-response-time',
] as const;

describe('CONTRACT GUARD: GET /api/hotels (frozen, do not update)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });
  beforeEach(async () => {
    t.runner.mode = 'ok';
    await t.chaos.reset();
    await t.repository.deleteCity('delhi');
  });
  afterAll(() => t.close());

  it('city=delhi returns exactly the frozen 7-hotel body', async () => {
    const res = await request(t.baseUrl).get('/api/hotels?city=delhi');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.text).toBe(FROZEN_DELHI_BODY);
  });

  it('city=delhi carries every required metadata header (and no x-powered-by)', async () => {
    const res = await request(t.baseUrl).get('/api/hotels?city=delhi');
    for (const name of REQUIRED_HEADERS) {
      expect(res.headers[name], `missing header ${name}`).toBeTruthy();
    }
    expect(res.headers['x-workflow-id']).toBe('hotel-offers-delhi');
    expect(res.headers['x-suppliers-status']).toBe('A=up;B=up');
    expect(res.headers['x-result-status']).toBe('complete');
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('minPrice=5000&maxPrice=9000 returns exactly the frozen 3-hotel body (MISS, then HIT)', async () => {
    const url = '/api/hotels?city=delhi&minPrice=5000&maxPrice=9000';
    const miss = await request(t.baseUrl).get(url);
    expect(miss.status).toBe(200);
    expect(miss.text).toBe(FROZEN_FILTERED_BODY);
    expect(miss.headers['x-cache']).toBe('MISS');

    const hit = await request(t.baseUrl).get(url);
    expect(hit.status).toBe(200);
    expect(hit.text).toBe(FROZEN_FILTERED_BODY);
    expect(hit.headers['x-cache']).toBe('HIT');
    for (const name of REQUIRED_HEADERS) {
      expect(hit.headers[name], `missing header ${name}`).toBeTruthy();
    }
  });

  it('keeps the frozen error shape for validation failures', async () => {
    const res = await request(t.baseUrl).get('/api/hotels');
    expect(res.status).toBe(400);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(Object.keys(res.body.error)).toEqual(['code', 'message', 'details', 'requestId']);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
