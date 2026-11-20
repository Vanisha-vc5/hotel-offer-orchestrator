# 3-minute demo script

A shot list for a screen recording. Times are cumulative. Before recording:

- `docker compose up -d --wait` (or `npm run verify` once)
- `curl -X DELETE localhost:3000/admin/chaos`
- Open three browser tabs: **Ops console** <http://localhost:3000/console>, **Temporal UI** <http://localhost:8080>
  and **API docs** <http://localhost:3000/docs>.
- Have a terminal ready in the repo.

| Time      | Show                                                                                                                                                                                   | Say (one line)                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 0:00–0:20 | README headline and architecture diagram                                                                                                                                               | "Two suppliers, Temporal orchestration, Redis filtering, and a graded API contract that never changes."       |
| 0:20–0:45 | Console → **Search** `delhi` → 7 rows. Click the **workflow link** → Temporal UI history (two parallel `fetchSupplierHotels`, then `persistOffers`)                                    | "Every request is a durable workflow. Here's this exact run."                                                 |
| 0:45–1:05 | Console → **Chaos**: set **B → down**. Search again: 6 rows from Supplier A, a **partial** chip. The health tile turns red and the pill shows **degraded**                             | "One supplier down gives a partial result, not an error page. Health shows degraded."                         |
| 1:05–1:25 | Click **Probe now** three times. Circuit B shows **open**. Search again: the response time chip drops to about 150 ms                                                                  | "The monitor workflow tripped the breaker. Requests now skip B instantly instead of spending 2 s on retries." |
| 1:25–1:50 | **Reset all**. Set **B → flaky**, then search. Switch to the Temporal UI: `fetchSupplierHotels(B)` shows **attempt 1 failed, attempt 2 failed, attempt 3 succeeded**. Result: complete | "Transient failures are retried by Temporal. The user never notices."                                         |
| 1:50–2:15 | Terminal: `npm run demo:coalescing` (20 requests → **1 run**), then show the table in `docs/benchmarks.md`                                                                             | "Concurrent requests share one workflow: 16.7× less supplier traffic at 200 concurrent requests."             |
| 2:15–2:35 | Console → **Ask**: `hotels in Mumbai between ₹5,000 and ₹9,000` → the interpretation chips and 2 results                                                                               | "Natural-language search: an LLM when configured, a deterministic parser always."                             |
| 2:35–2:55 | Console → **Insights** `jaipur`: the decision table, then **Possible duplicates** (Radisson Blu ≈ Radison Blu, likely same)                                                            | "It explains every decision, and flags near-duplicate listings without auto-merging them."                    |
| 2:55–3:00 | Terminal: tail of `docs/verification-report.md` (all ✅)                                                                                                                               | "And one command verifies all of it from a clean slate."                                                      |

**Afterwards:** `curl -X DELETE localhost:3000/admin/chaos`.

**Backup commands** if the UI misbehaves while recording:

```bash
curl -i "localhost:3000/api/hotels?city=delhi"
curl -X POST localhost:3000/admin/chaos/suppliers/B -H 'content-type: application/json' -d '{"mode":"down"}'
curl localhost:3000/health
for i in 1 2 3; do curl -s -X POST localhost:3000/admin/monitor/probe-now >/dev/null; done; curl localhost:3000/admin/circuits
```
