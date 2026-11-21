/** OpenAPI 3.0 document served at /docs (UI) and /openapi.json (raw). */

const errorExample = (code: string, message: string, details: unknown[] = []): object => ({
  error: { code, message, details, requestId: '4f9c7d1e-2b1a-4f0e-9a51-3c2d8e7b6a10' },
});

const errorResponse = (description: string, examples: Record<string, object>): object => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      examples: Object.fromEntries(Object.entries(examples).map(([k, v]) => [k, { value: v }])),
    },
  },
});

const delhiOffers = [
  { name: 'Ibis', price: 2900, supplier: 'Supplier B', commissionPct: 9 },
  { name: 'Lemon Tree', price: 3200, supplier: 'Supplier A', commissionPct: 8 },
  { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
  { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
  { name: 'Hyatt Regency', price: 8400, supplier: 'Supplier B', commissionPct: 16 },
  { name: 'The Leela', price: 9800, supplier: 'Supplier A', commissionPct: 12 },
  { name: 'Taj Palace', price: 11900, supplier: 'Supplier B', commissionPct: 18 },
];

const header = (description: string, example: string): object => ({
  description,
  schema: { type: 'string', example },
});

const hotelHeaders = {
  'X-Request-Id': header(
    'Request id (echoed or generated)',
    '4f9c7d1e-2b1a-4f0e-9a51-3c2d8e7b6a10',
  ),
  'X-Workflow-Id': header(
    'Temporal workflow id (find it in the Temporal UI)',
    'hotel-offers-delhi',
  ),
  'X-Workflow-Run-Id': header('Temporal run id; identical for coalesced requests', '0199a4c2-...'),
  'X-Suppliers-Status': header('Per-supplier status', 'A=up;B=down'),
  'X-Result-Status': header('complete | partial', 'complete'),
  'X-Cache': header('MISS (workflow ran) | HIT (served from Redis)', 'MISS'),
  'X-Coalesced': header(
    'Workflow-backed responses only: true when this request joined a run another request started',
    'false',
  ),
  'X-Circuit-State': header(
    'FEATURE_MONITOR: circuit breaker state per supplier',
    'A=closed;B=open',
  ),
  'X-Response-Time': header('Server-side latency', '412.3ms'),
};

const cityParam = {
  name: 'city',
  in: 'query',
  required: true,
  description:
    'Required. Trimmed, inner whitespace collapsed, lowercased; letters (any script), spaces and ' +
    'hyphens only; 1–50 characters. Invalid → 400 VALIDATION_ERROR.',
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 50,
    pattern: '^[\\p{L} -]+$',
    example: 'delhi',
  },
};

const dependency = {
  type: 'object',
  required: ['status', 'latencyMs'],
  properties: {
    status: { type: 'string', enum: ['up', 'down'] },
    latencyMs: { type: 'integer' },
    error: { type: 'string' },
  },
};

const supplierHotelsPath = (supplier: 'A' | 'B'): object => ({
  get: {
    tags: ['Mock suppliers'],
    summary: `Supplier ${supplier} inventory (mock, chaos-aware)`,
    parameters: [{ ...cityParam, required: false }],
    responses: {
      200: {
        description: 'Supplier records',
        content: {
          'application/json': {
            schema: { type: 'array', items: { $ref: '#/components/schemas/SupplierHotel' } },
            example: [
              supplier === 'A'
                ? { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 }
                : { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
            ],
          },
        },
      },
      500: { description: 'Chaos mode `flaky` (first two calls)' },
      503: { description: 'Chaos mode `down`' },
    },
  },
});

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Hotel Offer Orchestrator',
    version: '2.0.0',
    description:
      'Aggregates hotel offers from two suppliers with Temporal, picks the best offer per hotel, ' +
      'caches results in Redis and filters by price inside Redis.\n\n' +
      'All error responses share one shape: `{ "error": { code, message, details, requestId } }`.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Hotels', description: 'Public API (graded contract)' },
    { name: 'Health' },
    { name: 'Mock suppliers' },
    { name: 'Admin', description: 'Chaos controls and cache admin (x-admin-token if configured)' },
  ],
  paths: {
    '/api/hotels': {
      get: {
        tags: ['Hotels'],
        summary: 'Best offer per hotel for a city',
        description:
          'Without price params the Temporal workflow always runs (fresh data, `X-Cache: MISS`). ' +
          'With `minPrice`/`maxPrice` the filter runs inside Redis (Lua): cached cities are served ' +
          'from Redis (`X-Cache: HIT`); otherwise the workflow runs first. Both bounds are inclusive ' +
          'and optional. The body is always a bare array sorted by price, then name.',
        parameters: [
          cityParam,
          {
            name: 'minPrice',
            in: 'query',
            description: 'Optional, inclusive lower bound. Finite number ≥ 0; must be ≤ maxPrice.',
            schema: { type: 'number', minimum: 0, example: 5000 },
          },
          {
            name: 'maxPrice',
            in: 'query',
            description: 'Optional, inclusive upper bound. Finite number ≥ 0; must be ≥ minPrice.',
            schema: { type: 'number', minimum: 0, example: 9000 },
          },
          {
            name: 'refresh',
            in: 'query',
            description: 'Force a new workflow run before filtering',
            schema: { type: 'boolean', default: false },
          },
          {
            name: 'X-Coalescing',
            in: 'header',
            description:
              'Operator-only (FEATURE_BENCHMARK + valid x-admin-token if configured): `off` gives this ' +
              'request its own workflow run. Used by the coalescing benchmark; ignored otherwise.',
            schema: { type: 'string', enum: ['off'] },
          },
        ],
        responses: {
          200: {
            description: 'Bare array of offers (no envelope). Metadata is in headers.',
            headers: hotelHeaders,
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/HotelOffer' } },
                examples: {
                  all: { summary: 'city=delhi', value: delhiOffers },
                  filtered: {
                    summary: 'city=delhi&minPrice=5000&maxPrice=9000',
                    value: delhiOffers.slice(2, 5),
                  },
                  empty: { summary: 'city=atlantis', value: [] },
                },
              },
            },
          },
          400: errorResponse('Invalid query', {
            missingCity: errorExample('VALIDATION_ERROR', 'Invalid request', [
              { path: 'city', message: 'city is required' },
            ]),
            range: errorExample('VALIDATION_ERROR', 'Invalid request', [
              { path: 'minPrice', message: 'minPrice must be <= maxPrice' },
            ]),
          }),
          429: errorResponse('Rate limited', {
            limited: errorExample('RATE_LIMITED', 'Too many requests'),
          }),
          503: errorResponse('Both suppliers, Temporal or Redis unavailable', {
            suppliers: errorExample('SUPPLIERS_UNAVAILABLE', 'All suppliers are unavailable'),
            temporal: errorExample(
              'TEMPORAL_UNAVAILABLE',
              'Workflow engine (Temporal) is unreachable',
            ),
            redis: errorExample(
              'REDIS_UNAVAILABLE',
              'Cache (Redis) operation failed: filterByPrice',
            ),
          }),
          504: errorResponse('Workflow timed out', {
            timeout: errorExample('WORKFLOW_TIMEOUT', 'Workflow did not complete in time'),
          }),
        },
      },
    },
    '/api/hotels/ask': {
      post: {
        tags: ['Hotels'],
        summary: 'Natural-language search (FEATURE_ASK)',
        description:
          'Parses a free-text query into {city, minPrice, maxPrice} with the configured LLM (forced tool call, ' +
          'zod-validated, 5s timeout) or the rules parser, then serves results through the same service as ' +
          'GET /api/hotels. Interpretations are cached for an hour (X-Parser-Cache).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                additionalProperties: false,
                properties: { query: { type: 'string', maxLength: 300 } },
              },
              example: { query: 'cheap hotels in delhi under 6k' },
            },
          },
        },
        responses: {
          200: {
            description: 'Interpretation and results',
            content: {
              'application/json': {
                example: {
                  query: 'cheap hotels in delhi under 6k',
                  interpretedAs: { city: 'delhi', minPrice: null, maxPrice: 6000 },
                  parser: 'rules',
                  results: delhiOffers.slice(0, 4),
                },
              },
            },
          },
          400: errorResponse('Invalid body', {
            body: errorExample('VALIDATION_ERROR', 'Invalid request'),
          }),
          422: errorResponse('No city found in the query', {
            noCity: errorExample(
              'UNPROCESSABLE_QUERY',
              'Could not find a city in the query. Mention a city, …',
            ),
          }),
        },
      },
    },
    '/api/hotels/insights': {
      get: {
        tags: ['Hotels'],
        summary: 'Explain why each offer won (decision log)',
        parameters: [
          cityParam,
          { name: 'refresh', in: 'query', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          200: {
            description: 'Insights report',
            content: {
              'application/json': {
                example: {
                  city: 'delhi',
                  fetchedAt: '2026-11-20T10:00:00.000Z',
                  workflowId: 'hotel-offers-delhi',
                  resultStatus: 'complete',
                  suppliersStatus: 'A=up;B=up',
                  summary: {
                    hotels: 7,
                    overlapping: 5,
                    singleSource: 2,
                    winsBySupplier: { 'Supplier A': 3, 'Supplier B': 4 },
                    reasons: {
                      cheaper: 4,
                      tie_higher_commission: 1,
                      tie_default: 0,
                      single_source: 2,
                    },
                    totalSavings: 1910,
                    avgWinnerCommissionPct: 13.71,
                  },
                  hotels: [
                    {
                      name: 'Hyatt Regency',
                      winner: { supplier: 'Supplier B', price: 8400, commissionPct: 16 },
                      reason: 'tie_higher_commission',
                      savings: 0,
                      offers: [
                        { supplier: 'Supplier A', hotelId: 'a6', price: 8400, commissionPct: 14 },
                        { supplier: 'Supplier B', hotelId: 'b6', price: 8400, commissionPct: 16 },
                      ],
                    },
                  ],
                  possibleDuplicates: [
                    {
                      a: { name: 'Radisson Blu', supplier: 'Supplier A', price: 7200 },
                      b: { name: 'Radison Blu', supplier: 'Supplier B', price: 6900 },
                      similarity: 1,
                      verdict: 'likely_same',
                      decidedBy: 'similarity',
                      reason: 'Names match after normalization (similarity 1.00)',
                      potentialSavings: 300,
                    },
                  ],
                },
              },
            },
          },
          400: errorResponse('Invalid query', {
            city: errorExample('VALIDATION_ERROR', 'Invalid request'),
          }),
        },
      },
    },
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Dependency health (suppliers, Redis, Temporal)',
        responses: {
          200: {
            description: '`up`, or `degraded` when exactly one supplier is down',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Health' },
                example: {
                  status: 'degraded',
                  timestamp: '2026-11-20T10:00:00.000Z',
                  uptimeSec: 532,
                  version: '2.0.0',
                  dependencies: {
                    supplierA: { status: 'up', latencyMs: 14 },
                    supplierB: { status: 'down', latencyMs: 2001, error: 'timeout after 2000ms' },
                    redis: { status: 'up', latencyMs: 1 },
                    temporal: { status: 'up', latencyMs: 9 },
                  },
                },
              },
            },
          },
          503: {
            description: '`down`: both suppliers, Redis or Temporal down',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
          },
        },
      },
    },
    '/health/live': {
      get: {
        tags: ['Health'],
        summary: 'Liveness (no dependency calls)',
        responses: {
          200: {
            description: 'Process is alive',
            content: { 'application/json': { example: { status: 'up' } } },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness (Redis + Temporal)',
        responses: {
          200: { description: 'Ready' },
          503: { description: 'Not ready / shutting down' },
        },
      },
    },
    '/supplierA/hotels': supplierHotelsPath('A'),
    '/supplierB/hotels': supplierHotelsPath('B'),
    '/admin/chaos': {
      get: {
        tags: ['Admin'],
        security: [{ adminToken: [] }],
        summary: 'Current chaos modes',
        responses: {
          200: {
            description: 'Modes per supplier',
            content: {
              'application/json': {
                example: { A: { mode: 'up', latencyMs: 0 }, B: { mode: 'down', latencyMs: 0 } },
              },
            },
          },
        },
      },
      delete: {
        tags: ['Admin'],
        security: [{ adminToken: [] }],
        summary: 'Reset both suppliers to up',
        responses: { 200: { description: 'Reset' } },
      },
    },
    '/admin/chaos/suppliers/{supplier}': {
      post: {
        tags: ['Admin'],
        security: [{ adminToken: [] }],
        summary: 'Set a supplier failure mode',
        description:
          '`down` → 503; `slow` → waits latencyMs (default 6000, beyond the 4s activity timeout); ' +
          '`flaky` → first 2 calls return 500, then succeed (shows Temporal retries recovering).',
        parameters: [
          {
            name: 'supplier',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['A', 'B'] },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['mode'],
                additionalProperties: false,
                properties: {
                  mode: { type: 'string', enum: ['up', 'down', 'slow', 'flaky'] },
                  latencyMs: { type: 'integer', minimum: 0, maximum: 60000 },
                },
              },
              examples: {
                down: { value: { mode: 'down' } },
                slow: { value: { mode: 'slow', latencyMs: 6000 } },
                flaky: { value: { mode: 'flaky' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'New state',
            content: {
              'application/json': { example: { supplier: 'B', mode: 'down', latencyMs: 0 } },
            },
          },
          400: errorResponse('Invalid supplier or body', {
            bad: errorExample('VALIDATION_ERROR', 'Invalid request'),
          }),
        },
      },
    },
    '/admin/circuits': {
      get: {
        tags: ['Admin'],
        security: [{ adminToken: [] }],
        summary: 'Circuit breaker state per supplier (FEATURE_MONITOR)',
        responses: {
          200: {
            description: 'Circuits',
            content: {
              'application/json': {
                example: {
                  A: {
                    state: 'closed',
                    consecutiveFailures: 0,
                    openUntil: null,
                    lastCheckedAt: '2026-11-20T10:00:00.000Z',
                  },
                  B: {
                    state: 'open',
                    consecutiveFailures: 3,
                    openUntil: '2026-11-20T10:00:30.000Z',
                    lastCheckedAt: '2026-11-20T10:00:00.000Z',
                  },
                },
              },
            },
          },
        },
      },
    },
    '/admin/monitor/probe-now': {
      post: {
        tags: ['Admin'],
        security: [{ adminToken: [] }],
        summary:
          'Signal both monitor workflows to probe now; waits for the result (FEATURE_MONITOR)',
        responses: { 200: { description: 'getStats query result per supplier' } },
      },
    },
    '/admin/warmup': {
      get: {
        tags: ['Admin'],
        security: [{ adminToken: [] }],
        summary: 'Cache warm-up Schedule: next run, last run, per-city results (FEATURE_WARMUP)',
        responses: {
          200: {
            description: 'Schedule status',
            content: {
              'application/json': {
                example: {
                  scheduleId: 'cache-warmup',
                  every: '2m',
                  cities: ['delhi', 'mumbai', 'bangalore'],
                  paused: false,
                  totalRuns: 12,
                  nextRunAt: '2026-11-20T10:02:00.000Z',
                  lastRun: {
                    status: 'COMPLETED',
                    results: [
                      { city: 'delhi', status: 'refreshed', resultStatus: 'complete', offers: 7 },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    '/admin/warmup/run-now': {
      post: {
        tags: ['Admin'],
        security: [{ adminToken: [] }],
        summary: 'Trigger the warm-up Schedule now and wait for the run (FEATURE_WARMUP)',
        responses: {
          200: { description: 'Run taken; per-city results included' },
          202: {
            description: 'Skipped by the SKIP overlap policy (a warm-up was already running)',
          },
        },
      },
    },
    '/admin/metrics/suppliers': {
      get: {
        tags: ['Admin'],
        security: [{ adminToken: [] }],
        summary: 'Supplier data-call counters (FEATURE_BENCHMARK)',
        description: 'Calls served by the mock suppliers; health and monitor probes are excluded.',
        responses: {
          200: {
            description: 'Counters',
            content: { 'application/json': { example: { A: 1, B: 1 } } },
          },
        },
      },
      delete: {
        tags: ['Admin'],
        security: [{ adminToken: [] }],
        summary: 'Reset supplier call counters',
        responses: {
          200: {
            description: 'Reset',
            content: { 'application/json': { example: { A: 0, B: 0 } } },
          },
        },
      },
    },
    '/admin/cache/{city}': {
      delete: {
        tags: ['Admin'],
        security: [{ adminToken: [] }],
        summary: "Clear one city's cache",
        parameters: [
          {
            name: 'city',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'delhi' },
          },
        ],
        responses: {
          200: {
            description: 'Keys removed',
            content: { 'application/json': { example: { city: 'delhi', deletedKeys: 3 } } },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: { adminToken: { type: 'apiKey', in: 'header', name: 'x-admin-token' } },
    schemas: {
      HotelOffer: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'price', 'supplier', 'commissionPct'],
        properties: {
          name: { type: 'string', example: 'Holtin' },
          price: { type: 'number', example: 5340 },
          supplier: { type: 'string', enum: ['Supplier A', 'Supplier B'] },
          commissionPct: { type: 'number', example: 20 },
        },
      },
      SupplierHotel: {
        type: 'object',
        required: ['hotelId', 'name', 'price', 'city', 'commissionPct'],
        properties: {
          hotelId: { type: 'string' },
          name: { type: 'string' },
          price: { type: 'number' },
          city: { type: 'string' },
          commissionPct: { type: 'number' },
        },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'details', 'requestId'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'VALIDATION_ERROR',
                  'NOT_FOUND',
                  'UNAUTHORIZED',
                  'RATE_LIMITED',
                  'UNPROCESSABLE_QUERY',
                  'SUPPLIERS_UNAVAILABLE',
                  'TEMPORAL_UNAVAILABLE',
                  'REDIS_UNAVAILABLE',
                  'WORKFLOW_TIMEOUT',
                  'WORKFLOW_FAILED',
                  'INTERNAL_ERROR',
                ],
              },
              message: { type: 'string' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { path: { type: 'string' }, message: { type: 'string' } },
                },
              },
              requestId: { type: 'string' },
            },
          },
        },
      },
      Health: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['up', 'degraded', 'down'] },
          timestamp: { type: 'string', format: 'date-time' },
          uptimeSec: { type: 'integer' },
          version: { type: 'string' },
          dependencies: {
            type: 'object',
            properties: {
              supplierA: dependency,
              supplierB: dependency,
              redis: dependency,
              temporal: dependency,
            },
          },
        },
      },
    },
  },
};
