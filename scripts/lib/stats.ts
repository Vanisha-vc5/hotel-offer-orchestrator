/** Small, dependency-free statistics helpers for the benchmark (unit tested). */

/** Nearest-rank percentile (p in 0..100) of an unsorted sample. Returns 0 for an empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export interface LatencySummary {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarize(latenciesMs: readonly number[]): LatencySummary {
  const round = (n: number): number => Math.round(n);
  return {
    p50: round(percentile(latenciesMs, 50)),
    p95: round(percentile(latenciesMs, 95)),
    p99: round(percentile(latenciesMs, 99)),
    max: round(latenciesMs.length ? Math.max(...latenciesMs) : 0),
  };
}

export function distinctCount<T>(values: readonly T[]): number {
  return new Set(values).size;
}
