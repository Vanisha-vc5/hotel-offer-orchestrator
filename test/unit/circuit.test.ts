import { describe, expect, it } from 'vitest';
import { CLOSED, applyProbe, formatCircuitHeader } from '../../src/domain/circuit';
import type { CircuitSnapshot } from '../../src/domain/circuit';

const policy = { failureThreshold: 3, cooldownMs: 30_000 };
const run = (
  outcomes: Array<[boolean, number]>,
  start: CircuitSnapshot = CLOSED,
): CircuitSnapshot => outcomes.reduce((s, [ok, at]) => applyProbe(s, ok, at, policy), start);

describe('circuit breaker state machine', () => {
  it('stays closed below the failure threshold and resets the count on success', () => {
    expect(
      run([
        [false, 1],
        [false, 2],
      ]),
    ).toMatchObject({ state: 'closed', consecutiveFailures: 2 });
    expect(
      run([
        [false, 1],
        [false, 2],
        [true, 3],
      ]),
    ).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
  });

  it('opens after N consecutive failures with openUntil = now + cooldown', () => {
    expect(
      run([
        [false, 1],
        [false, 2],
        [false, 3],
      ]),
    ).toEqual({
      state: 'open',
      consecutiveFailures: 3,
      openUntil: 30_003,
      lastCheckedAt: 3,
    });
  });

  it('stays open during the cooldown, even if a probe succeeds', () => {
    const open = run([
      [false, 1],
      [false, 2],
      [false, 3],
    ]);
    expect(applyProbe(open, true, 10_000, policy)).toMatchObject({
      state: 'open',
      openUntil: 30_003,
    });
    expect(applyProbe(open, false, 10_000, policy)).toMatchObject({
      state: 'open',
      openUntil: 30_003,
    });
  });

  it('half-open probe after the cooldown: success closes', () => {
    const open = run([
      [false, 1],
      [false, 2],
      [false, 3],
    ]);
    expect(applyProbe(open, true, 30_003, policy)).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
      openUntil: null,
      lastCheckedAt: 30_003,
    });
  });

  it('half-open probe after the cooldown: failure re-opens with a new cooldown', () => {
    const open = run([
      [false, 1],
      [false, 2],
      [false, 3],
    ]);
    expect(applyProbe(open, false, 40_000, policy)).toMatchObject({
      state: 'open',
      openUntil: 70_000,
    });
  });

  it('formats the X-Circuit-State header', () => {
    expect(formatCircuitHeader({ A: 'closed', B: 'open' })).toBe('A=closed;B=open');
  });
});
