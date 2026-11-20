# Enhancements: hotel-offer-orchestrator v2

The core project is done and verified (see `BUILD_REPORT.md`). This file lists the enhancements in order. Each
one makes the project more impressive **without changing anything the assignment asks for**.

**How to use this file:** put it in the repo root. Then tell Claude Code:
`Read ENHANCEMENTS.md fully, then do Enhancement N only. Follow the Ground Rules.`
Do them in order, one per session or prompt. After each one, check the result before starting the next.

---

## Ground rules (apply to every enhancement)

1. **The assignment contract is frozen.** You may not change:
   - `GET /api/hotels?city=` and `GET /api/hotels?city=&minPrice=&maxPrice=`
   - the bare-array response with exactly `name, price, supplier, commissionPct`
   - the sorting, status codes and existing headers
   - `/supplierA/hotels`, `/supplierB/hotels`, the `/health` fields that already exist, and the delhi fixture data

   New features add **new** endpoints, fields or headers only.

2. **Never edit the existing delhi, mumbai, bangalore or goa mock data.** If a feature needs new data, add a **new city**.
3. **Every enhancement sits behind an env flag** (for example `FEATURE_MONITOR=true`). It defaults to on in
   `docker-compose.yml`, and is documented in `.env.example` and the README env table. With the flag off, the system
   behaves exactly as in v1.
4. **No regressions.** Before you commit an enhancement, all of these must pass:
   - `npm run lint && npm run typecheck && npm test`: all existing tests plus the new ones
   - `docker compose up --build -d` with all services healthy
   - newman: all existing assertions plus the new ones, **run twice in a row** to catch state leaking between runs
5. **New code needs new tests**: unit tests for pure logic, and integration or Postman tests for endpoints.
6. **One commit per enhancement**, using conventional commits, plus a short section added to `BUILD_REPORT.md`
   under "v2 enhancements". That section covers what was added, the decisions made, problems found and fixed, and
   the verification output.
7. Before using any new library or API, check the installed version and its typings, then pin it. Don't guess.
8. Node is the portable install at `%LOCALAPPDATA%\node24\node-v24.22.3-win-x64`; add it to PATH for the
   session. Local Redis for tests is `redis://localhost:6380/15`.
9. If an enhancement turns out much bigger than expected, stop and report back. Don't leave the repo half-done.

---

## Enhancement 0: Housekeeping and a safety net (about 30 min)

1. Fix the open items from BUILD_REPORT §8:
   - move `SPEC.md` and `BUILD_REPORT.md` into `docs/` and commit them
   - make sure the README links work after the move
   - leave the `OWNER` placeholders but list them in a TODO at the top of the README
2. Add a **contract guard test**, `test/integration/contract.guard.test.ts`. It snapshots the exact delhi response
   (body, plus the names of the required headers) and the 3-hotel filtered response. If any later change breaks the
   graded contract, this test fails loudly. Add a comment explaining why the test exists.
3. Tag the current state `v1.0.0`. I will push it to GitHub myself; just show me the commands.

---

## Enhancement 1: Benchmark that proves request coalescing (about 1 h)

The existing `scripts/coalescing-demo.ts` sends 20 requests. Turn it into a real benchmark with numbers.

1. Add a **call counter** to the mock suppliers: a Redis counter `metrics:supplier:{A|B}:calls`. Expose it at
   `GET /admin/metrics/suppliers`, and reset it with `DELETE /admin/metrics/suppliers`.
2. Add a `COALESCING_ENABLED` flag (default `true`). When it is `false`, the workflow ID gets a unique suffix, so
   every request starts its own run. This is only for comparison.
3. Add `scripts/benchmark.ts` (use `autocannon` or a hand-written concurrent client). For N = 1, 10, 50, 100 and
   200 concurrent requests to `/api/hotels?city=delhi`, it measures:
   - p50, p95 and p99 latency
   - the number of distinct workflow runs (from `X-Workflow-Run-Id`)
   - supplier calls per supplier
   - errors

   Run the whole set **with coalescing on and off**. Restarting the api to change the flag is fine; the script
   prints instructions for doing that, or it uses a request-level admin override if that is simpler and safe.

4. Write the results to `docs/benchmarks.md` as a Markdown table, with machine info, the date and a one-paragraph
   interpretation. Add the headline to the README, for example "100 concurrent requests → 1 workflow run, 2 supplier
   calls (vs 200 without coalescing)".
5. Add the script `npm run benchmark`.

---

## Enhancement 2: Supplier monitor workflow and circuit breaker (about 2–2.5 h)

This shows deeper Temporal use: a long-running workflow, durable timers and continue-as-new.

1. **`supplierMonitorWorkflow({ supplier })`**
   - One per supplier, with fixed IDs `supplier-monitor-A` and `supplier-monitor-B`. The worker starts them at
     boot, idempotently (conflict policy `USE_EXISTING`).
   - The loop: a `probeSupplier` activity (HTTP GET with a 2s timeout, latency measured), then record the sample,
     then `sleep(MONITOR_INTERVAL)` (default 15s).
   - Call `continueAsNew` every N iterations (for example 100), so history stays bounded.
   - Add a `getStats` query handler that returns recent samples, consecutive failures and circuit state.
2. **Status history in Redis.** Store each sample in a capped sorted set `monitor:{supplier}:samples` (score =
   timestamp), trimmed to the last hour.
3. **Circuit breaker** (state in Redis, `circuit:{supplier}`), with the states `closed` → `open` → `half_open` →
   `closed`:
   - After `CIRCUIT_FAILURE_THRESHOLD` consecutive failed probes (default 3), the monitor sets the state to `open`
     with `openUntil = now + CIRCUIT_COOLDOWN` (default 30s).
   - After the cooldown, the next probe runs in `half_open`. Success closes the circuit; failure re-opens it.
   - In `fetchSupplierHotels`, if the circuit is `open`, throw a **non-retryable** `CircuitOpen` failure
     immediately. The workflow already treats a failed supplier as `down`, so requests skip the slow timeouts and
     return partial results fast. **Keep `X-Suppliers-Status` showing `down`** (the existing Postman tests expect
     that), and add a new header `X-Circuit-State: A=closed;B=open`.
4. **`/health` additions (new fields only).** Under each supplier, add:

   `monitor: { uptimePctLastHour, lastCheckedAt, consecutiveFailures, circuit }`

   The existing live probe and all existing fields stay exactly as they are.

5. **Admin endpoints.** Add `GET /admin/circuits`. `DELETE /admin/chaos` must **also reset circuits and their
   failure counts**, so the Postman runs stay repeatable.
6. **Postman:** add a folder "Circuit breaker":
   - set B `down`, then call `POST /admin/monitor/probe-now` (add this endpoint; it signals the monitor workflows to
     probe immediately) three times
   - check that `/admin/circuits` shows B `open`
   - check that `/api/hotels?city=delhi` returns fast (under 1s, asserted) with B down and `X-Circuit-State` showing
     `B=open`
   - reset, and check that B is `closed`
7. **Tests:**
   - a workflow test of the state machine with mocked probes on the time-skipping server
   - a test that the fetch activity fails fast when the circuit is open
   - a check that continue-as-new happens
8. Update the README Mermaid diagrams and the design decisions. Explain why the breaker is driven by the monitor
   (it is predictable and separate from request traffic) rather than by request failures.

---

## Enhancement 3: Scheduled cache warm-up with a Temporal Schedule (about 45 min)

1. Add `WARMUP_CITIES` (default `delhi,mumbai,bangalore`) and `WARMUP_INTERVAL` (default `2m`).
2. At worker startup, create or update one **Temporal Schedule**, `cache-warmup`, idempotently: if it already
   exists, update it. Each tick starts `cacheWarmupWorkflow`, which runs `hotelOffersWorkflow` for each city as
   **child workflows** using the same IDs as normal requests, `hotel-offers-<city>`. That way a warm-up and a user
   request for the same city coalesce. Use a parent-close policy that makes sense, and document it.
3. Use an overlap policy of `SKIP`, so a slow tick never stacks up.
4. Add `POST /admin/warmup/run-now`, which triggers the schedule, and `GET /admin/warmup`, which reports the
   last run, the next run and per-city results.
5. **The Postman chaos runs must stay repeatable.** A warm-up during a "B down" test could cache partial data, so
   `DELETE /admin/chaos` must also clear the cache for the warm-up cities. Verify this by running newman twice.
6. README: explain that filtered requests are now almost always `X-Cache: HIT`, and show the Schedule in the Temporal
   UI (add a screenshot placeholder).

---

## Enhancement 4: Natural-language search with AI (about 2 h)

1. Add a new endpoint, `POST /api/hotels/ask`, with body `{ "query": "cheap hotels in delhi under 6k" }`. Because it
   is a new endpoint, it may use an envelope:
   ```json
   {
     "query": "cheap hotels in delhi under 6k",
     "interpretedAs": { "city": "delhi", "minPrice": null, "maxPrice": 6000 },
     "parser": "llm",
     "results": [{ "name": "...", "price": 0, "supplier": "Supplier A", "commissionPct": 0 }]
   }
   ```
   `results` comes from the **same service function** the GET endpoint uses, so the dedupe, cache and Redis filtering
   are reused, not duplicated.
2. **Parser chain.** Pick the first one that is available and succeeds:
   1. **LLM parser.** It lives behind an interface `QueryParser`, with `LLM_PROVIDER=anthropic | openai-compatible |
none`.
      - `anthropic`: the official `@anthropic-ai/sdk`. The model comes from env, `LLM_MODEL` (default
        `claude-haiku-5-5`; check that this ID is valid).
      - `openai-compatible`: any base URL and key, so it works with Groq, OpenRouter or a local Ollama.
      - Force structured output: use tool use with a forced tool choice and a JSON schema for
        `{ city, minPrice, maxPrice }`, then validate with zod.
      - Use a 5s timeout. If anything fails, fall back to the rules parser.
   2. **Rules parser**, a pure function with no AI. It handles:
      - "under/below/less than/max X", "over/above/at least/min X", "between X and Y", "X-Y" and "X to Y"
      - "6k" → 6000, "₹6,000" → 6000
      - city detection from the known cities list, case-insensitive
3. **Safety:**
   - limit the query to 300 characters
   - treat the user query strictly as data inside the prompt, and state that in the system prompt
   - never let LLM output reach Redis keys without the existing city validation
   - apply the existing rate limiting
   - cache parser results in Redis by a query hash for an hour, so repeated queries cost nothing
4. If no city can be found, return **422** with a helpful message and examples.
5. **Tests:**
   - a table-driven unit test of the rules parser with at least 20 phrasings
   - the LLM parser tested with a mocked client: valid output, invalid JSON falling back to rules, and a timeout
     falling back to rules
   - supertest for the endpoint
   - a Postman folder "Natural language search" that works with `LLM_PROVIDER=none`, so CI needs no key
6. README: a short section with 4 example queries and their interpretations, plus how to enable each provider.

---

## Enhancement 5: Live deployment (about 2 h; I will run the VM steps myself)

Prepare everything so that I can deploy to a single Linux VM (Ubuntu 24.04, at least 4 GB RAM) with Docker Compose.

1. Add a `docker-compose.prod.yml` override:
   - add a **Caddy** reverse proxy with automatic HTTPS
     - the domain comes from `PUBLIC_DOMAIN`
     - document using `<ip>.sslip.io` when there is no domain
   - only Caddy publishes ports 80 and 443; Redis, Postgres, Temporal and the api are internal only
   - put the Temporal UI behind Caddy basic auth at `/temporal`, or keep it unexposed (choose whichever is simpler
     and reliable, and document it)
   - make `ADMIN_TOKEN` **required** in prod, and have the config fail fast if it is missing
   - set restart policies to `unless-stopped`, add log rotation, and set memory limits
2. Add `deploy/setup-vm.sh`. It must be idempotent and install Docker, set up the firewall (ufw: 22, 80, 443),
   clone the repo, create `.env` from a template, and run compose with the prod override.
3. Add `deploy/update.sh`, which runs git pull, then rebuilds and restarts with zero manual steps.
4. Add `docs/DEPLOYMENT.md` with step-by-step instructions:
   - creating the VM (mention student credit options generally, without promising specific offers)
   - DNS or sslip.io
   - the first deploy, updating, viewing logs, and backups (the Postgres volume)
   - a troubleshooting section
5. Add a Postman environment `production.postman_environment.json` with `baseUrl` set to a placeholder. Read-only
   folders must pass against prod. Chaos folders need the admin token variable.
6. Show me the exact commands to run, in order.

---

## Enhancement 6: AI-assisted duplicate detection, in insights only (about 1.5–2 h)

Name-based dedupe misses near-duplicates such as "Radisson Blu" and "Radison Blu", or "The Leela Palace" and
"Leela Palace". The **main endpoint still dedupes by exact normalized name**, as required. This feature only
**reports** possible duplicates.

1. Add a **new city, `jaipur`**, with deliberate near-duplicates across the suppliers, plus true non-duplicates
   that look similar, for example "Taj Rambagh" and "Taj Jai Mahal". Don't touch the other cities.
2. Add a pure similarity module, `src/domain/similarity.ts`. Implement Jaro-Winkler and token-set similarity
   yourself, with no heavy dependencies. Normalize away punctuation and stop-words such as "the", "hotel" and
   "resort".
3. Add `duplicateReviewWorkflow(city)`, which reads the cached supplier offers and compares candidate pairs from
   **different suppliers** whose normalized names differ:
   - score ≥ 0.92: `likely_same`, decided by `similarity`
   - 0.75 to 0.92: ask the LLM in an **activity** (AI is non-deterministic, so it never runs in workflow code). The
     verdict is `likely_same` / `different` / `uncertain`, with a one-line reason and `decidedBy: "llm"`. If no
     LLM is configured, the verdict is `uncertain` and `decidedBy: "similarity"`.
   - below 0.75: ignored
4. Insights runs this workflow on demand and caches it in Redis meta. It adds a **new** `possibleDuplicates` field:

   `[{ a: {name, supplier, price}, b: {...}, similarity, verdict, decidedBy, reason, potentialSavings }]`

   All existing insights fields stay the same.

5. **Tests:**
   - unit tests for the similarity scores on known pairs
   - a workflow test with mocked LLM activity results
   - Postman: insights for jaipur shows at least one `likely_same` pair, with `LLM_PROVIDER=none`
6. README: explain why this is report-only. Auto-merging would risk wrong merges, and production would use shared
   property IDs or a mapping service.

---

## Enhancement 7: Ops console UI (optional, about 1.5 h, great for the demo video)

1. Serve a single static page at `/console`, behind `FEATURE_CONSOLE`. Use plain HTML, CSS and vanilla JS with no
   build step and no framework. It should be clean, professional and responsive.
2. Sections:
   - **Search:** a city plus min/max fields. Show the results table with a supplier badge on each row, plus the
     `X-Workflow-Id`, `X-Cache` and `X-Result-Status` headers. Link each workflow ID to the Temporal UI.
   - **Ask (natural language):** a text box that calls `/api/hotels/ask` and shows the interpretation.
   - **Supplier health:** tiles for A and B showing status, latency, uptime % and circuit state. They auto-refresh
     every 5s.
   - **Chaos controls:** buttons for up/down/slow/flaky per supplier, and a reset button. Ask for the admin token
     once and keep it in memory only.
   - **Insights:** the decision table (winner, reason, savings) and possible duplicates.
3. No external CDNs. That keeps it working offline and keeps helmet's CSP strict; set the CSP so the page works.
4. Add one supertest check that the page serves, and add a screenshot placeholder to the README.

---

## Enhancement 8: One-command verification and an end-to-end CI run (about 1.5 h)

1. Add `scripts/verify.ts` (`npm run verify`), which:
   - starts from a clean `docker compose down -v`, then runs `up --build -d` and waits for every service to be
     healthy
   - runs lint, typecheck and the unit, workflow and integration tests
   - runs newman (all folders), then each chaos scenario with timings: down, both down, flaky, slow and circuit
   - runs a short benchmark (N=50)
   - writes `docs/verification-report.md` with the date, versions, a pass/fail table for each check, durations,
     and the newman summary
   - exits non-zero on any failure
2. CI: add a job `e2e` on ubuntu-latest that runs `npm run verify` and uploads the report and the newman output as
   artifacts. Keep the existing fast job as it is. Add a README badge for each job.
3. Make sure the whole run is repeatable: run `npm run verify` twice locally, and both runs must pass.

---

## Enhancement 9: Final polish and release (about 1 h)

1. **README refresh.** Put the strongest material first:
   - a one-paragraph pitch and the live URL
   - a "Highlights" list with the headline benchmark number
   - the Mermaid architecture diagram, updated to show the monitor, the schedule, the AI parser and the console
   - links to `docs/benchmarks.md`, `docs/verification-report.md` and `docs/DEPLOYMENT.md`
   - a "Reviewer quick tour" section: five commands or clicks that show the best features in under 3 minutes
2. Add a `CHANGELOG.md` covering v1.0.0 and v2.0.0.
3. Add `docs/DEMO_SCRIPT.md`: a 3-minute demo-video script. It shows a normal search, then turning B off (partial
   results and degraded health), then the circuit opening (fast responses), then the flaky supplier recovering in
   the Temporal UI, then the benchmark, then natural-language search, then the console.
4. Do a **fresh-clone test**: clone into a temp folder and follow only the README Quick Start. Fix anything that
   doesn't work exactly as written.
5. Make sure the contract guard test still passes. Then tag `v2.0.0` and show me the push commands.
