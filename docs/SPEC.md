# Build: Hotel Offer Orchestrator

You are a senior backend engineer. Build a complete, production-quality project called **hotel-offer-orchestrator** in this folder. The project will be judged as an assignment submission, so every requirement must work exactly as specified. Each bonus item must also be implemented and easy to demo. The project should stand out for its engineering quality: resilience, observability, clear design decisions and good docs. Avoid adding random features.

**How to work:**
1. First, read this whole spec and reply with a short implementation plan and the final folder tree. Then start building right away; don't wait for approval.
2. Build in the phases listed in section 14. At the end of every phase, compile (`npm run build`), run the tests and fix anything that fails before you move on. Make one git commit per phase with a clear conventional-commit message.
3. Never change the public response contract in section 4. It is the part that gets graded.
4. Before writing config, check the installed versions of the Temporal TypeScript SDK and the Docker images. Use APIs that exist in those versions, pin the versions you use, and don't guess.
5. When you finish, run the full verification checklist in section 15 and show me the actual output.

---

## 1. Stack (fixed)

- **Runtime:** Node.js (current LTS, 22 or 24) with TypeScript in `strict` mode
- **HTTP:** Express. Use v5 if it is the current stable major; otherwise use v4 with an async error wrapper.
- **Orchestration:** Temporal (`@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`, and `@temporalio/testing` for tests)
- **Cache and filtering:** Redis 7 through `ioredis`
- **Validation:** `zod`, used for query params, env config, supplier payloads and the chaos API
- **Logging:** `pino`, with `pino-http` for request logs and `pino-pretty` only in dev
- **Tests:** Jest or Vitest, plus `supertest`
- **API docs:** an OpenAPI 3 spec served with `swagger-ui-express` at `/docs`
- **Containers:** a multi-stage Dockerfile and `docker-compose.yml`
- **Lint and format:** ESLint and Prettier

## 2. Architecture

There are two processes, both built from the same Docker image with different start commands.

1. **api**, the Express server. It serves the public API, the mock supplier endpoints, health checks, the chaos/admin endpoints and `/docs`. It starts Temporal workflows through the Temporal client.
2. **worker**, the Temporal worker. It runs the workflow and the activities. Activities call the supplier mocks over HTTP using the `SUPPLIER_A_URL` and `SUPPLIER_B_URL` environment variables, which point to `http://api:3000/...` in Docker. That way the network hop is real, and failures and timeouts are real too.

The compose infrastructure is `redis`, `temporal` (with `postgresql` as its persistence), `temporal-ui` on port 8080, and `api` and `worker`.

Request flow for `GET /api/hotels?city=delhi`:
```
Client → API (validate) → Temporal client starts hotelOffersWorkflow
  → Worker: fetchSupplierHotels(A) ∥ fetchSupplierHotels(B)   [parallel activities, with retries]
  → selectBestOffers()                                          [pure, deterministic, runs inside the workflow]
  → persistOffers() into Redis (sorted set + hash + meta)       [activity]
  → returns result → API responds with a JSON array
```

## 3. Folder structure (target)

```
hotel-offer-orchestrator/
├── src/
│   ├── api/
│   │   ├── app.ts                 # builds the express app (exported for supertest)
│   │   ├── server.ts              # starts the app, graceful shutdown
│   │   ├── routes/hotels.routes.ts
│   │   ├── routes/suppliers.routes.ts   # mock supplier endpoints
│   │   ├── routes/health.routes.ts
│   │   ├── routes/admin.routes.ts       # chaos controls
│   │   ├── middleware/requestId.ts
│   │   ├── middleware/errorHandler.ts
│   │   └── openapi.ts
│   ├── temporal/
│   │   ├── client.ts              # lazy singleton Temporal client, connection retry
│   │   ├── worker.ts              # worker entrypoint, graceful shutdown
│   │   ├── shared.ts              # task queue name, workflow input/output types
│   │   ├── workflows/index.ts
│   │   ├── workflows/hotelOffers.workflow.ts
│   │   └── activities/{index,supplier.activities,cache.activities}.ts
│   ├── domain/
│   │   ├── types.ts               # SupplierHotel, HotelOffer, SupplierStatus …
│   │   ├── selectBestOffers.ts    # PURE: dedupe and pick the winner (no Node imports)
│   │   └── errors.ts              # typed AppError classes
│   ├── infra/
│   │   ├── config.ts              # zod-validated env, fails fast with clear errors
│   │   ├── logger.ts
│   │   ├── redis.ts
│   │   ├── hotelRepository.ts     # all Redis read/write logic
│   │   └── lua/filterByPrice.lua
│   └── mocks/
│       ├── supplierA.data.ts
│       ├── supplierB.data.ts
│       └── chaos.ts               # per-supplier failure modes, state kept in Redis
├── test/ (unit/, workflow/, integration/)
├── postman/
│   ├── HotelOfferOrchestrator.postman_collection.json
│   └── local.postman_environment.json
├── .github/workflows/ci.yml
├── Dockerfile
├── docker-compose.yml
├── .dockerignore  .env.example  .eslintrc / eslint.config  .prettierrc
├── package.json  tsconfig.json
└── README.md
```

## 4. Public API contract (graded; follow it exactly)

### 4.1 `GET /api/hotels?city=delhi`
- Runs the Temporal workflow on every call; the unfiltered endpoint always returns fresh data.
- Responds with **200** and a **bare JSON array**, with no envelope or wrapper object. Each item has **exactly these 4 keys**:
```json
[
  { "name": "Holtin",  "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison", "price": 5900, "supplier": "Supplier A", "commissionPct": 13 }
]
```
- `supplier` is always the string `"Supplier A"` or `"Supplier B"`.
- Sort the array by `price` ascending, then by `name` ascending, so the output is deterministic.
- Metadata goes in **response headers only**, never in the body:
  - `X-Request-Id`
  - `X-Workflow-Id`: the Temporal workflow ID, so a reviewer can find the run in the Temporal UI
  - `X-Suppliers-Status`, for example `A=up;B=down`
  - `X-Result-Status`: `complete` or `partial`
  - `X-Cache`: `MISS` or `HIT` (see 4.2)
  - `X-Response-Time`

### 4.2 `GET /api/hotels?city=delhi&minPrice=<min>&maxPrice=<max>`
- **Price filtering must run inside Redis** (see section 7). Never filter in JavaScript.
- If fresh cached data for the city exists in Redis, serve it from Redis (`X-Cache: HIT`). Otherwise run the workflow first, which saves the data to Redis, and then query Redis (`X-Cache: MISS`).
- Support `?refresh=true` to force a new workflow run before filtering.
- `minPrice` and `maxPrice` are both optional and inclusive. Use `-inf` or `+inf` for whichever is missing.
- The response has the same bare-array format, sorted by price ascending.

### 4.3 Validation and errors
- `city` is required. Trim it and lowercase it. Allow only letters, spaces and hyphens, with a maximum of 50 characters. If it is missing or invalid, return **400**.
- `minPrice` and `maxPrice` must be non-negative finite numbers. If `minPrice > maxPrice`, return **400**.
- If the city is valid but no supplier has hotels for it, return **200 `[]`**. This is not an error.
- If **both** suppliers are down, return **503** (`SUPPLIERS_UNAVAILABLE`). Do not return `[]`, because that would wrongly say the city has no hotels.
- If **one** supplier is down, return **200** with that supplier's hotels, plus `X-Result-Status: partial`.
- If Temporal or Redis is unreachable, return **503** with a clear error code.
- Error body (use this one shape for every error):
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "minPrice must be <= maxPrice", "details": [...], "requestId": "..." } }
```
- Return 404 JSON for unknown routes. Never leak stack traces outside `NODE_ENV=development`.

## 5. Mock supplier APIs (in the api service)

- `GET /supplierA/hotels` and `GET /supplierB/hotels`
- Accept an optional `?city=` filter (case-insensitive). With no city, return the full array.
- Record shape: `{ "hotelId": "a1", "name": "Holtin", "price": 6000, "city": "delhi", "commissionPct": 10 }`
- Both endpoints are **chaos-aware** (see section 9).

**Use this exact data for delhi**, so that the Postman tests and unit tests can assert exact results. Add similar overlapping data for `mumbai` and `bangalore`. Also add `goa` with hotels **only in Supplier A**, to show the single-supplier case.

| Hotel         | Supplier A (id, price, comm%) | Supplier B (id, price, comm%) | Expected winner |
|---------------|-------------------------------|-------------------------------|-----------------|
| Holtin        | a1, 6000, 10                  | b1, 5340, 20                  | B, 5340, 20     |
| Radison       | a2, 5900, 13                  | b2, 6150, 11                  | A, 5900, 13     |
| Taj Palace    | a3, 12500, 15                 | b3, 11900, 18                 | B, 11900, 18    |
| The Leela     | a4, 9800, 12                  | b4, 10200, 10                 | A, 9800, 12     |
| Hyatt Regency | a6, 8400, 14                  | b6, 8400, 16                  | **tie** → B (higher commission) |
| Lemon Tree    | a5, 3200, 8                   | –                             | A (only A has it) |
| Ibis          | –                             | b5, 2900, 9                   | B (only B has it) |

Expected `GET /api/hotels?city=delhi`, in this order: Ibis 2900 (B), Lemon Tree 3200 (A), Holtin 5340 (B), Radison 5900 (A), Hyatt Regency 8400 (B), The Leela 9800 (A), Taj Palace 11900 (B). That is **7 hotels**.

Expected `minPrice=5000&maxPrice=9000`: Holtin, Radison, Hyatt Regency.

## 6. Dedupe and selection logic (`src/domain/selectBestOffers.ts`)

- This must be a **pure, deterministic function** with no Node built-ins, I/O, `Date.now()` or `Math.random()`, because it runs inside the Temporal workflow sandbox.
- **Dedupe key:** the normalized name. Trim it, collapse inner whitespace, and lowercase it. For example, `" holtin "`, `"HOLTIN"` and `"Holtin"` are the same hotel.
- If a hotel appears in both lists, the **lower price wins**.
- **Tie-break rule** (document it in the README as a deliberate business decision): if prices are equal, the **higher `commissionPct`** wins, because that is the better margin for us. If commission is also equal, prefer Supplier A, so the result is deterministic.
- If only one supplier has the hotel, use that offer.
- Also dedupe **inside** a single supplier's list, keeping the cheapest offer, in case a supplier returns duplicates.
- Output uses the winning offer's trimmed display name, `supplier` as `"Supplier A"` or `"Supplier B"`, and `commissionPct`.
- The function also returns a **decision log** for each hotel: every candidate offer, the winner, the reason (`cheaper` / `tie_higher_commission` / `tie_default` / `single_source`) and the savings versus the other offer. This feeds the insights endpoint in section 10.

## 7. Redis design ("price filtering inside Redis")

Use hash-tagged keys so that all keys for one city live in the same cluster slot and stay compatible with Redis Cluster:
- `hotels:{<city>}:by_price`: a **sorted set**. The member is the normalized name and the score is the price.
- `hotels:{<city>}:offers`: a **hash** from normalized name to the JSON of the 4-field offer.
- `hotels:{<city>}:meta`: a **hash** with `fetchedAt`, `workflowId`, `count`, `suppliersStatus`, `resultStatus` and `decisions` (the decision log as JSON).

Writes happen in the `persistOffers` activity, inside **one `MULTI` transaction**: DEL the old keys, ZADD, HSET, HSET the meta, then EXPIRE all keys. The write must be atomic, so a reader never sees a half-written city.
- TTL is `CACHE_TTL_SECONDS` (default 300).
- **Partial results** (one supplier down) use the shorter `PARTIAL_CACHE_TTL_SECONDS` (default 30), so the cache recovers quickly once the supplier is back.
- Write `meta` even when the result is empty (count 0). That way an empty city counts as a cache HIT.

Reads for filtering use **one Lua script** (`filterByPrice.lua`), loaded with `defineCommand` or `EVALSHA`. In one atomic round trip it runs `ZRANGEBYSCORE` on the sorted set with min/max (inclusive, with `-inf`/`+inf` support) and then `HMGET`s the offers from the hash. The results come back already sorted by price from Redis.

All Redis access goes through `hotelRepository.ts`. No route touches Redis directly.

## 8. Temporal workflow and activities

- **Task queue:** `hotel-offers` (from `shared.ts`)
- **Workflow:** `hotelOffersWorkflow({ city, requestId })` returns `{ offers, suppliersStatus, resultStatus, decisions }`.
  - Start both supplier activities **in parallel** with `Promise.allSettled`.
  - If one supplier fails after all retries, mark it `down`, log it with the workflow logger, and continue with the other supplier. **Partial results are valid.**
  - If both fail, throw an `ApplicationFailure` of type `AllSuppliersUnavailable`, and have the API map it to 503.
  - Call `selectBestOffers` inside the workflow; it is deterministic.
  - Call the `persistOffers` activity to save the result to Redis.
  - Expose a **query handler** called `status`, which reports the current step (`fetching` / `selecting` / `persisting` / `done`) and per-supplier status. This shows off a Temporal feature.
- **Activities:**
  - `fetchSupplierHotels(supplier: 'A' | 'B', city)` makes an HTTP GET with an `AbortController` timeout and validates the payload with zod.
    - 5xx, network errors and timeouts are **retryable**.
    - 4xx and an invalid payload shape throw `ApplicationFailure.nonRetryable`.
    - Malformed individual records are **dropped and logged**, so one bad record doesn't fail the whole supplier.
    - Use `Context.current().heartbeat()` or the activity `log`, and include the attempt number in the logs.
  - `persistOffers(city, result)` performs the Redis MULTI write described in section 7.
- **Activity options:**
  - Supplier fetch: `startToCloseTimeout: '4s'` and a retry policy of `{ initialInterval: '300ms', backoffCoefficient: 2, maximumInterval: '2s', maximumAttempts: 3, nonRetryableErrorTypes: [...] }`.
  - Persist: its own options with more retries.
  - Make all values configurable through env where reasonable.
- **Request coalescing (key feature):** start workflows with ID `hotel-offers-<city>`, using a workflow ID **conflict policy of USE_EXISTING** and a reuse policy that allows a new run once the previous one has finished. As a result, 50 concurrent requests for `delhi` share **one** workflow execution instead of hitting the suppliers 50 times. Check the exact option names in the installed SDK version. If the SDK version doesn't support the conflict policy, fall back to catching `WorkflowExecutionAlreadyStartedError` and attaching to the running workflow with `getHandle(...).result()`. Document this in the README.
- **Workflow execution timeout:** 30s.
- **Logging in workflows** uses `log` from `@temporalio/workflow` (replay-safe). Activities use `log` from `@temporalio/activity`. Route the Temporal Runtime logs into pino through a small logger adapter (`Runtime.install({ logger })`).
- **Worker:** in production, use a pre-bundled workflow bundle (`bundleWorkflowCode`, created at build time) or point `workflowsPath` at the compiled JS. Handle SIGINT/SIGTERM with `worker.shutdown()`. Retry the Temporal connection at startup with backoff, because Temporal may not be ready yet in Docker.
- **API Temporal client:** a lazy singleton with reconnect and backoff. Every workflow is started with `requestId` in its memo or search attributes.

## 9. Chaos controls, for demoing failures and Postman's "supplier down" test

- `POST /admin/chaos/suppliers/:supplier`, where `:supplier` is `A` or `B`. The body is `{ "mode": "up" | "down" | "slow" | "flaky", "latencyMs"?: number }`.
  - `down`: the mock returns 503.
  - `slow`: the mock waits `latencyMs` (default 6000) before responding. This exceeds the 4s activity timeout, so the Temporal timeout and retries are visible.
  - `flaky`: the mock **fails the first 2 calls with 500, then succeeds**, using a counter in Redis. This shows Temporal retries recovering, deterministically.
- `GET /admin/chaos` returns the current modes. `DELETE /admin/chaos` resets everything to `up`.
- Store chaos state in Redis, so it is shared across processes.
- Enable these endpoints only when `ENABLE_CHAOS=true` (default true in compose). If `ADMIN_TOKEN` is set, require it in an `x-admin-token` header.
- Also add `DELETE /admin/cache/:city` to clear one city's cache.

## 10. Bonus and distinguishing features

1. **`GET /health` (bonus, required):** check both suppliers **in parallel** through their real HTTP endpoints (chaos-aware), with a 2s timeout and measured latency. Also check Redis (`PING`) and Temporal (connection plus a system info call).
   ```json
   {
     "status": "degraded",
     "timestamp": "2026-11-20T10:00:00.000Z",
     "uptimeSec": 532,
     "version": "1.0.0",
     "dependencies": {
       "supplierA": { "status": "up", "latencyMs": 14 },
       "supplierB": { "status": "down", "latencyMs": 2001, "error": "timeout after 2000ms" },
       "redis":     { "status": "up", "latencyMs": 1 },
       "temporal":  { "status": "up", "latencyMs": 9 }
     }
   }
   ```
   - `status` is `up` when everything is up.
   - It is `degraded` when exactly one supplier is down, and the endpoint still returns **200** because the system can serve partial data.
   - It is `down` (**503**) when both suppliers, Redis or Temporal are down.
   - Also add `GET /health/live`, a cheap liveness check with no dependency calls, used by the Docker healthcheck, and `GET /health/ready`, which checks Redis and Temporal.
2. **Logging and error handling (bonus, required):**
   - Structured JSON logs with a **requestId** that flows from HTTP request → workflow memo → activity logs, so one request can be traced end to end.
   - Log supplier latency, attempt numbers, records dropped, the winner count, and cache HIT/MISS.
   - Use typed errors (`AppError` subclasses) and one central Express error handler that maps Temporal `WorkflowFailedError` / `ApplicationFailure` types to HTTP codes.
3. **`GET /api/hotels/insights?city=delhi`:** an explainability endpoint that reads the decision log from Redis meta. For each hotel it returns both supplier offers, the winner, the reason and the savings, plus totals such as "total savings vs worst offer" and "wins per supplier". It is a separate endpoint, so the main contract is untouched.
4. **Request coalescing**, as described in section 8. Add an integration test or script that fires 20 concurrent requests and shows they all get the same `X-Workflow-Id`.
5. **The `status` query handler** on the workflow, from section 8.
6. **OpenAPI docs** at `/docs` covering every endpoint, with examples.
7. **Graceful shutdown** for both api and worker: stop accepting connections, drain in-flight requests, then close Redis and Temporal.
8. **Security basics:** `helmet`, `express-rate-limit` on `/api`, strict query validation, and no `x-powered-by` header.
9. **CI:** a GitHub Actions workflow that runs lint, typecheck, unit and workflow tests, and a Docker build. Optionally, it can run `docker compose up` and the Postman collection with `newman`.

Don't add anything outside this list unless it is tiny and clearly useful.

## 11. Docker

- **Dockerfile:** multi-stage (deps → build → runtime). Use a **Debian-slim Node base image, not Alpine**, because the Temporal SDK's native core-bridge works most reliably on glibc.
  - Install production dependencies only in the runtime stage.
  - Run as a non-root user.
  - Copy the Lua scripts and the workflow bundle into the image.
  - Add a `HEALTHCHECK`. Default to the `api` command; the worker overrides it.
- **docker-compose.yml:**
  - Services: `postgresql`, `temporal` (the auto-setup server image, using postgres), `temporal-ui` (port **8080**), `redis` (port 6379, `redis:7` image), `api` (port **3000**, `node dist/api/server.js`) and `worker` (`node dist/temporal/worker.js`).
  - Every service has a healthcheck, and `depends_on` uses `condition: service_healthy`.
  - Use a named network and named volumes. Pin image tags (look up current stable versions).
  - All config comes from `.env`, with defaults in `.env.example`.
  - The whole stack must start with **one command**: `docker compose up --build`.
- **npm scripts:** `dev:api`, `dev:worker` (with `tsx watch`), `build`, `start:api`, `start:worker`, `lint`, `typecheck`, `test`, `test:unit`, `test:workflow`, `test:integration`, `test:postman` (newman).

## 12. Tests (required, keep them meaningful)

- **Unit tests for `selectBestOffers`:**
  - overlap with A cheaper, overlap with B cheaper
  - a tie broken by commission, and a full tie that falls back to A
  - single-source hotels from A and from B
  - name normalization (case, whitespace)
  - duplicates within one supplier
  - both lists empty, and one list empty
  - the decision-log reasons
- **Workflow tests** with `TestWorkflowEnvironment` (time-skipping) and **mocked activities**:
  - happy path
  - supplier B throws, which gives a partial result with B marked down
  - both suppliers throw, which gives `AllSuppliersUnavailable`
  - the `status` query returns the right value
- **Repository tests** against a real Redis (from compose or a testcontainer):
  - inclusive min/max boundaries
  - open-ended ranges
  - an empty city counts as a HIT
  - TTL is applied
  - the atomic rewrite replaces old data
- **API integration tests** with supertest, mocking the Temporal client:
  - validation 400s
  - 503 mapping
  - the bare-array contract, asserting that every item has **exactly** the keys `name, price, supplier, commissionPct`
  - the headers are present

## 13. Postman collection (`postman/HotelOfferOrchestrator.postman_collection.json`, v2.1)

- Use a `{{baseUrl}}` variable (default `http://localhost:3000`) and include an environment file.
- Organize it into folders. **Every request has `pm.test` assertions.**
  1. **Health:** `/health` (status is `up`, both suppliers are listed), `/health/live`
  2. **Mock suppliers:** Supplier A (all), Supplier A for delhi, Supplier B for delhi
  3. **Hotels, happy path:**
     - `city=delhi`: 200, 7 items, no duplicate names, sorted ascending, Holtin = Supplier B / 5340, Hyatt Regency = Supplier B (tie-break), exactly 4 keys per item, `X-Workflow-Id` header present
     - `city=DELHI`: case-insensitive, same 7 results
     - `city=goa`: single-supplier city, all results from Supplier A
  4. **Price filter:**
     - 5000–9000 → exactly Holtin, Radison, Hyatt Regency, all in range
     - only `minPrice=9000`, and only `maxPrice=3000`
     - a range with no matches → `[]`
     - an exact-boundary test showing the range is inclusive
     - a second identical call returns `X-Cache: HIT`
  5. **No results:** `city=atlantis` → 200 `[]`
  6. **Validation:** missing city, `minPrice=abc`, `minPrice > maxPrice`, negative price, invalid city characters. Each returns 400 with `error.code`.
  7. **Supplier down simulation:**
     - set B `down` → `city=delhi` returns only A's 6 hotels, with `X-Result-Status: partial` and `X-Suppliers-Status` containing `B=down`
     - `/health` returns `degraded` with supplierB `down`
     - set A `down` as well → 503 `SUPPLIERS_UNAVAILABLE`
     - reset the chaos state
  8. **Resilience demo:**
     - B `flaky` → the request still succeeds with complete results (retries recovered)
     - B `slow` → the result is partial because of the timeout
     - reset
  9. **Insights:** `/api/hotels/insights?city=delhi` reports the winner and reason for each hotel
- Requests in the chaos folders must **reset state at the end**, so the whole collection passes when run top to bottom in the Collection Runner or newman.

## 14. Build phases

1. Scaffold: package.json, tsconfig, lint, config (zod), logger, folder tree, Dockerfile, compose, and a healthy empty stack
2. Domain: `selectBestOffers`, its types and its unit tests
3. Mock suppliers, chaos state, and the Redis repository with the Lua filter, plus repository tests
4. Temporal: workflow, activities, worker, client, coalescing, query handler, plus workflow tests
5. API routes, validation, error handler, headers, insights, `/health*`, OpenAPI, plus integration tests
6. Postman collection and environment; run it with newman against `docker compose up` until everything passes
7. README, CI, and final polish

## 15. Final verification (run all of this and show me the output)

- `npm run lint && npm run typecheck && npm test`: all pass
- `docker compose up --build -d`: all containers healthy (`docker compose ps`)
- `curl -i "localhost:3000/api/hotels?city=delhi"` matches the 7-hotel result in section 5
- `curl -i "localhost:3000/api/hotels?city=delhi&minPrice=5000&maxPrice=9000"` returns 3 hotels
- `curl localhost:3000/health`
- Set B down through the chaos endpoint, then show the partial result and the degraded health, then reset
- `npx newman run postman/...collection.json -e postman/local.postman_environment.json`: 0 failures
- The workflow run is visible in the Temporal UI at http://localhost:8080

## 16. README.md (it should look like a strong open-source repo)

- Title, a one-paragraph pitch and badges (CI, Node, TypeScript)
- A **Mermaid architecture diagram** and a **Mermaid sequence diagram** of the workflow, including the partial-failure path
- Features list (core plus bonus), with the distinguishing features called out
- Quick start: prerequisites → `cp .env.example .env` → `docker compose up --build` → sample curls → Temporal UI link → `/docs` link
- API reference: every endpoint, its params, and example requests and responses, including the error format and headers
- **Design decisions**, a short "why" for each:
  - Temporal for orchestration
  - the parallel `allSettled` call and why partial results are allowed
  - the retry and timeout values
  - the non-retryable errors
  - the tie-break rule
  - name normalization
  - the Redis sorted set, hash and Lua script, and why the filtering is atomic and server-side
  - the hash-tagged keys
  - TTL and the shorter TTL for partial results
  - request coalescing
  - why there is no envelope in the response
- Resilience demo: step-by-step chaos commands with the expected outcomes
- Environment variables table
- Testing: how to run each test suite and the Postman collection (GUI and newman)
- **Deployment:**
  - (a) any Linux VM (EC2, DigitalOcean or similar) with Docker Compose: exact commands, opening port 3000, and an optional nginx reverse proxy
  - (b) the changes needed for Temporal Cloud (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, API key/mTLS env vars), already supported in `config.ts`
- Project structure, troubleshooting (Temporal not ready yet, port conflicts), and future improvements

## 17. Quality bar

- No `any` without a comment explaining why. Use explicit return types on exported functions and keep functions small.
- No secrets in the repo. Provide `.env.example`, and make sure `.gitignore` covers `node_modules`, `dist` and `.env`.
- Never use `console.log`; always use the logger.
- The response contract in section 4 must be exact. Re-check it before you finish.
