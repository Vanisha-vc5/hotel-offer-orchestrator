# Work Summary: hotel-offer-orchestrator

Everything done on this project so far, from the empty folder to the latest commit. Each step has full detail
in [BUILD_REPORT.md](BUILD_REPORT.md): decisions, problems and the verification output.

_Last updated: 2026-11-22._

|          |                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Releases | `v1.0.0` (the assignment) and `v2.0.0` (nine enhancements), plus unreleased production polish                                               |
| History  | 22 commits on `main`; the latest is `3ee97c8`                                                                                               |
| Size     | 153 tracked files, about 12,100 lines in `src/`, `test/` and `scripts/`                                                                     |
| Tests    | 309 automated tests in 32 files (unit, Temporal workflow, integration), plus a Postman collection of 61 requests and 148 assertions         |
| Local    | Everything passes: lint, typecheck, 309/309 tests, `npm run verify` 10/10, newman twice with 0 failures, all 6 containers healthy           |
| GitHub   | Pushed up to `2f43d43` with both tags. **CI ✅ green, E2E ❌ red** on that commit (see [§9](#9-github-status)). `3ee97c8` is not pushed yet |
| Contract | The graded response (a bare array of `{name, price, supplier, commissionPct}`) is byte-for-byte unchanged since v1.0.0                      |

---

## 1. Environment setup

- The only Node.js installed was **v6.10.1**. I installed a **portable Node 24.22.3 LTS** in
  `%LOCALAPPDATA%\node24`, with no admin rights and no change to PATH.
- I started Docker Desktop.
- Port 6379 was taken by another project's container. Every host port became configurable, and tests can use
  `REDIS_URL=redis://localhost:6380/15`.
- I checked every library and Docker image version before using it, and pinned it. Examples: Temporal SDK
  1.26.0, Express 5.3.0, TypeScript 6.0.3 (typescript-eslint doesn't support TS 7 yet), Redis 7.4.12, Caddy
  2.11.9, Playwright 1.65.1.

## 2. Version 1.0.0: the assignment (8 commits)

| Commit    | Phase       | Delivered                                                                                                                                                                                                                        |
| --------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `74c4dc6` | Scaffold    | Strict TypeScript, ESLint and Prettier, zod env config that fails fast, pino logging, a Temporal client and worker with retries and graceful shutdown, a multi-stage Debian-slim Dockerfile, and compose with 6 healthy services |
| `813471a` | Domain      | Pure `selectBestOffers`: name dedupe, cheaper wins, a price tie goes to the higher commission, then Supplier A. Includes a decision log                                                                                          |
| `d5c7e11` | Cache       | The Redis repository: hash-tagged keys, an atomic write (later replaced by a versioned Lua script, see §5), and a Lua script that filters by price _inside_ Redis. Chaos-aware mock suppliers                                    |
| `2ded466` | Temporal    | The workflow (parallel fetch, partial results, 503 when both fail), activities with typed retryable and non-retryable errors, request coalescing (`USE_EXISTING`), and a `status` query                                          |
| `a66bf6b` | API         | The exact contract (a bare 4-key array, with metadata in headers), validation, the error mapper, insights, `/health*`, admin and chaos routes, and OpenAPI at `/docs`                                                            |
| `46e388b` | Postman     | A 36-request collection that passes in newman twice in a row                                                                                                                                                                     |
| `1202d37` | Docs and CI | README, GitHub Actions, and gRPC deadlines (with Temporal down, the API used to take **92 s** to return 503; now it takes **5 s**)                                                                                               |
| `0959da7` | Polish      | Quieter test output                                                                                                                                                                                                              |

## 3. Version 2.0.0: nine enhancements (11 commits)

Each feature is behind an env flag and only _adds_ endpoints, fields or headers. With every flag off, the
system behaves exactly like v1.0.0.

| #   | Commit               | Enhancement                 | Highlights                                                                                                                                                                                                                                                                                    |
| --- | -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `f4c8c7e`            | Housekeeping                | Docs moved to `docs/`. A **contract guard test** freezes the graded response byte-for-byte. Tagged `v1.0.0`                                                                                                                                                                                   |
| 1   | `584c96d`            | Benchmark                   | Supplier call counters, an `X-Coalescing: off` operator override, and `npm run benchmark`. **100 concurrent requests → 6 runs and 12 supplier calls (vs 100 and 200). At N=200, 16.7× less supplier traffic and 4.8× faster p95**                                                             |
| 2   | `e9842a8`            | Monitor and circuit breaker | Long-running `supplier-monitor-A/B` workflows (durable timers, signals, a query, continue-as-new) and a `closed → open → half_open` breaker. With a supplier's circuit open, requests answer in about 0.25 s instead of about 2 s. New `X-Circuit-State` header and a `/health` monitor block |
| 3   | `07ac3c7`            | Cache warm-up               | A Temporal **Schedule** (`cache-warmup`, every 2 min, overlap `SKIP`) runs child workflows that coalesce with user requests                                                                                                                                                                   |
| 4   | `13a8089`            | Natural-language search     | `POST /api/hotels/ask`: an LLM parser (Anthropic or OpenAI-compatible, forced tool call, zod, 5 s timeout), a rules-parser fallback, and a Redis interpretation cache                                                                                                                         |
| 5   | `6a835fa`            | Deployment                  | `docker-compose.prod.yml` (Caddy with automatic HTTPS, internal-only services, required admin token, log rotation, memory limits), `deploy/setup-vm.sh`, `deploy/update.sh`, `docs/DEPLOYMENT.md`. **Tested locally over HTTPS**                                                              |
| 6   | `2437001`            | Duplicate detection         | Hand-written Jaro-Winkler and token-set similarity, mutual-best matching, and an LLM judge activity. Insights gains `possibleDuplicates` (report-only), with a new `jaipur` city                                                                                                              |
| 7   | `0a6311c`            | Ops console                 | `/console`: plain HTML, CSS and JS with no CDN. Search, ask, live health, chaos buttons and insights. Verified by a jsdom test against the real API                                                                                                                                           |
| 8   | `6753304`            | One-command verification    | `npm run verify` (clean stack, all tests, newman, chaos scenarios, benchmark) writes `docs/verification-report.md`. A separate E2E CI workflow                                                                                                                                                |
| 9   | `3f5754e`, `190599c` | Release                     | README rewrite, `CHANGELOG.md`, `docs/DEMO_SCRIPT.md`, version 2.0.0. A fresh-clone test passed. Tagged `v2.0.0`                                                                                                                                                                              |

## 4. Pre-push audit (2 commits: `602fbb8`, `2f43d43`)

Done for "Prompts 1–3" (audit and push, live deploy, screenshots). The local parts are complete.

- **Requirements traceability:** a README table linking every assignment requirement to its code and the test
  or Postman folder that proves it.
- **Security pass:**
  - The `X-Coalescing: off` override and the benchmark rate-limit bypass need a valid `ADMIN_TOKEN`, and they are
    off in production unless `ALLOW_COALESCING_OVERRIDE=true`.
  - `/admin` fails closed in production without a token, unless `ALLOW_OPEN_ADMIN=true` (local compose only).
  - Constant-time token comparison.
  - A secret scan with gitleaks found no leaks.
- **LLM cost guard:** `LLM_DAILY_CALL_LIMIT` (default 200 per UTC day, a Redis counter). Once it is reached, or if
  the counter is unreachable, the deterministic fallbacks answer.
- **LLM is optional:** the default is `LLM_PROVIDER=none` and production forces it. The core assignment needs no
  API key. Only `/api/hotels/ask` and the duplicate judge can use an LLM, and both have deterministic fallbacks.
- **Model ID check:** the default stays `claude-haiku-4-5`. My earlier claim that `claude-haiku-5-5` doesn't exist
  was wrong (the installed SDK lists it) and was corrected in the docs.
- **Smoke tests:** `npm run smoke -- --url <base-url>` checks health, the delhi contract byte-for-byte, the
  filter, `/console` and `/docs`.
- **Screenshots:** `npm run screenshots` (Playwright + sharp) captures real images from the running stack.
- **Deploy docs:** PowerShell equivalents for Windows; production defaults `LLM_PROVIDER=none`.
- **`OWNER` placeholders** were replaced with `Vanisha-vc5`.

## 5. Production-quality polish (1 commit: `3ee97c8`, not pushed yet)

Done for the ten-part "Improve and Polish" brief. Existing code was inspected first, and anything already
correct was kept and verified rather than rewritten.

**Offer selection (Parts 1–2)**

- Price always wins first, then the higher commission, then Supplier A.
- A missing, `null`, `NaN`, infinite or negative commission ranks **lowest** in the tie-break: it can never beat
  a valid commission or a cheaper price. It is returned as `commissionPct: 0`.
- An offer with an invalid price or an empty name is skipped.
- `normalizeHotelName`: Unicode NFC, trim, fold all whitespace (including non-breaking spaces), lowercase. NFKC
  was rejected because it could merge genuinely different names.
- Similar names ("Leela Palace" and "Pearl Palace") are never merged. Fuzzy duplicate detection stays report-only.

**Redis cache (Part 3)**

- A new `writeCityOffers.lua` replaces the `MULTI` write. It is one atomic script with a **version check**:
  - each run is stamped with its start time (`generation`), and an older run's write is rejected (`stale`);
  - a partial result never replaces a still-valid complete entry (`kept_complete`), and does not extend its TTL;
  - a partial result still fills an empty slot, with the 30 s TTL;
  - when both suppliers are down, nothing is written, so the cache is never deleted or degraded.
- Filtered responses report the headers of the data actually served.
- Already correct and kept: TTLs on all three keys (300 s complete, 30 s partial), cached-empty vs miss, and
  inclusive filtering inside Redis.

**Observability and API docs (Parts 6–7)**

- A new `X-Coalesced` header (additive), on workflow-backed responses only.
- New log lines:
  - `workflow started or joined` and `workflow completed`, with `requestId`, `originRequestId`, `coalesced`,
    workflow type and duration;
  - per-supplier hotel counts and the count after dedupe;
  - the cache-write outcome, and the Lua filter time (`filterMs`).
- Redaction now covers auth headers, cookies, `ADMIN_TOKEN`, LLM and Temporal keys, and any
  `token`/`password`/`secret`/`apiKey` field.
- OpenAPI now documents the exact validation rules, and a **drift test** checks that every route, example and
  emitted header matches the real API.

**Docs and demo (Parts 4, 5, 8)**

- The README was rewritten into the **21 requested sections** (998 → 611 lines), with WHY explanations,
  required vs optional, examples and status codes.
- Two **Mermaid diagrams** (architecture and request sequence), checked against the code and confirmed to
  render. They are also saved in `docs/diagrams/`.
- New docs: `DEMO_GUIDE.md` (normal, A down, B down, both down, filtering, coalescing, circuit breaker, each with
  real output), `DESIGN_NOTES.md` and `CONFIGURATION.md`.
- Real screenshots: console, Temporal retries, Temporal schedule, OpenAPI, **Redis filtering** (`Cache HIT`,
  2.4 ms) and the **newman report** (61 requests, 148 assertions, 0 failed).

**Tests (Part 9):** 82 new tests (227 → 309) in 5 new files: `selection.policy`, `cachePolicy` (a real Redis
`MONITOR` proves filtering runs in one Lua call), `cacheApi`, `logger.redact` and `openapi.drift`. No existing
test was weakened or removed.

## 6. Problems found and fixed

| Problem                                                                                         | Fix                                                                                             |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| With Temporal down, the API took 92 s to answer 503                                             | gRPC deadlines; it now takes about 5 s                                                          |
| A failed typecheck was hidden behind a pipe and got committed                                   | Fixed and amended; every later gate runs with `pipefail`                                        |
| The Temporal test server doesn't support the coalescing conflict policy                         | The coalescing tests run on the real Temporal dev server                                        |
| The benchmark text claimed "1 run" when it measured 6                                           | The interpretation reports the measured numbers                                                 |
| An intermittent Postman failure when a warm-up tick overlapped the chaos tests                  | Warm-up run-now also waits for in-flight `coalesced` runs                                       |
| The duplicate review could create an empty cache entry that looked like a HIT                   | A Lua script writes only while the city's data still exists, plus a test                        |
| Similar names ("Leela Palace" vs "Pearl Palace") were reported as duplicates                    | Mutual-best-match filtering                                                                     |
| A monitor test hung about 1 run in 3                                                            | Each poll query gets a deadline                                                                 |
| The README quick tour failed on a fresh clone (`tsx` not found)                                 | Added `npm ci` to the tour                                                                      |
| `/admin` fail-closed broke the local compose stack (it runs `NODE_ENV=production`)              | `ALLOW_OPEN_ADMIN` (true in local compose, false in production)                                 |
| The smoke script reported 0 ms timings                                                          | It awaits the check before reading the clock                                                    |
| An invalid commission (`NaN`, missing) could flip a price-tie winner                            | Invalid commission ranks lowest; invalid price or name is skipped                               |
| A partial result overwrote a fresh complete cache, and an older run could overwrite a newer one | `writeCityOffers.lua` with a generation check and the `kept_complete` policy                    |
| My edit script's `replace()` expanded `$'` and duplicated half of `src/api/openapi.ts`          | Restored from git and re-edited with the function form of `replace`; other files audited        |
| The first newman screenshot captured a **failed** run from an unlocked `npx` install            | Caught on review, deleted, regenerated from the locked newman, and checked for 0 failures first |

## 7. Deliberate decisions and differences from the plans

- **TypeScript 6.0.3** instead of 7, for ESLint compatibility.
- **A Lua version check instead of a distributed lock** for concurrent cache writes: simpler, with no lock to
  leak.
- **The unfiltered endpoint always runs a fresh workflow**, as the brief requires. Only the cache write is
  conditional.
- **Metadata only in headers** (`X-Workflow-Run-Id`, `X-Coalesced`, `X-Circuit-State` and others). The response
  body is always exactly the four keys.
- **Coalescing gives a few runs at large N, not exactly one.** The README reports the measured numbers.
- **Child workflows can't attach to a running workflow.** A warm-up that finds a user request already running
  reports that city as `coalesced`.
- **The Temporal UI in production** is reached over an SSH tunnel, not exposed publicly.
- **The default LLM model is `claude-haiku-4-5`.** It is changeable with `LLM_MODEL`, and it is untested here
  because there is no API key.

## 8. Verification snapshot (latest, on `3ee97c8`)

```
npm run lint / format:check / typecheck   → clean
npm test                                  → 32 files, 309 tests passed
npm run verify (clean slate, 211 s)       → ✅ 10/10: 138 unit + 17 workflow + 154 integration tests;
                                             newman 61 requests / 148 assertions / 0 failed;
                                             5 chaos scenarios; benchmark N=50 (on: 3 runs, off: 50 runs)
npm run test:postman ×2 (same stack)      → 61 / 148 / 0 failed, both runs
docker compose ps                         → api, worker, redis, temporal, temporal-ui, postgresql: healthy
gitleaks (working tree)                   → no leaks found
Mermaid 11.4.1 in Chromium                → all diagram blocks render
contract guard                            → passing (graded response unchanged since v1.0.0)
```

## 9. GitHub status

- `main` is pushed up to `2f43d43`, and both tags `v1.0.0` and `v2.0.0` are on GitHub.
- On `2f43d43`, the **CI** workflow (lint, format, typecheck, tests, Docker build, newman) **passed** ✅.
- On `2f43d43`, the **E2E** workflow **failed** ❌ in the step "Verify (stack + tests + newman + chaos +
  benchmark)", after about 3 minutes. GitHub serves the job log and the uploaded verification report only to
  signed-in users, so the cause is not known yet. The same `npm run verify` passes 10/10 locally.
- `3ee97c8` (the production polish) is committed locally but **not pushed**.

## 10. Still to do

- [ ] **Fix the red E2E badge.** Download the `verification-report` artifact or the job log from the failed run
      ([run 44878809591](https://github.com/Vanisha-vc5/hotel-offer-orchestrator/actions/runs/44878809591)), find
      the failing check, fix it, and re-run until green.
- [ ] Push `3ee97c8` (`git push origin main`) and confirm CI and E2E are both green.
- [ ] Deploy to a VM ([DEPLOYMENT.md](DEPLOYMENT.md)), run `npm run smoke` and Postman against it, and put the
      live URL in the README.
- [ ] Optional: set `LLM_PROVIDER` to try the AI parser and the duplicate judge. Everything works without it.
- [ ] Local only: your `.env` has `SERVICE_VERSION=1.0.0`, so `/health` reports 1.0.0. `.env.example` says 2.0.0.
- [x] Screenshots, README restructure, diagrams, demo guide, cache correctness, selection robustness and
      observability.

## 11. Commands

```bash
# Push the latest commit
git push origin main

# Run and check locally (Node 24 on PATH)
docker compose up --build -d --wait
npm run verify                     # full end-to-end check, writes docs/verification-report.md
npm run test:postman               # Postman collection via newman
npm run demo:coalescing            # 20 concurrent requests → 1 workflow run
npm run screenshots                # regenerates docs/images/*.png from the running stack
# open http://localhost:3000/console, http://localhost:3000/docs and http://localhost:8080

# Deploy (on an Ubuntu 24.04 VM)
REPO_URL=https://github.com/Vanisha-vc5/hotel-offer-orchestrator.git PUBLIC_DOMAIN=<domain or ip.sslip.io> \
  bash deploy/setup-vm.sh
npm run smoke -- --url https://<domain>
```

## 12. Where to find things

| Document                                         | Contents                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| [README.md](../README.md)                        | the 21-section project overview with diagrams and screenshots      |
| [DEMO_GUIDE.md](DEMO_GUIDE.md)                   | how to demonstrate every scenario, with real outputs               |
| [DEMO_SCRIPT.md](DEMO_SCRIPT.md)                 | a timed 3-minute screen-recording script                           |
| [DESIGN_NOTES.md](DESIGN_NOTES.md)               | the detailed reasoning behind each design decision                 |
| [CONFIGURATION.md](CONFIGURATION.md)             | every environment variable and its default                         |
| [DEPLOYMENT.md](DEPLOYMENT.md)                   | VM deployment, Windows commands, backups, alternatives             |
| [BUILD_REPORT.md](BUILD_REPORT.md)               | how each phase was built and verified, with problems and decisions |
| [benchmarks.md](benchmarks.md)                   | the full coalescing benchmark table                                |
| [verification-report.md](verification-report.md) | the latest `npm run verify` result                                 |
| [CHANGELOG.md](../CHANGELOG.md)                  | changes per release                                                |
| [SPEC.md](SPEC.md)                               | the original assignment                                            |
| `docs/diagrams/`                                 | Mermaid sources of the architecture and request-sequence diagrams  |
