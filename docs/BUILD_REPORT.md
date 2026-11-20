# Build Report: hotel-offer-orchestrator

This report covers how the project was built: the environment setup, the versions chosen and why, what each
phase delivered, the problems found and how they were fixed, the final verification results, and what is still
open. The product itself (API, design decisions, deployment) is documented in [README.md](../README.md).

- **Date:** 2026-11-20
- **Size:** 68 tracked files, about 4,470 lines across `src/`, `test/` and `scripts/`
- **History:** 8 commits on `main`, one per build phase plus a small test cleanup

---

## 1. Environment setup

| Item      | Found                                                                                           | Action                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js   | Only **v6.10.1** was installed (`C:\Program Files (x86)\nodejs`), far too old to build anything | Downloaded a **portable Node 24.22.3 LTS** to `%LOCALAPPDATA%\node24`. It needs no admin rights, leaves PATH unchanged, and leaves the old install alone. |
| Docker    | Docker Desktop was installed, but its engine wasn't running                                     | Started Docker Desktop. The engine reported version 29.6.1.                                                                                               |
| Port 6379 | Already used by another project's container (`realestate-redis`)                                | Left it alone. Made every host port in compose configurable, and set `REDIS_HOST_PORT=6380` in the local `.env`. The committed default is still 6379.     |

## 2. Versions (checked before writing config, then pinned)

| Component                  | Version                                                                                  | Why                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Node                       | 24.22.3 (`.nvmrc`, Docker `node:24.22.3-bookworm-slim`)                                  | Current LTS. Debian-slim because the Temporal native core-bridge needs glibc.                   |
| Temporal TS SDK            | 1.26.0 (client, worker, workflow, activity, common, testing)                             | Latest. Supports `workflowIdConflictPolicy: 'USE_EXISTING'` natively, so no fallback is needed. |
| Express                    | 5.3.0                                                                                    | Current stable major. It forwards async errors natively.                                        |
| TypeScript                 | **6.0.3** (not 7.0.2)                                                                    | `typescript-eslint` 8.73 supports only TS `<6.1`.                                               |
| ioredis / zod / pino       | 6.0.0 / 4.6.7 / 10.4.0                                                                   | Latest. The ioredis 6 API (`defineCommand`, `multi`) was checked in its typings.                |
| Vitest / ESLint / Prettier | 5.1.1 / 10.15.0 / 3.10.1                                                                 | Latest.                                                                                         |
| Docker images              | `temporalio/auto-setup:1.29.7`, `temporalio/ui:2.58.1`, `postgres:17.12`, `redis:7.4.12` | Looked up on Docker Hub. 1.29.7 is the last `auto-setup` release.                               |
| GitHub Actions             | checkout v7, setup-node v7, setup-buildx v4, build-push v7                               | Looked up through the GitHub API.                                                               |

Before writing any config, I checked the API names against the installed `.d.ts` files: the conflict and reuse
policy literals, `Duration`, `RetryState`, `Runtime.install` and its logger, `bundleWorkflowCode`, the
`NativeConnection` TLS and API-key options, `withDeadline`, and `MockActivityEnvironment`.

## 3. What each phase delivered

| #   | Commit                    | Delivered                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `74c4dc6` chore: scaffold | package.json, strict tsconfig, ESLint and Prettier, zod env config that fails fast, the pino logger, the Temporal→pino logger adapter, the lazy Temporal client, a worker with connect retries and graceful shutdown, the multi-stage Dockerfile, and compose with healthchecks on all 6 services. The empty stack came up healthy.                          |
| 2   | `813471a` feat(domain)    | The pure `selectBestOffers` (normalised-name dedupe, cheaper wins, a tie goes to the higher commission, then to Supplier A, plus the decision log), the mock supplier fixtures, and 13 unit tests, including the exact delhi result.                                                                                                                         |
| 3   | `d5c7e11` feat(cache)     | `hotelRepository` with hash-tagged keys, an atomic `MULTI` write, and `filterByPrice.lua` (cache check, `ZRANGEBYSCORE` and `HMGET` in one call). Also the chaos store in Redis, chaos-aware mock supplier routes, and repository and chaos tests against real Redis.                                                                                        |
| 4   | `2ded466` feat(temporal)  | The workflow (parallel `allSettled`, partial results, `AllSuppliersUnavailable`, the `status` query), the fetch activity (timeout, retryable vs non-retryable errors, bad records dropped), the persist activity, coalescing, timeouts set from env, and workflow tests on the time-skipping server.                                                         |
| 5   | `a66bf6b` feat(api)       | The hotels API with the exact contract and headers, the insights endpoint, `/health`, `/live` and `/ready`, admin and chaos routes with an optional token, the central error mapper, helmet, rate limiting, OpenAPI at `/docs`, graceful shutdown, the supertest suite, a coalescing test on the real Temporal dev server, and `scripts/coalescing-demo.ts`. |
| 6   | `46e388b` test(postman)   | The Postman v2.1 collection (9 folders, 36 requests, 106 assertions) and an environment file. It passes in newman and can be re-run.                                                                                                                                                                                                                         |
| 7   | `1202d37` docs            | The README (Mermaid diagrams, API reference, design decisions, deployment), CI, and the Temporal gRPC deadline fix (see §4). Also `.env.example` defaulting to development, and `.nvmrc`.                                                                                                                                                                    |
| –   | `0959da7` test(workflow)  | Silenced SDK logs in the workflow test output.                                                                                                                                                                                                                                                                                                               |

At the end of every phase I ran build, lint, typecheck and tests before committing.

## 4. Problems found and fixed

| Problem                                                                                                                  | How it was found                                              | Fix                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The API took about 92 s to return 503 when Temporal was down**, because the SDK's gRPC retry interceptor kept retrying | I stopped the `temporal` container during an end-to-end check | Wrapped the start call in `connection.withDeadline` (`TEMPORAL_START_TIMEOUT_MS`, default 5 s) and set a deadline on the result wait (the workflow timeout plus 5 s). It now returns 503 in about 5 s and recovers by itself. |
| A typecheck failure got committed in phase 2, because piping into `tail` hid the exit code                               | I reviewed the output                                         | Fixed the test imports and amended the local, unpushed commit. From then on every gate ran with `set -o pipefail`.                                                                                                            |
| The Java time-skipping test server doesn't support `workflowIdConflictPolicy`                                            | The coalescing test failed with `UNKNOWN`                     | Moved the coalescing test to `TestWorkflowEnvironment.createLocal()`, which is the real dev server.                                                                                                                           |
| The health check said "The operation was aborted due to timeout" instead of `timeout after 2000ms`                       | An integration test                                           | The probe now treats both kinds of timeout the same way.                                                                                                                                                                      |
| Temporal requires `Duration` types, not `string`                                                                         | Typecheck                                                     | Added a zod `duration` validator in config and typed the tuning with `Duration`.                                                                                                                                              |
| Activity logs contained a long base64 `taskToken`                                                                        | I read the worker logs                                        | The logger adapter now drops it.                                                                                                                                                                                              |
| `.env` set `NODE_ENV=production` for local dev                                                                           | Review                                                        | `.env.example` now defaults to `development`, and compose pins `production` for containers.                                                                                                                                   |

## 5. Behaviour verified against the running Docker stack

| Scenario                                  | Result                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /api/hotels?city=delhi`              | 200: 7 hotels in the exact spec order, the 4 keys only, all headers present, `X-Cache: MISS`        |
| `minPrice=5000&maxPrice=9000`             | 200: Holtin, Radison, Hyatt Regency, with `X-Cache: HIT` in about 5 ms                              |
| Supplier B `down`                         | 200: 6 hotels from A, `partial`, `A=up;B=down`, and `/health` returned `degraded` (200)             |
| Both suppliers `down`                     | 503 `SUPPLIERS_UNAVAILABLE`                                                                         |
| B `flaky`                                 | B failed with 500 twice, succeeded on the third attempt, and the result was `complete`              |
| B `slow` (6 s)                            | Each attempt timed out at 3.5 s; after 3 attempts the result was `partial` (about 12 s)             |
| 20 concurrent requests                    | **1** workflow run, PASS                                                                            |
| Temporal stopped                          | 503 `TEMPORAL_UNAVAILABLE` in about 5 s, `/health/ready` 503, recovered automatically after restart |
| Redis stopped                             | 503 `REDIS_UNAVAILABLE`, recovered automatically after restart                                      |
| Graceful shutdown (`docker compose stop`) | The api drained, then closed Temporal and Redis. The worker drained and stopped.                    |
| Request tracing                           | The `X-Request-Id` value appears in every worker log line for that request                          |

## 6. Final verification (§15 checklist, from a clean `docker compose down -v`)

| Check                                                         | Result                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `npm run lint && npm run typecheck && npm test`               | No problems; **8 files, 85 tests passed**                                            |
| `docker compose up --build -d` then `docker compose ps`       | **All 6 services healthy**                                                           |
| `curl -i "localhost:3000/api/hotels?city=delhi"`              | Matches the 7-hotel result                                                           |
| `curl -i "…&minPrice=5000&maxPrice=9000"`                     | 3 hotels                                                                             |
| `curl localhost:3000/health`                                  | `"status":"up"`, all 4 dependencies up                                               |
| B down, then partial result, then degraded health, then reset | As expected (see §5)                                                                 |
| `npx newman run …`                                            | **36 requests, 106 assertions, 0 failures**                                          |
| Temporal UI at http://localhost:8080                          | HTTP 200; 22 runs of `hotel-offers-delhi` listed; the `status` query returned `done` |

### Test inventory

| Suite                                        | Tests | Covers                                                                             |
| -------------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| `test/unit/selectBestOffers.test.ts`         | 13    | All selection, tie-break and normalisation cases, plus the exact delhi fixture     |
| `test/unit/supplier.activities.test.ts`      | 6     | Retryable vs non-retryable HTTP outcomes, and dropping malformed records           |
| `test/unit/config.test.ts`                   | 4     | Defaults, fail-fast errors, mTLS pairing                                           |
| `test/workflow/hotelOffers.workflow.test.ts` | 6     | Happy path, partial, non-retryable, both down, persist failure, the `status` query |
| `test/workflow/coalescing.test.ts`           | 1     | 20 starts give 1 run and 1 call per supplier, and a fresh run after close          |
| `test/integration/hotelRepository.test.ts`   | 10    | Inclusive and open ranges, empty city counts as a HIT, TTL, atomic rewrite, keys   |
| `test/integration/chaos.test.ts`             | 3     | Chaos defaults, slow latency, the flaky counter                                    |
| `test/integration/api.test.ts`               | 42    | Contract, headers, validation, error mapping, cache, insights, health, admin       |

## 7. Deliberate differences from the spec

1. **TypeScript 6.0.3** instead of 7.x, because of typescript-eslint compatibility.
2. **An extra `X-Workflow-Run-Id` header.** It's additive, so the contract is unchanged. The workflow ID is the
   same for every run of a city, so the run ID is what proves coalescing.
3. **An optional `tuning` field in the workflow input.** Workflow code can't read env, so the configurable
   timeouts and retries are passed in and recorded in history.
4. **Extra small modules:** `api/services/*`, `api/validation.ts`, `domain/insights.ts`, `infra/retry.ts`,
   `temporal/logger.ts`, `temporal/bundle.ts`, `temporal/bundlePath.ts` and `healthcheck.ts`.
5. **The worker exposes a small health port (3001)** so its container healthcheck checks something real.
6. **The coalescing test uses the real Temporal dev server**, because the time-skipping server lacks the
   conflict policy.
7. **Observed retry gaps on the self-hosted server are about 1 s**, not 300/600 ms, because of server timer
   granularity. This is documented in the README.

## 8. Open items

- [ ] **Node on PATH:** add `%LOCALAPPDATA%\node24\node-v24.22.3-win-x64` to PATH, or install Node 24, before running the npm scripts in a new terminal.
- [ ] **Local Redis port:** while `realestate-redis` holds 6379, run the tests with `REDIS_URL=redis://localhost:6380/15`.
- [ ] **CI has never run.** There's no git remote yet. Push to GitHub and check the first run.
- [ ] **README placeholders:** replace `OWNER` in the CI badge and the clone URL (now listed in a TODO at the top of the README).
- [x] **`SPEC.md`**: moved to `docs/SPEC.md` and committed (Enhancement 0).
- [x] **This report**: moved to `docs/BUILD_REPORT.md` and committed (Enhancement 0).
- [ ] The Docker stack is still running. Stop it with `docker compose down`, or `docker compose down -v` to also delete its data.

## 9. Useful commands

```bash
docker compose up --build -d          # start everything
npm run test:postman                  # newman, needs the stack running
npm run demo:coalescing               # 20 concurrent requests → 1 workflow run
REDIS_URL=redis://localhost:6380/15 npm test
docker compose logs -f worker         # structured logs with requestId / attempt / latency
```

---

# v2 enhancements

The plan is in [ENHANCEMENTS.md](../ENHANCEMENTS.md). Each enhancement is one commit. The graded contract is
frozen and guarded by `test/integration/contract.guard.test.ts`.

## Enhancement 0: Housekeeping and a safety net

**What was added**

- `SPEC.md` and `BUILD_REPORT.md` moved into `docs/` and committed. `ENHANCEMENTS.md` was added to the repo root.
- The README has a TODO at the top listing both `OWNER` placeholders (CI badge, `git clone` URL), and a
  "Project docs" line linking `docs/SPEC.md`, `docs/BUILD_REPORT.md` and `ENHANCEMENTS.md`.
- `.prettierignore` now points at `docs/SPEC.md`, the original spec, kept as written. `.dockerignore` excludes
  `docs/` and `ENHANCEMENTS.md` from the image build context.
- A new **contract guard test**, `test/integration/contract.guard.test.ts`, with 4 tests:
  - the exact JSON **text** of `GET /api/hotels?city=delhi` (7 hotels), which checks key order too
  - the presence of all 6 metadata headers
  - the exact text of the filtered response (`minPrice=5000&maxPrice=9000`, 3 hotels) on both MISS and HIT
  - the error body shape

**Decisions**

- The guard uses **literal expected strings, not Vitest snapshots**. `vitest -u` would silently rewrite a
  snapshot, which defeats the purpose. The file header says: if this test fails, fix the change, not the
  constants.
- It compares `res.text` rather than parsed JSON, so key order and number formatting are part of the guard.
- No feature flag was added. This enhancement changes no runtime code.

**Problems found:** none. To prove the guard works, I temporarily swapped two keys in the public projection
(`price` before `name`) in `hotels.routes.ts`. Both body tests failed as intended. The file was then restored
from git.

**Verification**

```
npm run lint && npm run typecheck && npm test   → Test Files 9 passed (9), Tests 89 passed (89)
docker compose up --build -d                     → all 6 services healthy
newman run #1                                    → 36 requests, 106 assertions, 0 failed
newman run #2                                    → 36 requests, 106 assertions, 0 failed
```

Tagged `v1.0.0`.

## Enhancement 1: Benchmark that proves request coalescing

**What was added (`FEATURE_BENCHMARK`, default `true`)**

- **Call counters.** The mock suppliers count data calls in Redis (`metrics:supplier:{A|B}:calls`), exposed at
  `GET`/`DELETE /admin/metrics/suppliers`. Health probes send `x-health-probe` and are not counted, and neither are
  the Enhancement 2 monitor probes.
- **Comparison mode.** `COALESCING_ENABLED` (default `true`) controls coalescing globally. There is also a
  per-request `X-Coalescing: off` operator override: when it is off, the workflow ID becomes
  `hotel-offers-<city>--<random>`, so every request starts its own run.
- **Rate-limit bypass.** `x-benchmark: 1` skips the `/api` rate limit, so a 722-request benchmark isn't throttled
  at 300/min.
- **The benchmark.** `scripts/benchmark.ts` (`npm run benchmark`) uses a hand-written concurrent client with no new
  dependency, plus `scripts/lib/{stats,benchmarkReport}.ts`. It produces `docs/benchmarks.md` and a README headline.
- **Tests:** a Postman folder "10. Supplier call metrics", unit tests for percentiles and the report, integration
  tests for the counters, override, bypass, token and flag-off cases, and a dev-server test showing that
  `coalesce: false` gives 5 distinct runs.

**Decisions**

- I used a per-request override instead of restarting the api, so the benchmark is a single command. It's safe:
  the override is honoured only with the flag on **and** a trusted operator (a matching `x-admin-token` whenever
  `ADMIN_TOKEN` is set). This is the same trust model as `/admin/chaos`, which can do far more damage. That trust
  check now lives in `api/middleware/operatorAuth.ts`, shared by `/admin` and the override.
- The admin router now takes a deps object, with optional feature modules, `onChaosReset` hooks and route
  extensions, so later enhancements can plug in without touching v1 routes.

**Problem found and fixed: coalescing doesn't give exactly one run at large N.** At N=100 there were 6 runs, not 1.
The API feeds a burst into Temporal over roughly 0.5–1 s, while a run lasts about 150 ms, so later arrivals find
the run closed and correctly start a new one (`ALLOW_DUPLICATE`). The first generated interpretation claimed "flat,
one call per supplier", so I rewrote it to report the measured numbers. The README headline now states the real
result: **100 concurrent requests → 6 runs and 12 supplier calls (vs 100 runs and 200 calls)**. At N=200 that is
**16.7× less supplier traffic and 4.8× faster p95**.

**Verification**

```
npm run lint && npm run typecheck && npm test   → Test Files 11 passed, Tests 100 passed
docker compose up --build -d                     → all 6 services healthy
newman run #1 / #2                               → 40 requests, 110 assertions, 0 failed (both runs)
npm run benchmark                                → 0 errors at every level; table in docs/benchmarks.md
contract guard                                   → passing
```

## Enhancement 2: Supplier monitor workflow and circuit breaker

**What was added (`FEATURE_MONITOR`, default `true`)**

- **`supplierMonitorWorkflow`** (`supplier-monitor-A` and `-B`), started idempotently by the worker at boot with
  `USE_EXISTING`. If the flag is off, any leftover monitors are terminated.
  - The loop is `probeSupplier` (2 s timeout, never throws), then the pure state machine, then `recordProbe`
    (Redis), then a durable `condition(…, MONITOR_INTERVAL)` that a `probeNow` signal can wake early.
  - It continues-as-new every `MONITOR_CONTINUE_AS_NEW_EVERY` iterations (or when the server suggests it),
    carrying the circuit, recent samples, probe count and generation.
  - It handles a `getStats` query and the `probeNow` and `resetCircuit` signals.
- **`domain/circuit.ts`**: a pure `closed → open → half_open → closed` state machine
  (`CIRCUIT_FAILURE_THRESHOLD` = 3, `CIRCUIT_COOLDOWN` = 30 s).
- **`infra/monitorStore.ts`**: `circuit:{A|B}` hashes and `monitor:{A|B}:samples` sorted sets, trimmed to the
  last hour.
- **`fetchSupplierHotels` fails fast.** It throws a non-retryable `CircuitOpen` when the circuit is open. If Redis
  can't be read, it fails open (the fetch goes ahead).
- **API additions (new things only):**
  - an `X-Circuit-State` header
  - a `monitor` block under each supplier in `/health`
  - `GET /admin/circuits` and `POST /admin/monitor/probe-now` (signal, then poll the query until the probe lands)
  - `DELETE /admin/chaos` also resets circuits, in Redis and through a signal
- **Tests:**
  - 6 unit tests for the state machine
  - a fail-fast activity test (no HTTP call, under 100 ms)
  - 4 time-skipping workflow tests: opens after 3 failures, half-open success closes it after `env.sleep(31s)`,
    reset, continue-as-new with the state carried over
  - 6 integration tests, including flag off
  - Postman folder "11. Circuit breaker" (10 requests)

**Decisions**

- **The workflow owns the state; Redis is the read model.** That makes the breaker deterministic and testable
  with time skipping. The fetch activity only reads it.
- **The reset signal resets state synchronously** inside the handler, so a probe that's still in flight applies
  to the reset state and can't write a stale `open` afterwards.
- **`probe-now` signals, then polls the `getStats` query** until `probeCount` increases (5 s bound). The HTTP
  call is synchronous for Postman without depending on Workflow Update support.
- **Probes send `x-health-probe`,** so they never inflate the Enhancement 1 call counters.
- **Contract kept:** `X-Suppliers-Status` still reports `B=down` when the circuit is open. `X-Circuit-State` is
  additive.

**Problems found:** none beyond typings. All 4 workflow tests passed on the first run.

**Verification**

```
npm run lint && npm run typecheck && npm test   → Test Files 14 passed, Tests 117 passed
docker compose up --build -d                     → all 6 services healthy; 2 monitor workflows Running
newman run #1 / #2                               → 50 requests, 123 assertions, 0 failed (both runs)
live: B down + 3× probe-now → circuit open → /api/hotels 200 partial in 0.15 s (vs ~2.2 s of retries)
contract guard                                   → passing
```
