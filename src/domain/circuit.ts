/**
 * Circuit-breaker state machine. PURE and DETERMINISTIC (runs inside the
 * supplier monitor workflow): the caller passes `now`.
 *
 *   closed ──(threshold consecutive failures)──▶ open
 *   open ──(cooldown elapsed, next probe)──▶ half_open
 *   half_open ──success──▶ closed      half_open ──failure──▶ open (new cooldown)
 */
export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  /** Epoch ms after which the next probe runs half-open; null unless open. */
  openUntil: number | null;
  /** Epoch ms of the last probe that updated this snapshot. */
  lastCheckedAt: number | null;
}

export interface CircuitPolicy {
  failureThreshold: number;
  cooldownMs: number;
}

export const CLOSED: CircuitSnapshot = {
  state: 'closed',
  consecutiveFailures: 0,
  openUntil: null,
  lastCheckedAt: null,
};

/** Returns the snapshot after one probe outcome at time `now`. */
export function applyProbe(
  prev: CircuitSnapshot,
  ok: boolean,
  now: number,
  policy: CircuitPolicy,
): CircuitSnapshot {
  const cooledDown = prev.state === 'open' && prev.openUntil !== null && now >= prev.openUntil;
  const phase: CircuitState = cooledDown ? 'half_open' : prev.state;

  if (ok) {
    // Still cooling down: stay open; the first probe after the cooldown decides.
    if (phase === 'open') return { ...prev, consecutiveFailures: 0, lastCheckedAt: now };
    return { state: 'closed', consecutiveFailures: 0, openUntil: null, lastCheckedAt: now };
  }

  const consecutiveFailures = prev.consecutiveFailures + 1;
  if (
    phase === 'half_open' ||
    (phase === 'closed' && consecutiveFailures >= policy.failureThreshold)
  ) {
    return {
      state: 'open',
      consecutiveFailures,
      openUntil: now + policy.cooldownMs,
      lastCheckedAt: now,
    };
  }
  return { ...prev, state: phase, consecutiveFailures, lastCheckedAt: now };
}

/** Serialises circuit states as `A=closed;B=open` for the X-Circuit-State header. */
export function formatCircuitHeader(states: Record<'A' | 'B', CircuitState>): string {
  return `A=${states.A};B=${states.B}`;
}
