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

## Enhancement 3: Scheduled cache warm-up with a Temporal Schedule

**What was added (`FEATURE_WARMUP`, default `true`)**

- **`WARMUP_CITIES`** (default `delhi,mumbai,bangalore`, each validated like `city`) and **`WARMUP_INTERVAL`**
  (default `2m`).
- **The `cache-warmup` Schedule.** The worker creates it at boot, or `update()`s it in place when it already
  exists (`ScheduleAlreadyRunning`). It uses overlap `SKIP` and a 1-minute catch-up window. With the flag off,
  the schedule is deleted.
- **`cacheWarmupWorkflow`** runs one child `hotelOffersWorkflow` per city in parallel, with ID
  `hotel-offers-<city>`, `parentClosePolicy: ABANDON` and `ALLOW_DUPLICATE`. It reports each city as
  `refreshed`, `coalesced` or `failed`.
- **Admin routes:** `GET /admin/warmup` (interval, cities, paused, total runs, next run, last run with per-city
  results) and `POST /admin/warmup/run-now` (trigger, then wait for the run; `202` if `SKIP` dropped it).
- **`DELETE /admin/chaos`** also deletes the warm-up cities' caches.
- **Tests:**
  - time-skipping workflow tests: all cities refreshed or failed; a running user run gives `coalesced`
  - a dev-server Schedule test: create, then update (interval 2m → 5m, overlap `SKIP`), run-now gives 3 cities
    `refreshed`, status, and an idempotent delete
  - integration tests for the routes, the chaos cache-clear and flag off
  - Postman folder "12. Cache warm-up": run-now, status, and a warmed city returning `X-Cache: HIT`

**Decisions**

- **Children can't use `USE_EXISTING`.** I checked the 1.26 typings: `ChildWorkflowOptions` omits
  `workflowIdConflictPolicy`. Coalescing therefore works natively in one direction (user attaches to the child)
  and by catching `WorkflowExecutionAlreadyStartedError` in the other (`coalesced`).
- **`ABANDON`** so terminating the parent never cancels a child that user requests are attached to.
- **Schedule tests run on the dev server** (`createLocal`), because the time-skipping test server doesn't
  implement Schedules.

**Problems found and fixed**

- A heredoc stripped regex backslashes in the new `WARMUP_CITIES` validator (`/\s+/` became `/s+/`). Validating
  the config immediately caught it, and it was fixed with exact edits.
- One test assumed mumbai has 7 hotels. It has 6, because the deliberately malformed empty-name record is
  skipped. The test was wrong, not the code.

**Verification**

```
npm run lint && npm run typecheck && npm test   → Test Files 16 passed, Tests 123 passed
docker compose up --build -d                     → all 6 services healthy
newman run #1 / #2                               → 53 requests, 130 assertions, 0 failed (both runs)
live: temporal schedule describe cache-warmup    → OverlapPolicy Skip, 2m interval; last run COMPLETED,
      delhi/mumbai/bangalore refreshed (complete)
contract guard                                   → passing
```

## Enhancement 4: Natural-language search with AI

**What was added (`FEATURE_ASK`, default `true`; `LLM_PROVIDER`, default `none`)**

- **`POST /api/hotels/ask`** with body `{query}` (at most 300 characters, strict). It returns
  `{query, interpretedAs, parser, results}`, and `results` comes from the same `HotelService.getOffers` /
  `getFilteredOffers` the GET endpoint uses. Headers: `X-Parser`, `X-Parser-Cache`, `X-Workflow-Id`, `X-Cache`.
- **`infra/llm.ts`**, a `ToolCaller` abstraction reused by Enhancement 6:
  - `AnthropicToolCaller` uses the official `@anthropic-ai/sdk` 1.12.0 (pinned) with forced
    `tool_choice: {type: 'tool'}`, a `strict: true` schema, `max_tokens` 512, per-request `timeout` and
    `maxRetries: 0`, and a refusal check.
  - `OpenAICompatibleToolCaller` uses plain `fetch`, a forced function call and an `AbortSignal` timeout.
- **The parser chain** (`api/services/askService.ts`) tries the LLM (zod-validated), then rules. City validation
  runs on every parser's output. The interpretation is cached in Redis (`ask:<sha256>`, 1 h). No city gives 422
  `UNPROCESSABLE_QUERY` with examples.
- **`domain/queryRules.ts`** is the pure rules parser.
- **Tests:**
  - a table-driven rules test with 24 phrasings, 8 amount formats and a word-boundary case
  - 12 unit tests with mocked LLM clients: valid output, schema-invalid output, an SDK timeout (`LlmTimeoutError`),
    invalid JSON, an abort-signal timeout, fallback to rules, an injection-shaped city rejected, cache behaviour,
    the unfiltered path, and 422
  - 6 supertest cases, including flag off
  - Postman folder "13. Natural language search" (works with `LLM_PROVIDER=none`, so CI needs no key)

**Decisions**

- **Model:** the default is **`claude-haiku-4-5`** (overridable with `LLM_MODEL`). I originally wrote that the
  plan's `claude-haiku-5-5` "doesn't exist", based on the Claude API reference's cached model table. **That was
  wrong.** The pre-push audit found `'claude-haiku-5-5'` in the installed SDK's typed model list (1.12.0), which is
  newer than that table. With no `ANTHROPIC_API_KEY` available to test either ID with a real call, the default
  stays at the known-good `claude-haiku-4-5`. Set `LLM_MODEL=claude-haiku-5-5` to use the newer model. One caution:
  this code forces `tool_choice`, which some newer models reject, so test 5-5 with one call first.
- **Compose defaults to `LLM_PROVIDER=none`,** so the stack and CI run without secrets. The feature works fully on
  the rules parser.
- **An LLM that returns no city falls through to rules** before a 422 is returned. Only city-bearing
  interpretations are cached.

**Problems found and fixed**

- `ToolSchema` lacked the index signature the SDK's `InputSchema` requires. I added it.
- **An intermittent newman failure (Enhancement 3 folder):** `X-Cache: HIT` for mumbai right after run-now. The
  cause: a scheduled tick had started during the "slow B" chaos folder, so run-now's mumbai child was reported
  `coalesced` while the earlier run was still writing. `runWarmupNow` now also waits (bounded) for in-flight runs
  of `coalesced` cities, so "run-now returned" means every warm-up city is fresh. Newman then passed 3 runs in a
  row.
- The ₹ example looked broken in a Git Bash `curl`. That was the terminal's code page; a UTF-8 body file and
  newman both parse ₹ correctly.

**Verification**

```
npm run lint && npm run typecheck && npm test   → Test Files 19 passed, Tests 174 passed
docker compose up --build -d                     → all 6 services healthy
newman run #1 / #2 / #3 (after the warm-up fix) → 57 requests, 137 assertions, 0 failed
contract guard                                   → passing
```

## Enhancement 5: Live deployment preparation

**What was added**

- **`docker-compose.prod.yml`:**
  - a **Caddy 2.11.9** reverse proxy with automatic HTTPS for `PUBLIC_DOMAIN` (or `<ip>.sslip.io`)
  - the only published ports are 80, 443 and 443/udp. Every other service has `ports: !reset []`. The Temporal UI
    uses `!override` to bind to `127.0.0.1:8080` only (SSH tunnel).
  - `ADMIN_TOKEN` and `PUBLIC_DOMAIN` are required through `${VAR:?}`, so compose fails before starting
  - `REQUIRE_ADMIN_TOKEN=true` and `TRUST_PROXY=true` for the api
  - json-file log rotation (`10m × 3`) and a `mem_limit` on every service
- **`deploy/Caddyfile`:** `reverse_proxy api:3000` with an active health check on `/health/live`, zstd/gzip, and JSON
  access logs.
- **Config:** `REQUIRE_ADMIN_TOKEN`. When it's `true`, startup fails unless `ADMIN_TOKEN` is at least 16 characters.
  Unit tests cover it.
- **`deploy/setup-vm.sh`** (idempotent): installs Docker, sets ufw to 22/80/443, clones or fast-forwards the repo,
  creates `.env` with a random `ADMIN_TOKEN` and `POSTGRES_PASSWORD` (existing secrets are kept), derives an
  sslip.io hostname when no domain is given, runs `up -d --build --wait`, and prints the URL and how to open the
  tunnel.
- **`deploy/update.sh`:** `git pull --ff-only`, rebuild and recreate with `--wait`, prune images, check health.
- **`docs/DEPLOYMENT.md`:** VM sizing, DNS or sslip.io, first deploy, updates, logs, the Temporal UI tunnel, Postman
  against production, Postgres backups (`pg_dumpall` plus cron), and troubleshooting.
- **`postman/production.postman_environment.json`:** a placeholder `baseUrl` and a secret `adminToken`.

**Decisions**

- **The Temporal UI stays unexposed** (loopback plus SSH tunnel) rather than sitting behind basic auth at
  `/temporal`. The UI is a single-page app with absolute asset paths, so a sub-path needs extra UI configuration.
  The tunnel is simpler, always works, and adds no public attack surface.
- **Chaos stays enabled in production behind the admin token,** so the resilience demo works live
  (`ENABLE_CHAOS=false` turns it off).

**Problems found:** shellcheck flagged an unused variable and word-splitting of `$SUDO` in `setup-vm.sh`. Both were
fixed and shellcheck is now clean. Git Bash path conversion broke the first shellcheck container run;
`MSYS_NO_PATHCONV=1` fixed it.

**Verification (the prod override, run for real on this machine with `PUBLIC_DOMAIN=localhost`)**

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml config   → only caddy publishes 80/443;
      temporal-ui 127.0.0.1:8080; mem limits + 10m log rotation everywhere;
      missing ADMIN_TOKEN / PUBLIC_DOMAIN → compose refuses to start
up -d --build --wait                         → 7 services healthy (incl. caddy)
api :3000 / redis direct                     → not reachable (connection refused)
http://localhost                             → 308 → https; https://localhost/health → 200 (HSTS set)
/admin without token → 401; with token → 200
newman via Caddy HTTPS (production env + token), run #1 / #2 → 57 requests, 137 assertions, 0 failed
shellcheck deploy/*.sh                       → clean
npm test                                     → all passing (new config tests included)
```

The dev stack was restored afterwards with `docker compose up -d --remove-orphans`. The actual VM steps are left
for the owner to run; the exact commands are in `docs/DEPLOYMENT.md` §3.

## Enhancement 6: AI-assisted duplicate detection (insights only)

**What was added (`FEATURE_DUPLICATES`, default `true`)**

- **A new city, `jaipur`** (only rows appended; no existing city touched). It has deliberate cross-supplier
  near-duplicates:
  - a typo: "Radisson Blu" vs "Radison Blu"
  - a stop-word: "The Leela Palace" vs "Leela Palace"
  - a prefix: "Hotel Pearl Palace" vs "Pearl Palace"
  - a look-alike that isn't a duplicate: "Taj Rambagh Palace" vs "Taj Jai Mahal Palace"
  - an exact match the normal dedupe merges: ITC Rajputana
- **`domain/similarity.ts`** (pure, no dependencies): hand-written Jaro and Jaro-Winkler, token-set similarity
  with fuzzy token matching, and normalization that strips diacritics, punctuation, stop-words and the city name.
- **`domain/duplicates.ts`** (pure): cross-supplier candidate pairs with a **mutual best match** filter,
  thresholds 0.92 and 0.75, verdict helpers, and `potentialSavings`.
- **`duplicateReviewWorkflow(city)`** loads the decisions, scores pairs in workflow code, sends 0.75–0.92 pairs to a
  `judgeDuplicate` **activity** (the LLM through the Enhancement 4 `ToolCaller`, a forced tool, a strict enum
  schema and zod), and saves the review. With no LLM, or on an LLM error, the verdict is `uncertain` decided by
  `similarity`. The workflow ID is `duplicate-review-<city>` with `USE_EXISTING`.
- **Repository:** `savePossibleDuplicates` writes through a one-line Lua script that runs `HSET` **only if the
  city's meta exists**.
- **Insights:** a new `possibleDuplicates` field, from Redis meta or reviewed on demand. All existing fields are
  unchanged. A failed review never fails insights.
- **Tests:**
  - similarity unit tests (textbook Jaro-Winkler values, normalization, token-set, known pairs, exactly 4 jaipur
    pairs, none for the original cities, savings)
  - a time-skipping workflow test with a mocked LLM activity (3 `likely_same` by similarity, 1 `different` by the
    LLM; only the ambiguous pair reaches the LLM)
  - 5 integration tests, including the guarded meta write and flag off
  - Postman folder "14. Possible duplicates": jaipur has a `likely_same` pair with `LLM_PROVIDER=none`, and the
    main endpoint does **not** merge near-duplicates

**Decisions**

- **Report-only.** The graded endpoint still dedupes by exact normalized name. Automatic merging could hide or
  misprice a real hotel; production would use shared property IDs or a mapping service.
- **The city name is a stop-word for scoring,** so "Fairmont Jaipur" vs "Trident Jaipur" doesn't look similar
  just because both contain "jaipur".
- **The review lives in the city's meta hash,** so it's deleted with the meta on every refresh and never
  describes stale data.

**Problems found and fixed**

- **False positives:** "The Leela Palace" vs "Pearl Palace" (and the reverse) scored 0.789 because of the shared
  "palace" suffix, which put them in the LLM band. I added mutual-best-match filtering; now exactly the 4
  intended pairs are reported, and none for delhi, mumbai, bangalore or goa.
- **A cache-integrity hazard:** a plain `HSET` on an expired meta key would create a meta hash with no data,
  which `filterByPrice.lua` would treat as a cache HIT (an empty result). The guarded Lua write prevents this,
  and an integration test covers it.
- Twice, bash couldn't parse a large combined command (unmatched quotes in a heredoc). I moved the edits into
  script files written with the Write tool.

**Verification**

```
npm run lint && npm run typecheck && npm test   → Test Files 22 passed, Tests 190 passed
docker compose up --build -d                     → all 6 services healthy
newman run #1 / #2                               → 59 requests, 144 assertions, 0 failed
live (real Temporal duplicateReviewWorkflow, jaipur):
  1.00 likely_same similarity  Hotel Pearl Palace | Pearl Palace      (save 100)
  1.00 likely_same similarity  Radisson Blu | Radison Blu             (save 300)
  1.00 likely_same similarity  The Leela Palace | Leela Palace        (save 400)
  0.87 uncertain   similarity  Taj Rambagh Palace | Taj Jai Mahal Palace (LLM band, no LLM configured)
contract guard                                   → passing
```

## Enhancement 7: Ops console UI

**What was added (`FEATURE_CONSOLE`, default `true`; `TEMPORAL_UI_URL`)**

- **`/console`** serves `src/console/{index.html, console.css, console.js}`, copied to `dist/console` by the build.
  There's no framework, no build step and no CDN. It's responsive (one column under 960 px) and supports light
  and dark modes.
- **Sections:**
  - **Search:** a results table with supplier badges, and header chips (`X-Workflow-Id` linked to the Temporal UI,
    `X-Cache`, `X-Result-Status`, suppliers, circuits, time).
  - **Ask:** the interpretation and results.
  - **Supplier health:** tiles with status, latency, uptime %, circuit and failures, auto-refreshed every 5 s,
    plus the overall status pill.
  - **Chaos controls:** up, down, slow and flaky per supplier, reset, and probe-now. The admin token sits in a
    password field and is held only in memory.
  - **Insights:** summary chips, the decision table and the possible-duplicates table.
- **`GET /console/config.json`** gives the Temporal UI base URL, the namespace and the enabled features, so the
  page hides sections whose feature is off.
- **Safety:** all rendering uses DOM APIs and `textContent`, never `innerHTML`, so API data can't inject markup.
  Helmet's strict default CSP (`script-src 'self'`, no inline script) is unchanged, and the page needs no
  exceptions.
- **Tests:**
  - supertest: the page and assets are served, the CSP is strict, there are no CDN URLs, the config is correct,
    and the flag-off case
  - **a jsdom smoke test** that loads the real HTML and JS against a live test app and checks: health tiles
    render, a search renders 7 rows with badges and the correct Temporal link, ask renders 4 results, insights
    renders 4 duplicate rows, and chaos clicks change modes and reset clears them
  - Postman folder "15. Ops console"
- **jsdom 31.0.1** and `@types/jsdom` 30.0.0 (pinned, dev only).

**Decisions**

- **jsdom smoke test instead of a screenshot.** No browser is available in this environment, so the UI was
  verified by driving the real page in jsdom. A screenshot placeholder is in the README.

**Problems found and fixed**

- ESLint flagged a useless initial assignment in `console.js`. It's fixed, and browser globals are now configured
  for `src/console`.
- In the new DOM test, an `until(async …)` call resolved immediately, because a Promise is always truthy. That
  assertion was vacuous, so `until` now awaits its condition.
- **A pre-existing flaky test (Enhancement 2):** the continue-as-new monitor test hung about 1 run in 3. A
  `getStats` query landing during the continue-as-new hop could block on the time-skipping server, and the poll
  had no deadline. Each poll query now has a 2 s gRPC deadline (`withDeadline`) and retries. It passed 6 of 6
  runs afterwards.

**Verification**

```
npm run lint && npm run typecheck && npm test   → Test Files 24 passed, Tests 198 passed
docker compose up --build -d                     → all 6 services healthy; /console served by the container
newman run #1 / #2                               → 61 requests, 147 assertions, 0 failed
contract guard                                   → passing
```

## Enhancement 8: One-command verification and an end-to-end CI run

**What was added**

- **`scripts/verify.ts`** (`npm run verify`) runs these steps, timing each one:
  1. a clean `docker compose down -v`, then `up --build -d --wait`, then a check that every service reports
     `healthy`
  2. lint and typecheck
  3. unit, workflow and integration tests (the integration tests use the `.env` Redis port, DB 15)
  4. newman with the JSON reporter (`newman/report.json`)
  5. five timed chaos scenarios (B down, both down, flaky, slow, circuit breaker under 1 s), each resetting chaos
     afterwards
  6. a benchmark at N=50, coalescing on vs off
- It writes **`docs/verification-report.md`** with the date, commit, versions, a pass/fail table with durations,
  the newman summary, the chaos timings and the benchmark lines. It exits non-zero on any failure, and the
  infrastructure steps are critical (they abort the run). It creates `.env` from `.env.example` when missing (CI)
  and passes `ADMIN_TOKEN` along when one is set.
- **CI split into two workflows, one badge each:**
  - `ci.yml` keeps the fast job unchanged (lint, format, typecheck, build, tests).
  - The new `e2e.yml` (job `e2e`) runs `npm run verify` and uploads the report and `newman/` as artifacts. It
    replaces the old `docker-e2e` job, whose steps `verify` now covers.
- **README:** an E2E badge and a "one-command verification" section.

**Problems found and fixed:** ESLint flagged regexes containing a literal ESC control character (for ANSI
stripping) and two useless initial assignments. I replaced them with a `RegExp` built from
`String.fromCharCode(27)`, and typed the variables without initialising them.

**Verification:** `npm run verify` ran **twice in a row** locally, and both passed. Each run starts from
`down -v`, so it rebuilds images and recreates every volume.

```
npm run verify  (run #1) → ✅ 10/10 checks; tests 89 + 17 + 92; newman 61 requests / 147 assertions / 0 failed;
                            chaos: B down 1958 ms, both down 2047 ms, flaky 2139 ms, slow 11884 ms, circuit <1 s;
                            benchmark N=50: on 3 runs / 3+3 calls vs off 50 runs / 50+50 calls
npm run verify  (run #2) → ✅ 10/10 checks in 140 s (same results; report committed as docs/verification-report.md)
```

## Enhancement 9: Final polish and release (v2.0.0)

**What was added**

- **The README now leads with the strongest material:**
  - the pitch, and a live-URL slot (not deployed yet; the VM steps are the owner's)
  - **Highlights** with the measured benchmark headline
  - a **Reviewer quick tour** (five steps, under 3 minutes)
  - links to `docs/benchmarks.md`, `docs/verification-report.md`, `docs/DEPLOYMENT.md`, the demo script and the
    changelog
  - an architecture diagram updated to show the monitor workflows, the warm-up Schedule, the ask/LLM parser, the
    duplicate review and the console
- **`CHANGELOG.md`** covers 1.0.0 and 2.0.0.
- **`docs/DEMO_SCRIPT.md`:** a 3-minute recording script (search, then B down, then the circuit opening, then
  flaky retries in the Temporal UI, then the benchmark, then ask, then insights and duplicates, then the verify
  report), with backup curl commands.
- **Version 2.0.0** in `package.json`, the `SERVICE_VERSION` default, the image tag and OpenAPI.

**Fresh-clone test** (clone HEAD into a temp folder; follow only the README)

- `cp .env.example .env && docker compose up --build -d --wait` gave 6 healthy services. The only deviation was
  `REDIS_HOST_PORT=6380`, because another project's Redis holds 6379 on this machine; the README's
  troubleshooting table covers this exact case.
- The Quick Start curls worked: 7 delhi hotels with all headers, the 3-hotel filter, insights, `/health` up, B
  down giving partial plus degraded, `/console`, `/docs` and the Temporal UI all returned 200.
- **Bug found and fixed:** quick-tour step 4 (`npm run demo:coalescing`) failed on a fresh clone with
  `'tsx' is not recognized`, because the README never said to run `npm ci` first. The tour (and the resilience
  demo) now say `npm ci` and Node 24. After the fix, the clone gave `distinct runs: 1 … PASS`, and newman in the
  clone passed 61 requests and 147 assertions with 0 failures.

**Verification**

```
npm run lint && npm run typecheck && npm test   → Test Files 24 passed, Tests 198 passed
contract guard (test/integration/contract.guard.test.ts) → 4/4 passing (graded contract unchanged since v1.0.0)
fresh clone: compose up → 6 healthy; README curls OK; demo:coalescing PASS; newman 147/147
```

Tagged `v2.0.0`.

---

# Pre-push audit, deployment prep and screenshots

**Requirements traceability.** The README now has a table right under the pitch. Each assignment requirement (the
workflow behaviours, Redis save and filtering, the response format, Docker, the three Postman items, the README,
both bonus items) links to the code that implements it and the test or Postman folder that proves it. The v2 work
is listed separately as "Beyond the brief".

**Security pass**

- **`X-Coalescing: off` and the `x-benchmark` rate-limit bypass** now require a configured, matching
  `ADMIN_TOKEN` (`hasValidAdminToken`, constant-time compare). They are disabled entirely under
  `NODE_ENV=production` unless `ALLOW_COALESCING_OVERRIDE=true`. The dev compose file sets it `true`; the prod
  override and the default are `false`. Tests cover a valid token, a missing or wrong token, no token configured,
  production, production plus allow, and flag off.
- **`/admin/*` is token-protected per route group**, with one test each: chaos, chaos (mutating), cache, metrics,
  circuits, monitor, warm-up and warm-up trigger. A missing or wrong token gets 401; the right token gets 2xx.
  Without a configured token, `/admin` now **fails closed** under `NODE_ENV=production` unless
  `ALLOW_OPEN_ADMIN=true`. That flag exists because the local demo stack also runs `NODE_ENV=production`.
- **LLM budget guard:** `BudgetedToolCaller` counts every LLM call (ask parser and duplicate judge) in Redis
  (`llm:calls:<UTC date>`, 2-day TTL) against `LLM_DAILY_CALL_LIMIT` (default 200). Over the limit, or with the
  counter unreachable (fail closed), the rules parser or a similarity-only verdict answers and a warning is logged.
  6 unit tests.
- **Secret scan:** gitleaks 8.30.1 over all 19 commits and the working tree. It reported 4 findings, all false
  positives: internal URLs such as `http://api:3000/supplierA/hotels` matching `generic-api-key`. A narrow
  allowlist in `.gitleaks.toml` brought it to **no leaks found**. `.env` was never committed (it's gitignored), no
  key-shaped strings appear anywhere in history, and `.env.example` holds only empty placeholders plus a
  local-only `POSTGRES_PASSWORD` (which `setup-vm.sh` randomizes).

**LLM model ID.** The installed SDK's typed model list includes `claude-haiku-5-5`, so the earlier "doesn't exist"
claim (taken from a cached model table) was wrong, and the Enhancement 4 notes are corrected. No
`ANTHROPIC_API_KEY` was available for a real call, so the default stays `claude-haiku-4-5`, and the README says how
to set `LLM_MODEL`.

**CI on Linux.** Nothing Windows-specific is in the code, scripts or workflows (the only `6380` is README
troubleshooting text). `verify` uses `.env.example` defaults, waits up to 600 s, and injects a per-run admin
token, then restores the token-less local configuration afterwards. The E2E job's timeout is 60 minutes, npm is
cached, and no secrets are needed.

**Deployment prep (Prompt 2):**

- `scripts/smoke.ts` (`npm run smoke -- --url …`, plus `--insecure` for self-signed certificates) checks:
  `/health` is up, delhi matches the 7-hotel contract **byte-exact**, the 3-hotel filter is byte-exact, and
  `/console` and `/docs` are served. The library has an integration test, including a failing-contract case.
- Production defaults to `LLM_PROVIDER=none` (in the prod override and `setup-vm.sh`).
- `docs/DEPLOYMENT.md` has PowerShell equivalents for Windows.

**Screenshots (Prompt 3).** `scripts/screenshots.ts` (`npm run screenshots`) uses Playwright 1.65.1 with
Chromium at 1440×900 and sharp 0.35.5 palette compression. It produces `console.png` (32 KB), `temporal-retries.png`
(52 KB, B's activity on **Attempt 3** with the last failure "Supplier B responded 500"), `temporal-schedule.png`
(44 KB) and `openapi.png` (24 KB). They're embedded in the README. While doing this I found that the README wrongly
said retries appear as `ActivityTaskFailed` events; Temporal records a single `ActivityTaskStarted` on the final
attempt, with `attempt` and `lastFailure`, and the text is corrected.

**Problems found and fixed**

- `verify` failed its typecheck once, because I wrote `screenshots.ts` before its dependencies were installed,
  while a run was in progress. The final run is clean.
- The smoke script reported 0 ms timings, because the object literal evaluated `ms` before awaiting the check.
- The first retries screenshot didn't show the retry; the script now expands and centres the "Attempt 3" row.
- The worker in the prod override inherited the dev `ALLOW_*=true` values (harmless, since it serves no HTTP
  admin routes). It's now pinned to `false`.

**Verification**

```
npm run lint && npm run typecheck && npm test → 27 files, 227 tests passed
gitleaks (history + tree, with allowlist)     → no leaks found
npm run verify (clean slate, per-run token)   → ✅ 10/10: 95 + 17 + 115 tests; newman 61 requests / 148 assertions /
                                                 0 failed; 5 chaos scenarios; benchmark N=50 (on: 3 runs, off: 50 runs)
npm run smoke -- --url http://localhost:3000   → 5/5
npm run screenshots                            → 4 images, 24–52 KB each
```
