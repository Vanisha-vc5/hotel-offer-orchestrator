/** Smoke checks for any deployment of the API (used by `npm run smoke` and its test). */

/** The graded responses, byte-for-byte (same values as test/integration/contract.guard.test.ts). */
export const EXPECTED_DELHI =
  '[' +
  '{"name":"Ibis","price":2900,"supplier":"Supplier B","commissionPct":9},' +
  '{"name":"Lemon Tree","price":3200,"supplier":"Supplier A","commissionPct":8},' +
  '{"name":"Holtin","price":5340,"supplier":"Supplier B","commissionPct":20},' +
  '{"name":"Radison","price":5900,"supplier":"Supplier A","commissionPct":13},' +
  '{"name":"Hyatt Regency","price":8400,"supplier":"Supplier B","commissionPct":16},' +
  '{"name":"The Leela","price":9800,"supplier":"Supplier A","commissionPct":12},' +
  '{"name":"Taj Palace","price":11900,"supplier":"Supplier B","commissionPct":18}' +
  ']';

export const EXPECTED_FILTERED =
  '[' +
  '{"name":"Holtin","price":5340,"supplier":"Supplier B","commissionPct":20},' +
  '{"name":"Radison","price":5900,"supplier":"Supplier A","commissionPct":13},' +
  '{"name":"Hyatt Regency","price":8400,"supplier":"Supplier B","commissionPct":16}' +
  ']';

const REQUIRED_HEADERS = [
  'x-request-id',
  'x-workflow-id',
  'x-suppliers-status',
  'x-result-status',
  'x-cache',
];

export interface SmokeResult {
  check: string;
  ok: boolean;
  ms: number;
  detail: string;
}

type Check = () => Promise<string>;

async function get(base: string, p: string): Promise<{ res: Response; text: string; ms: number }> {
  const started = performance.now();
  const res = await fetch(new URL(p, base), { signal: AbortSignal.timeout(45_000) });
  const text = await res.text();
  return { res, text, ms: Math.round(performance.now() - started) };
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

export async function runSmoke(baseUrl: string): Promise<SmokeResult[]> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const checks: Array<[string, Check]> = [
    [
      'GET /health',
      async () => {
        const { res, text } = await get(base, 'health');
        const body = JSON.parse(text) as {
          status: string;
          dependencies: Record<string, { status: string }>;
        };
        assert(res.status === 200, `HTTP ${res.status} (status ${body.status})`);
        assert(body.status === 'up', `status is "${body.status}", expected "up"`);
        for (const d of ['supplierA', 'supplierB', 'redis', 'temporal']) {
          assert(body.dependencies[d]?.status === 'up', `${d} is ${body.dependencies[d]?.status}`);
        }
        return 'up (suppliers, redis, temporal)';
      },
    ],
    [
      'GET /api/hotels?city=delhi (exact 7-hotel contract)',
      async () => {
        const { res, text } = await get(base, 'api/hotels?city=delhi');
        assert(res.status === 200, `HTTP ${res.status}`);
        assert((res.headers.get('content-type') ?? '').startsWith('application/json'), 'not JSON');
        assert(text === EXPECTED_DELHI, `body differs from the contract: ${text.slice(0, 120)}…`);
        for (const h of REQUIRED_HEADERS) assert(!!res.headers.get(h), `missing header ${h}`);
        assert(
          res.headers.get('x-result-status') === 'complete',
          `result ${res.headers.get('x-result-status')}`,
        );
        return `7 hotels, byte-exact; workflow ${res.headers.get('x-workflow-id')}`;
      },
    ],
    [
      'GET /api/hotels?city=delhi&minPrice=5000&maxPrice=9000',
      async () => {
        const { res, text } = await get(base, 'api/hotels?city=delhi&minPrice=5000&maxPrice=9000');
        assert(res.status === 200, `HTTP ${res.status}`);
        assert(text === EXPECTED_FILTERED, `body differs: ${text.slice(0, 120)}…`);
        return `3 hotels, byte-exact; X-Cache ${res.headers.get('x-cache')}`;
      },
    ],
    [
      'GET /console/',
      async () => {
        const { res, text } = await get(base, 'console/');
        assert(res.status === 200, `HTTP ${res.status}`);
        assert(text.includes('Hotel Offer Orchestrator'), 'unexpected page');
        return 'ops console served';
      },
    ],
    [
      'GET /docs/',
      async () => {
        const { res, text } = await get(base, 'docs/');
        assert(res.status === 200, `HTTP ${res.status}`);
        assert(/swagger/i.test(text), 'Swagger UI not found');
        return 'Swagger UI served';
      },
    ],
  ];

  const results: SmokeResult[] = [];
  for (const [check, fn] of checks) {
    const started = performance.now();
    try {
      const detail = await fn(); // await first, so `ms` includes the request
      results.push({ check, ok: true, ms: Math.round(performance.now() - started), detail });
    } catch (err) {
      results.push({
        check,
        ok: false,
        ms: Math.round(performance.now() - started),
        detail: (err as Error).message,
      });
    }
  }
  return results;
}
