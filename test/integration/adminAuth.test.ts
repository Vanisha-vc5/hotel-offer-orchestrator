/**
 * Production access control for /admin/*: one check per route group.
 * Every group must reject a missing or wrong token and accept the right one, and
 * /admin must stay closed in production even if no ADMIN_TOKEN was configured.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

const TOKEN = 'prod-admin-token-0123456789abcdef';

type Method = 'get' | 'post' | 'delete';
const ROUTE_GROUPS: Array<[group: string, method: Method, path: string]> = [
  ['chaos', 'get', '/admin/chaos'],
  ['chaos (mutating)', 'post', '/admin/chaos/suppliers/B'],
  ['cache', 'delete', '/admin/cache/delhi'],
  ['supplier metrics', 'get', '/admin/metrics/suppliers'],
  ['circuits', 'get', '/admin/circuits'],
  ['monitor', 'post', '/admin/monitor/probe-now'],
  ['warm-up', 'get', '/admin/warmup'],
  ['warm-up (trigger)', 'post', '/admin/warmup/run-now'],
];

function send(api: ReturnType<typeof request>, method: Method, path: string, token?: string) {
  const r = api[method](path);
  if (token) r.set('x-admin-token', token);
  return method === 'post' && path.includes('/chaos/') ? r.send({ mode: 'up' }) : r;
}

describe('/admin/* in production with ADMIN_TOKEN set', () => {
  let t: TestApp;
  let api: ReturnType<typeof request>;
  beforeAll(async () => {
    t = await startTestApp({
      NODE_ENV: 'production',
      ADMIN_TOKEN: TOKEN,
      REQUIRE_ADMIN_TOKEN: 'true',
    });
    api = request(t.baseUrl);
  });
  afterAll(() => t.close());

  it.each(ROUTE_GROUPS)(
    '%s: 401 without / with a wrong token, 2xx with the token',
    async (_g, method, path) => {
      const missing = await send(api, method, path);
      expect(missing.status).toBe(401);
      expect(missing.body.error.code).toBe('UNAUTHORIZED');
      expect((await send(api, method, path, 'x'.repeat(TOKEN.length))).status).toBe(401);
      const ok = await send(api, method, path, TOKEN);
      expect(ok.status).toBeGreaterThanOrEqual(200);
      expect(ok.status).toBeLessThan(300);
    },
  );
});

describe('/admin/* in production WITHOUT ADMIN_TOKEN (misconfiguration)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ NODE_ENV: 'production' });
  });
  afterAll(() => t.close());

  it.each(ROUTE_GROUPS)('%s: fails closed with 401', async (_g, method, path) => {
    expect((await send(request(t.baseUrl), method, path, 'anything')).status).toBe(401);
  });
});

describe('/admin/* in production without ADMIN_TOKEN but ALLOW_OPEN_ADMIN=true (local demo stack)', () => {
  it('is open only because it was explicitly allowed', async () => {
    const t = await startTestApp({ NODE_ENV: 'production', ALLOW_OPEN_ADMIN: 'true' });
    try {
      await request(t.baseUrl).get('/admin/chaos').expect(200);
    } finally {
      await t.close();
    }
  });
});

describe('/admin/* in development without ADMIN_TOKEN', () => {
  it('stays open for local demos (unchanged v1 behaviour)', async () => {
    const t = await startTestApp();
    try {
      await request(t.baseUrl).get('/admin/chaos').expect(200);
    } finally {
      await t.close();
    }
  });
});
