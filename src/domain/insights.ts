import type { Decision, DecisionReason, SupplierName } from './types';

export interface HotelInsight {
  name: string;
  winner: { supplier: SupplierName; price: number; commissionPct: number };
  reason: DecisionReason;
  /** How much cheaper the winner is than the other supplier's offer. */
  savings: number;
  offers: Array<{ supplier: SupplierName; hotelId: string; price: number; commissionPct: number }>;
}

export interface InsightsSummary {
  hotels: number;
  overlapping: number;
  singleSource: number;
  winsBySupplier: Record<SupplierName, number>;
  reasons: Record<DecisionReason, number>;
  /** Sum over hotels of (worst offer − winning offer). */
  totalSavings: number;
  /** Mean commission of the winning offers (margin indicator). */
  avgWinnerCommissionPct: number;
}

/** Turns the persisted decision log into an explainability report. Pure. */
export function buildInsights(decisions: readonly Decision[]): {
  summary: InsightsSummary;
  hotels: HotelInsight[];
} {
  const winsBySupplier: Record<SupplierName, number> = { 'Supplier A': 0, 'Supplier B': 0 };
  const reasons: Record<DecisionReason, number> = {
    cheaper: 0,
    tie_higher_commission: 0,
    tie_default: 0,
    single_source: 0,
  };
  let totalSavings = 0;
  let commissionSum = 0;

  const hotels = decisions.map((d): HotelInsight => {
    winsBySupplier[d.winner.supplier]++;
    reasons[d.reason]++;
    totalSavings += d.savings;
    commissionSum += d.winner.commissionPct;
    return {
      name: d.name,
      winner: {
        supplier: d.winner.supplier,
        price: d.winner.price,
        commissionPct: d.winner.commissionPct,
      },
      reason: d.reason,
      savings: d.savings,
      offers: d.candidates.map((c) => ({
        supplier: c.supplier,
        hotelId: c.hotelId,
        price: c.price,
        commissionPct: c.commissionPct,
      })),
    };
  });

  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return {
    summary: {
      hotels: decisions.length,
      overlapping: decisions.filter((d) => d.candidates.length > 1).length,
      singleSource: reasons.single_source,
      winsBySupplier,
      reasons,
      totalSavings: round2(totalSavings),
      avgWinnerCommissionPct: decisions.length ? round2(commissionSum / decisions.length) : 0,
    },
    hotels,
  };
}
