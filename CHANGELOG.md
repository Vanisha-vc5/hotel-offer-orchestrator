# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

The graded public contract (`GET /api/hotels`, the bare 4-key array, sorting, status codes and headers) is
**unchanged since 1.0.0** and is guarded byte-for-byte by `test/integration/contract.guard.test.ts`. Every 2.0.0
feature is additive and sits behind an env flag. With the flags off, the system behaves exactly like 1.0.0.

## [2.0.0] - 2026-11-21

### Added

- **Coalescing benchmark** (`FEATURE_BENCHMARK`): Redis supplier call counters
  (`GET`/`DELETE /admin/metrics/suppliers`), a trusted `X-Coalescing: off` override, `COALESCING_ENABLED`, and
  `npm run benchmark`, which writes `docs/benchmarks.md`. Measured: 100 concurrent requests → 6 workflow runs and
  12 supplier calls (vs 100 runs and 200 calls). At N=200, supplier traffic is 16.7× lower and p95 is 4.8× faster.
- **Supplier monitor workflows and circuit breaker** (`FEATURE_MONITOR`):
  - long-running `supplier-monitor-A/B` workflows with durable timers, continue-as-new, `probeNow` and
    `resetCircuit` signals, and a `getStats` query
  - a pure `closed → open → half_open` breaker with state and one hour of probe history in Redis
  - `fetchSupplierHotels` fails fast with `CircuitOpen`
  - the `X-Circuit-State` header, a `monitor` block in `/health`, `GET /admin/circuits` and
    `POST /admin/monitor/probe-now`
- **Scheduled cache warm-up** (`FEATURE_WARMUP`): the `cache-warmup` Temporal Schedule (overlap `SKIP`) runs
  child `hotelOffersWorkflow`s with the user-request IDs, so warm-ups and requests coalesce. Also
  `GET /admin/warmup` and `POST /admin/warmup/run-now`.
- **Natural-language search** (`FEATURE_ASK`): `POST /api/hotels/ask`, using an LLM parser (Anthropic SDK or any
  OpenAI-compatible endpoint, forced tool call, zod, 5 s timeout) with a pure rules-parser fallback, a Redis
  interpretation cache, and 422 with examples.
- **Production deployment:** `docker-compose.prod.yml` (Caddy with automatic HTTPS, internal-only services,
  required `ADMIN_TOKEN`, log rotation, memory limits), `deploy/setup-vm.sh`, `deploy/update.sh`,
  `docs/DEPLOYMENT.md` and a production Postman environment.
- **Report-only near-duplicate detection** (`FEATURE_DUPLICATES`): hand-written Jaro-Winkler and token-set
  similarity, mutual-best matching, `duplicateReviewWorkflow` with an LLM judge activity, a `possibleDuplicates`
  field in insights, and a `jaipur` fixture.
- **Ops console** (`FEATURE_CONSOLE`): a dependency-free page at `/console` with search, ask, live health, chaos
  controls and insights.
- **One-command verification:** `npm run verify` (clean stack, all tests, newman, timed chaos, benchmark), which
  writes `docs/verification-report.md`; an `E2E` CI workflow.
- **Contract guard test,** and the docs moved into `docs/` (spec, build report).

### Fixed

- `X-Cache: HIT` right after a warm-up run-now could miss when a city was `coalesced` with a run still in flight.
  Run-now now waits for those runs.
- A flaky monitor-workflow test (a query during continue-as-new could hang). Poll queries now have deadlines.

### Changed

- The admin router takes feature extensions and `onChaosReset` hooks. `DELETE /admin/chaos` also resets circuits
  and clears warm-up caches (the response body is unchanged).

## [1.0.0] - 2026-11-20

### Added

- `GET /api/hotels?city=` runs the Temporal `hotelOffersWorkflow`: parallel supplier activities with retries,
  partial results, `AllSuppliersUnavailable` → 503, and pure `selectBestOffers` (cheaper wins, tie → higher
  commission → Supplier A). It returns a bare array sorted by price and name, with metadata only in headers.
- Price filtering inside Redis (sorted set, hash, atomic `MULTI` writes, a single Lua script), TTLs (with a
  shorter one for partial results), and hash-tagged keys.
- Request coalescing (`workflowIdConflictPolicy: USE_EXISTING`), a `status` query handler, and explicit gRPC
  deadlines so Temporal outages give a fast 503.
- `/health` (up/degraded/down), `/health/live`, `/health/ready`, insights, chaos controls, OpenAPI at `/docs`,
  helmet, rate limiting, graceful shutdown, and structured pino logs with end-to-end request IDs.
- Docker (multi-stage, Debian slim, non-root) and compose with healthchecks; unit, workflow and integration tests;
  a Postman collection; CI.

[2.0.0]: https://github.com/Vanisha-vc5/hotel-offer-orchestrator/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Vanisha-vc5/hotel-offer-orchestrator/releases/tag/v1.0.0
