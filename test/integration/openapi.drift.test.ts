/**
 * Keeps /docs honest: every implemented route is documented, and the documented
 * examples and headers match what the running API actually returns.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openApiDocument } from '../../src/api/openapi';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

type Paths = Record<string, Record<string, { responses?: Record<string, unknown> }>>;
const paths = openApiDocument.paths as unknown as Paths;

/** Every route the Express app serves (method, path as documented). */
const IMPLEMENTED: Array<[string, string]> = [
  ['get', '/api/hotels'],
  ['post', '/api/hotels/ask'],
  ['get', '/api/hotels/insights'],
  ['get', '/health'],
  ['get', '/health/live'],
  ['get', '/health/ready'],
  ['get', '/supplierA/hotels'],
  ['get', '/supplierB/hotels'],
  ['get', '/admin/chaos'],
  ['delete', '/admin/chaos'],
  ['post', '/admin/chaos/suppliers/{supplier}'],
  ['delete', '/admin/cache/{city}'],
  ['get', '/admin/metrics/suppliers'],
  ['delete', '/admin/metrics/suppliers'],
  ['get', '/admin/circuits'],
  ['post', '/admin/monitor/probe-now'],
  ['get', '/admin/warmup'],
  ['post', '/admin/warmup/run-now'],
];

function example(path: string, name: string): unknown {
  const content = (
    paths[path]?.get?.responses?.['200'] as {
      content: { 'application/json': { examples: Record<string, { value: unknown }> } };
    }
  ).content['application/json'];
  return content.examples[name]?.value;
}

describe('OpenAPI document vs implementation', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
    await t.repository.deleteCity('delhi');
  });
  afterAll(() => t.close());

  it.each(IMPLEMENTED)('documents %s %s', (method, path) => {
    expect(
      paths[path]?.[method],
      `${method.toUpperCase()} ${path} missing from openapi.ts`,
    ).toBeDefined();
  });

  it('the documented delhi example is exactly what the API returns', async () => {
    const res = await request(t.baseUrl).get('/api/hotels?city=delhi').expect(200);
    expect(res.body).toEqual(example('/api/hotels', 'all'));
  });

  it('the documented filtered example is exactly what the API returns', async () => {
    const res = await request(t.baseUrl)
      .get('/api/hotels?city=delhi&minPrice=5000&maxPrice=9000')
      .expect(200);
    expect(res.body).toEqual(example('/api/hotels', 'filtered'));
  });

  it('every metadata header the API sets on /api/hotels is documented', async () => {
    const res = await request(t.baseUrl).get('/api/hotels?city=delhi').expect(200);
    const documented = Object.keys(
      (paths['/api/hotels']?.get?.responses?.['200'] as { headers: Record<string, unknown> })
        .headers,
    ).map((h) => h.toLowerCase());
    const emitted = Object.keys(res.headers).filter(
      (h) =>
        h.startsWith('x-') &&
        !h.startsWith('x-content') &&
        ![
          'x-dns-prefetch-control',
          'x-download-options',
          'x-frame-options',
          'x-permitted-cross-domain-policies',
          'x-xss-protection',
        ].includes(h),
    );
    for (const h of emitted) expect(documented, `header ${h} not documented`).toContain(h);
  });

  it('documents every status code the hotels endpoint can return', () => {
    const codes = Object.keys(paths['/api/hotels']?.get?.responses ?? {});
    expect(codes).toEqual(expect.arrayContaining(['200', '400', '429', '503', '504']));
  });
});
