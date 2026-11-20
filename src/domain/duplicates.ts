/**
 * Near-duplicate candidate selection across suppliers (report-only).
 * PURE and DETERMINISTIC: runs inside the duplicate-review workflow.
 */
import { normalizeName } from './selectBestOffers';
import { nameSimilarity } from './similarity';
import type { Decision, SupplierName } from './types';

export const LIKELY_SAME_THRESHOLD = 0.92;
export const REVIEW_THRESHOLD = 0.75;

export type DuplicateVerdict = 'likely_same' | 'different' | 'uncertain';
export type DecidedBy = 'similarity' | 'llm';

export interface OfferRef {
  name: string;
  supplier: SupplierName;
  price: number;
}

export interface DuplicatePair {
  a: OfferRef;
  b: OfferRef;
  similarity: number;
}

export interface PossibleDuplicate extends DuplicatePair {
  verdict: DuplicateVerdict;
  decidedBy: DecidedBy;
  reason: string;
  /** If they are the same hotel, booking the cheaper offer saves this much. */
  potentialSavings: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Pairs (Supplier A offer, Supplier B offer) whose normalized names differ but
 * look alike. A pair is kept only when each side is the other's best match
 * (mutual best), so a hotel with an exact counterpart can't also be paired
 * with a merely similar-looking one.
 */
export function findDuplicatePairs(
  decisions: readonly Decision[],
  city: string,
  minScore = REVIEW_THRESHOLD,
): DuplicatePair[] {
  const offers = decisions.flatMap((d) => d.candidates);
  const listA = offers.filter((c) => c.supplier === 'Supplier A');
  const listB = offers.filter((c) => c.supplier === 'Supplier B');
  if (!listA.length || !listB.length) return [];

  const score = listA.map((a) => listB.map((b) => nameSimilarity(a.name, b.name, city)));
  const bestForA = score.map((row) => Math.max(...row));
  const bestForB = listB.map((_, j) => Math.max(...score.map((row) => row[j] ?? 0)));

  const pairs: DuplicatePair[] = [];
  listA.forEach((a, i) => {
    listB.forEach((b, j) => {
      const s = score[i]?.[j] ?? 0;
      if (s < minScore || normalizeName(a.name) === normalizeName(b.name)) return;
      if (s < (bestForA[i] ?? 0) || s < (bestForB[j] ?? 0)) return; // not mutual best
      pairs.push({
        a: { name: a.name, supplier: a.supplier, price: a.price },
        b: { name: b.name, supplier: b.supplier, price: b.price },
        similarity: round3(s),
      });
    });
  });
  return pairs.sort(
    (x, y) =>
      y.similarity - x.similarity || (x.a.name < y.a.name ? -1 : x.a.name > y.a.name ? 1 : 0),
  );
}

/** Verdict for a pair that does not need a judge (score ≥ LIKELY_SAME_THRESHOLD). */
export function similarityVerdict(pair: DuplicatePair): PossibleDuplicate {
  return {
    ...pair,
    verdict: 'likely_same',
    decidedBy: 'similarity',
    reason: `Names match after normalization (similarity ${pair.similarity.toFixed(2)})`,
    potentialSavings: Math.abs(pair.a.price - pair.b.price),
  };
}

export function withVerdict(
  pair: DuplicatePair,
  verdict: DuplicateVerdict,
  decidedBy: DecidedBy,
  reason: string,
): PossibleDuplicate {
  return {
    ...pair,
    verdict,
    decidedBy,
    reason,
    potentialSavings: Math.abs(pair.a.price - pair.b.price),
  };
}
