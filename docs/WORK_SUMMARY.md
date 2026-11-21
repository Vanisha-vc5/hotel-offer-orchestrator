# Work Summary: hotel-offer-orchestrator

This summary covers everything done on the project, from the empty folder to the `v2.0.0` release. Each step has
full detail in [BUILD_REPORT.md](BUILD_REPORT.md): decisions, problems and the verification output.

|          |                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Releases | `v1.0.0` (the assignment submission) and `v2.0.0` (nine enhancements)                                                     |
| History  | 19 commits on `main`, one per phase or enhancement                                                                        |
| Size     | 127 tracked files, about 10,300 lines in `src/`, `test/` and `scripts/`                                                   |
| Tests    | 198 automated tests in 24 files (unit, Temporal workflow, integration), plus 61 Postman requests with 147 assertions      |
| Status   | Everything passes. `npm run verify` passed 10/10 checks twice in a row, and the graded contract is unchanged since v1.0.0 |

---

## 1. Environment setup

- The only Node.js installed was **v6.10.1**. I installed a **portable Node 24.22.3 LTS** in
  `%LOCALAPPDATA%\node24`, with no admin rights and no change to PATH.
- I started Docker Desktop.
- Port 6379 was taken by another project's container (`realestate-redis`). Every host port became configurable,
  and the local `.env` uses `REDIS_HOST_PORT=6380`.
- I checked every library and Docker image version before using it, and pinned it. Examples: Temporal SDK
  1.26.0, Express 5.3.0, TypeScript 6.0.3 (typescript-eslint doesn't support TS 7 yet), `temporalio/auto-setup`
  1.29.7, `redis` 7.4.12 and Caddy 2.11.9.

## 2. Version 1.0.0: the assignment (8 commits)

| Commit    | Phase       | Delivered                                                                                                                                                                                                                        |
| --------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `74c4dc6` | Scaffold    | Strict TypeScript, ESLint and Prettier, zod env config that fails fast, pino logging, a Temporal client and worker with retries and graceful shutdown, a multi-stage Debian-slim Dockerfile, and compose with 6 healthy services |
| `813471a` | Domain      | Pure `selectBestOffers`: name dedupe, cheaper wins, a price tie goes to the higher commission, then Supplier A. Includes a decision log                                                                                          |
| `d5c7e11` | Cache       | The Redis repository: hash-tagged keys, an atomic `MULTI` write, and a single Lua script that filters by price _inside_ Redis. Chaos-aware mock suppliers                                                                        |
| `2ded466` | Temporal    | The workflow (parallel fetch, partial results, 503 when both fail), activities with typed retryable and non-retryable errors, request coalescing (`USE_EXISTING`), and a `status` query                                          |
| `a66bf6b` | API         | The exact contract (a bare 4-key array, with metadata in headers), validation, the error mapper, insights, `/health*`, admin and chaos routes, and OpenAPI at `/docs`                                                            |
| `46e388b` | Postman     | A 36-request collection that passes in newman twice in a row                                                                                                                                                                     |
| `1202d37` | Docs and CI | README, GitHub Actions, and gRPC deadlines (with Temporal down, the API used to take **92 s** to return 503; now it takes **5 s**)                                                                                               |
| `0959da7` | Polish      | Quieter test output                                                                                                                                                                                                              |

## 3. Version 2.0.0: nine enhancements (11 commits)

Each feature is behind an env flag, defaults to on, and only _adds_ endpoints, fields or headers.

| #   | Commit               | Enhancement                 | Highlights                                                                                                                                                                                                                                                                                  |
| --- | -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `f4c8c7e`            | Housekeeping                | Docs moved to `docs/`. A **contract guard test** freezes the graded response byte-for-byte. Tagged `v1.0.0`                                                                                                                                                                                 |
| 1   | `584c96d`            | Benchmark                   | Supplier call counters, an `X-Coalescing: off` operator override, and `npm run benchmark`. **100 concurrent requests → 6 runs and 12 supplier calls (vs 100 and 200). At N=200, 16.7× less supplier traffic and 4.8× faster p95**                                                           |
| 2   | `e9842a8`            | Monitor and circuit breaker | Long-running `supplier-monitor-A/B` workflows (durable timers, signals, a query, continue-as-new) and a `closed → open → half_open` breaker. With a supplier's circuit open, requests answer in **0.15 s** instead of about 2 s. New `X-Circuit-State` header and a `/health` monitor block |
| 3   | `07ac3c7`            | Cache warm-up               | A Temporal **Schedule** (`cache-warmup`, every 2 min, overlap `SKIP`) runs child workflows that coalesce with user requests                                                                                                                                                                 |
| 4   | `13a8089`            | Natural-language search     | `POST /api/hotels/ask`: an LLM parser (Anthropic or OpenAI-compatible, forced tool call, zod, 5 s timeout), a rules-parser fallback, and a Redis interpretation cache                                                                                                                       |
| 5   | `6a835fa`            | Deployment                  | `docker-compose.prod.yml` (Caddy with automatic HTTPS, internal-only services, required admin token, log rotation, memory limits), `deploy/setup-vm.sh`, `deploy/update.sh`, `docs/DEPLOYMENT.md`. **Tested locally over HTTPS**                                                            |
| 6   | `2437001`            | Duplicate detection         | Hand-written Jaro-Winkler and token-set similarity, mutual-best matching, and an LLM judge activity. Insights gains `possibleDuplicates` (report-only), with a new `jaipur` city                                                                                                            |
| 7   | `0a6311c`            | Ops console                 | `/console`: plain HTML, CSS and JS with no CDN. Search, ask, live health, chaos buttons and insights. Verified by a jsdom test against the real API                                                                                                                                         |
| 8   | `6753304`            | One-command verification    | `npm run verify` (clean stack, all tests, newman, chaos scenarios, benchmark) writes `docs/verification-report.md`. A separate E2E CI workflow                                                                                                                                              |
| 9   | `3f5754e`, `190599c` | Release                     | README rewrite (highlights, reviewer quick tour), `CHANGELOG.md`, `docs/DEMO_SCRIPT.md`, version 2.0.0. A fresh-clone test passed. Tagged `v2.0.0`                                                                                                                                          |

**After 2.0.0 (unreleased): production-quality polish.**

- Robust tie-break: an invalid commission ranks lowest.
- `normalizeHotelName` with Unicode NFC.
- Versioned, atomic Lua cache writes: an older run can't overwrite a newer one, and a partial result never
  replaces a complete one.
- `X-Coalesced` header, richer structured logs, broader secret redaction.
- An OpenAPI drift test.
- A 21-section README with Mermaid diagrams, plus a demo guide, design notes and a configuration reference.
- Two new real screenshots.

That added 82 tests; see [BUILD_REPORT](BUILD_REPORT.md#production-quality-polish-post-200-unreleased).

## 4. Problems found and fixed

| Problem                                                                                         | Fix                                                                                                |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| With Temporal down, the API took 92 s to answer 503                                             | gRPC deadlines; it now takes about 5 s                                                             |
| A failed typecheck was hidden behind a pipe and got committed                                   | Fixed and amended; every later gate ran with `pipefail`                                            |
| The Temporal test server doesn't support the coalescing conflict policy                         | The coalescing tests run on the real Temporal dev server                                           |
| The benchmark text claimed "1 run" when it measured 6                                           | The interpretation was rewritten to report the measured numbers                                    |
| An intermittent Postman failure when a warm-up tick overlapped the chaos tests                  | Warm-up run-now also waits for in-flight `coalesced` runs                                          |
| The duplicate review could create an empty cache entry that looked like a cache HIT             | The write is guarded by a Lua script that only writes if the city's data still exists, plus a test |
| Similar names ("Leela Palace" vs "Pearl Palace") were reported as duplicates                    | Mutual-best-match filtering                                                                        |
| A monitor test hung about 1 run in 3                                                            | Each poll query gets a deadline; it then passed 6 of 6                                             |
| The README quick tour failed on a fresh clone (`tsx` not found)                                 | Added `npm ci` to the tour                                                                         |
| A partial result overwrote a fresh complete cache, and an older run could overwrite a newer one | `writeCityOffers.lua` with a generation check and the `kept_complete` policy                       |
| An invalid commission (`NaN`, missing) could flip a price-tie winner                            | Invalid commission ranks lowest; invalid price or name is skipped                                  |

## 5. Deliberate differences from the plans

- **TypeScript 6.0.3** instead of 7, for ESLint compatibility.
- **AI model default:** `claude-haiku-4-5`, changeable with `LLM_MODEL`. My earlier claim that `claude-haiku-5-5`
  doesn't exist was wrong: the installed SDK lists it. It is untested here (no API key), so 4-5 stays the default.
- **Coalescing gives a few runs at large N, not exactly one.** The README reports the measured numbers.
- **Child workflows can't attach to a running workflow.** A warm-up that finds a user request already running
  reports that city as `coalesced`.
- **The Temporal UI in production** is reached over an SSH tunnel, not basic auth.
- **An extra header, `X-Workflow-Run-Id`,** proves coalescing. It's additive.

## 6. Verification snapshot

```
npm run lint && npm run typecheck && npm test   → 32 files, 309 tests passed
contract guard                                   → 4/4 passed (graded response unchanged since v1.0.0)
docker compose up --build -d                     → 6/6 services healthy
newman (run twice)                               → 61 requests, 148 assertions, 0 failed
npm run verify (run twice)                       → 10/10 checks passed
production override (local HTTPS via Caddy)      → newman 147/147 passed
fresh clone following the README                 → working (after the npm ci fix)
```

## 7. Still to do

- [ ] Push to GitHub and check the first CI and E2E runs. They've never run on GitHub.
- [x] `OWNER` placeholders replaced with `Vanisha-vc5`.
- [ ] Deploy to a VM (`docs/DEPLOYMENT.md`) and add the live URL to the README.
- [x] Screenshots: console, Temporal retries, Temporal schedule, OpenAPI, Redis filtering and the newman report.
- [ ] Optionally set `LLM_PROVIDER` to try the AI parser and the duplicate judge. Everything works without it.
- [ ] Local only: add the portable Node to PATH. Tests use `REDIS_URL=redis://localhost:6380/15` while port 6379
      is taken.

## 8. Commands

```bash
# Push
git remote add origin https://github.com/<your-username>/hotel-offer-orchestrator.git
git push -u origin main && git push origin v1.0.0 v2.0.0

# Run and check locally
docker compose up --build -d --wait
npm run verify                     # full end-to-end check, writes docs/verification-report.md
npm run benchmark                  # writes docs/benchmarks.md
# open http://localhost:3000/console, http://localhost:3000/docs and http://localhost:8080

# Deploy (on an Ubuntu 24.04 VM)
REPO_URL=https://github.com/<your-username>/hotel-offer-orchestrator.git bash setup-vm.sh
```
