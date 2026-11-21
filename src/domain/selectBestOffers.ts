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

/**
 * The exact-match dedupe key used for offer selection and Redis members:
 *  1. Unicode NFC (canonically equivalent spellings, e.g. a precomposed "é" vs
 *     "e" + combining accent, become identical; compatibility forms are NOT folded);
 *  2. trim;  3. collapse every run of whitespace (incl. tabs, NBSP) to one space;
 *  4. lowercase.
 * Nothing else: no punctuation stripping, no stop-words, no fuzzy matching, so
 * "Leela Palace" and "Pearl Palace" stay different hotels. (Fuzzy similarity is a
 * separate, report-only feature: see similarity.ts / duplicates.ts.)
 */
export function normalizeHotelName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** @deprecated alias kept for existing imports; use normalizeHotelName. */
export const normalizeName = normalizeHotelName;

function displayName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** A usable price: a finite number ≥ 0. Offers without one cannot be ranked and are skipped. */
function isValidPrice(price: unknown): price is number {
  return typeof price === 'number' && Number.isFinite(price) && price >= 0;
}

/** A usable commission: a finite number ≥ 0. */
export function isValidCommission(commission: unknown): commission is number {
  return typeof commission === 'number' && Number.isFinite(commission) && commission >= 0;
}

/**
 * Commission as a tie-break rank. An invalid value (missing, null, NaN, ±Infinity,
 * negative, non-number) ranks BELOW every valid commission, including a valid 0,
 * so it can never win a tie against a known commission and never affects price.
 */
function commissionRank(commission: unknown): number {
  return isValidCommission(commission) ? commission : Number.NEGATIVE_INFINITY;
}

function toCandidate(supplier: SupplierId, h: SupplierHotel): Candidate {
  return {
    supplier: SUPPLIER_NAMES[supplier],
    hotelId: h.hotelId,
    name: displayName(h.name),
    price: h.price,
    // Public contract needs a number: an invalid commission is reported as 0.
    commissionPct: isValidCommission(h.commissionPct) ? h.commissionPct : 0,
  };
}

/**
 * Orders two offers for the same hotel. Returns < 0 if `a` wins, > 0 if `b` wins,
 * 0 for a full tie (callers then keep the one passed first: Supplier A).
 *   1. lower price ALWAYS wins (commission can never override a cheaper price);
 *   2. equal price → higher valid commission wins (better margin for us);
 *   3. still equal → 0 (deterministic supplier priority applied by the caller).
 */
function compareOffersFor(
  a: { price: number; commission: unknown },
  b: { price: number; commission: unknown },
): number {
  if (a.price !== b.price) return a.price < b.price ? -1 : 1;
  const ra = commissionRank(a.commission);
  const rb = commissionRank(b.commission);
  if (ra !== rb) return ra > rb ? -1 : 1;
  return 0;
}

interface Ranked {
  candidate: Candidate;
  /** Raw commission as received, used for ranking (the candidate holds the normalized value). */
  rawCommission: unknown;
}

/** Keeps the best offer per hotel within ONE supplier's list (suppliers can return duplicates). */
function bestPerHotel(supplier: SupplierId, hotels: readonly SupplierHotel[]): Map<string, Ranked> {
  const best = new Map<string, Ranked>();
  for (const hotel of hotels) {
    if (typeof hotel?.name !== 'string' || !isValidPrice(hotel.price)) continue;
    const key = normalizeHotelName(hotel.name);
    if (key === '') continue;
    const next: Ranked = {
      candidate: toCandidate(supplier, hotel),
      rawCommission: hotel.commissionPct,
    };
    const current = best.get(key);
    if (
      !current ||
      compareOffersFor(
        { price: next.candidate.price, commission: next.rawCommission },
        { price: current.candidate.price, commission: current.rawCommission },
      ) < 0
    ) {
      best.set(key, next);
    }
  }
  return best;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function decide(key: string, ranked: Ranked[]): Decision {
  const [first, second] = ranked as [Ranked, Ranked | undefined];
  let winner = first;
  let reason: DecisionReason = 'single_source';
  let savings = 0;

  if (second) {
    const cmp = compareOffersFor(
      { price: first.candidate.price, commission: first.rawCommission },
      { price: second.candidate.price, commission: second.rawCommission },
    );
    winner = cmp <= 0 ? first : second;
    const loser = winner === first ? second : first;
    if (first.candidate.price !== second.candidate.price) {
      reason = 'cheaper';
      savings = round2(loser.candidate.price - winner.candidate.price);
    } else if (commissionRank(first.rawCommission) !== commissionRank(second.rawCommission)) {
      reason = 'tie_higher_commission';
    } else {
      reason = 'tie_default';
    }
  }

  const w = winner.candidate;
  return {
    key,
    name: w.name,
    candidates: ranked.map((r) => r.candidate),
    winner: { name: w.name, price: w.price, supplier: w.supplier, commissionPct: w.commissionPct },
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
 *   1. dedupe by normalizeHotelName (exact match), inside each supplier list and across suppliers;
 *   2. lower price wins, always;
 *   3. equal price → higher commissionPct wins (better margin for us);
 *   4. still equal → Supplier A (deterministic supplier priority).
 *
 * Defensive policy for unvalidated input (the fetch activity already drops malformed
 * records at the boundary, so these only matter for other callers):
 *   - an offer with a missing/invalid name or price is skipped (it cannot be ranked);
 *   - an invalid commission ranks below every valid commission and is reported as 0.
 */
export function selectBestOffers(lists: SupplierLists): SelectionResult {
  const perSupplier = SUPPLIER_ORDER.map((id) => bestPerHotel(id, lists[id] ?? []));

  const keys = new Set<string>();
  for (const map of perSupplier) for (const key of map.keys()) keys.add(key);

  const decisions: Decision[] = [];
  for (const key of keys) {
    const ranked = perSupplier
      .map((map) => map.get(key))
      .filter((c): c is Ranked => c !== undefined);
    decisions.push(decide(key, ranked));
  }

  decisions.sort((a, b) =>
    compareOffers({ price: a.winner.price, key: a.key }, { price: b.winner.price, key: b.key }),
  );
  const offers: HotelOffer[] = decisions.map((d) => d.winner);
  return { offers, decisions };
}
