/**
 * PURE and DETERMINISTIC: runs inside the Temporal workflow sandbox.
 * No Node built-ins, no I/O, no clocks, no randomness (enforced by ESLint).
 */
import { SUPPLIER_NAMES } from './types';
import type {
  Candidate,
  Decision,
  DecisionReason,
  HotelOffer,
  SelectionResult,
  SupplierHotel,
  SupplierId,
} from './types';

export type SupplierLists = Partial<Record<SupplierId, readonly SupplierHotel[]>>;

/** Supplier order also defines the final tie-break (A before B). */
const SUPPLIER_ORDER: readonly SupplierId[] = ['A', 'B'];

/** Dedupe key: trimmed, inner whitespace collapsed, lowercased. */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function displayName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function toCandidate(supplier: SupplierId, h: SupplierHotel): Candidate {
  return {
    supplier: SUPPLIER_NAMES[supplier],
    hotelId: h.hotelId,
    name: displayName(h.name),
    price: h.price,
    commissionPct: h.commissionPct,
  };
}

/**
 * Orders two candidates: lower price first, then higher commission (better margin),
 * then the candidate passed first (callers pass Supplier A first). Returns <0 if `a` wins.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.price !== b.price) return a.price - b.price;
  if (a.commissionPct !== b.commissionPct) return b.commissionPct - a.commissionPct;
  return 0;
}

/** Keeps the best offer per hotel within ONE supplier's list (suppliers can return duplicates). */
function bestPerHotel(
  supplier: SupplierId,
  hotels: readonly SupplierHotel[],
): Map<string, Candidate> {
  const best = new Map<string, Candidate>();
  for (const hotel of hotels) {
    const key = normalizeName(hotel.name);
    if (key === '') continue;
    const candidate = toCandidate(supplier, hotel);
    const current = best.get(key);
    if (!current || compareCandidates(candidate, current) < 0) best.set(key, candidate);
  }
  return best;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function decide(key: string, candidates: Candidate[]): Decision {
  const [first, second] = candidates as [Candidate, Candidate | undefined];
  let winner = first;
  let reason: DecisionReason = 'single_source';
  let savings = 0;

  if (second) {
    const cmp = compareCandidates(first, second);
    winner = cmp <= 0 ? first : second;
    const loser = winner === first ? second : first;
    if (first.price !== second.price) {
      reason = 'cheaper';
      savings = round2(loser.price - winner.price);
    } else if (first.commissionPct !== second.commissionPct) {
      reason = 'tie_higher_commission';
    } else {
      reason = 'tie_default';
    }
  }

  return {
    key,
    name: winner.name,
    candidates,
    winner: {
      name: winner.name,
      price: winner.price,
      supplier: winner.supplier,
      commissionPct: winner.commissionPct,
    },
    reason,
    savings,
  };
}

/**
 * Stable ordering used everywhere (and identical to Redis ZRANGEBYSCORE, which
 * orders equal scores by member bytes): price ascending, then normalized name.
 */
export function compareOffers(
  a: { price: number; key: string },
  b: { price: number; key: string },
): number {
  if (a.price !== b.price) return a.price - b.price;
  if (a.key < b.key) return -1;
  return a.key > b.key ? 1 : 0;
}

/**
 * Merges supplier lists into one offer per hotel.
 *
 * Rules (in order):
 *   1. dedupe by normalized name, inside each supplier list and across suppliers;
 *   2. lower price wins;
 *   3. equal price → higher commissionPct wins (better margin for us);
 *   4. still equal → Supplier A (deterministic default).
 */
export function selectBestOffers(lists: SupplierLists): SelectionResult {
  const perSupplier = SUPPLIER_ORDER.map((id) => bestPerHotel(id, lists[id] ?? []));

  const keys = new Set<string>();
  for (const map of perSupplier) for (const key of map.keys()) keys.add(key);

  const decisions: Decision[] = [];
  for (const key of keys) {
    const candidates = perSupplier
      .map((map) => map.get(key))
      .filter((c): c is Candidate => c !== undefined);
    decisions.push(decide(key, candidates));
  }

  decisions.sort((a, b) =>
    compareOffers({ price: a.winner.price, key: a.key }, { price: b.winner.price, key: b.key }),
  );
  const offers: HotelOffer[] = decisions.map((d) => d.winner);
  return { offers, decisions };
}
