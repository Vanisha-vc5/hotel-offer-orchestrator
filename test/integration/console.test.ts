import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

describe('Ops console (FEATURE_CONSOLE=true)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ TEMPORAL_UI_URL: 'http://temporal.example:8080/' });
  });
  afterAll(() => t.close());

  it('serves the page and its assets under a strict CSP', async () => {
    const page = await request(t.baseUrl).get('/console/').expect(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toContain('Hotel Offer Orchestrator');
    expect(page.text).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr)/); // no external CDNs
    const csp = page.headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);

    await request(t.baseUrl)
      .get('/console/console.js')
      .expect(200)
      .expect('content-type', /javascript/);
    await request(t.baseUrl).get('/console/console.css').expect(200).expect('content-type', /css/);
  });

  it('exposes the page config (Temporal UI link base, enabled features)', async () => {
    const res = await request(t.baseUrl).get('/console/config.json').expect(200);
    expect(res.body).toEqual({
      temporalUiUrl: 'http://temporal.example:8080',
      namespace: 'default',
      features: { ask: true, chaos: true, monitor: true, duplicates: true },
    });
  });
});

describe('Ops console with FEATURE_CONSOLE=false (v1 behaviour)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ FEATURE_CONSOLE: 'false' });
  });
  afterAll(() => t.close());

  it('has no /console', async () => {
    await request(t.baseUrl).get('/console/').expect(404);
  });
});
