import { describe, expect, it } from 'vitest';
import { headline, table } from '../../scripts/lib/benchmarkReport';
import type { Row } from '../../scripts/lib/benchmarkReport';
import { distinctCount, percentile, summarize } from '../../scripts/lib/stats';

describe('benchmark stats', () => {
  it('computes nearest-rank percentiles', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 99)).toBe(99);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBe(0);
    expect(percentile([3, 1, 2], 50)).toBe(2); // unsorted input
  });

  it('summarizes and rounds', () => {
    expect(summarize([10.4, 20.6, 30.5])).toEqual({ p50: 21, p95: 31, p99: 31, max: 31 });
  });

  it('counts distinct values', () => {
    expect(distinctCount(['a', 'a', 'b', null])).toBe(3);
  });
});

describe('benchmark report', () => {
  const row = (mode: 'on' | 'off', n: number, runs: number, a: number, b: number): Row => ({
    mode,
    n,
    runs,
    callsA: a,
    callsB: b,
    errors: 0,
    wallMs: 1,
    p50: 1,
    p95: 2,
    p99: 3,
    max: 4,
  });

  it('builds the headline at N=100 (or the largest level ≤ 100)', () => {
    const rows = [row('on', 100, 1, 1, 1), row('off', 100, 100, 100, 100), row('on', 200, 1, 1, 1)];
    expect(headline(rows)).toBe(
      '100 concurrent requests → 1 workflow run, 2 supplier calls (vs 100 runs and 200 calls without coalescing)',
    );
  });

  it('renders one Markdown row per measurement', () => {
    const md = table([row('on', 10, 1, 1, 1), row('off', 10, 10, 10, 10)]);
    expect(md).toHaveLength(4);
    expect(md[2]).toBe('| on | 10 | 1 | 2 | 3 | 4 | 1 | 1 | 1 | 0 |');
  });
});
