/** Pure helpers that turn benchmark rows into Markdown (unit tested). */
import type { LatencySummary } from './stats';

export type Mode = 'on' | 'off';

export interface Row extends LatencySummary {
  mode: Mode;
  n: number;
  runs: number;
  callsA: number;
  callsB: number;
  errors: number;
  wallMs: number;
}

export function table(rows: Row[]): string[] {
  const out = [
    '| Coalescing | N | p50 ms | p95 ms | p99 ms | max ms | workflow runs | Supplier A calls | Supplier B calls | errors |',
    '| ---------- | -: | -----: | -----: | -----: | -----: | ------------: | ---------------: | ---------------: | -----: |',
  ];
  for (const r of rows) {
    out.push(
      `| ${r.mode} | ${r.n} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.runs} | ${r.callsA} | ${r.callsB} | ${r.errors} |`,
    );
  }
  return out;
}

export function headline(rows: Row[]): string {
  const target = Math.max(...rows.map((r) => r.n).filter((n) => n <= 100));
  const on = rows.find((r) => r.mode === 'on' && r.n === target);
  const off = rows.find((r) => r.mode === 'off' && r.n === target);
  if (!on || !off) return '';
  return (
    `${target} concurrent requests → ${on.runs} workflow run${on.runs === 1 ? '' : 's'}, ` +
    `${on.callsA + on.callsB} supplier calls (vs ${off.runs} runs and ${off.callsA + off.callsB} calls without coalescing)`
  );
}

export function interpretation(rows: Row[], city: string): string {
  const big = Math.max(...rows.map((r) => r.n));
  const on = rows.find((r) => r.mode === 'on' && r.n === big);
  const off = rows.find((r) => r.mode === 'off' && r.n === big);
  if (!on || !off) return '';
  const calls = (r: Row): number => r.callsA + r.callsB;
  const factor = (x: number, y: number): string => (y > 0 ? `${(x / y).toFixed(1)}×` : 'n/a');
  const onRuns = rows
    .filter((r) => r.mode === 'on')
    .map((r) => `${r.runs} at N=${r.n}`)
    .join(', ');
  return (
    `With coalescing off, every request starts its own workflow, so workflow runs and supplier calls grow ` +
    `linearly with N (${off.runs} runs and ${calls(off)} supplier calls at N=${big}). With coalescing on, ` +
    `concurrent requests attach to the run already in flight for \`hotel-offers-${city}\` ` +
    `(\`workflowIdConflictPolicy: USE_EXISTING\`), and runs grow far more slowly (${onRuns}). They don't ` +
    `collapse to exactly one because a burst of N requests reaches Temporal spread over time (the API issues ` +
    `N start calls), while a run lasts only ~150 ms. A request arriving after a run has closed correctly ` +
    `starts a fresh one (\`ALLOW_DUPLICATE\`): fresh data, never a stale result. At N=${big} that means ` +
    `${factor(calls(off), calls(on))} less supplier traffic and a p95 of ${on.p95} ms instead of ` +
    `${off.p95} ms (${factor(off.p95, on.p95)} faster), because Temporal and the suppliers do a fraction of ` +
    `the work. Absolute latencies come from one laptop running every service in Docker; the ratios are what ` +
    `matters.`
  );
}
