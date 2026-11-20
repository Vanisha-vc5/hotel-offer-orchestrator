/** Domain types. Pure type declarations: safe to import from workflow code. */

export type SupplierId = 'A' | 'B';
export type SupplierName = 'Supplier A' | 'Supplier B';

export const SUPPLIER_NAMES: Record<SupplierId, SupplierName> = {
  A: 'Supplier A',
  B: 'Supplier B',
};

/** A record as returned by a supplier API. */
export interface SupplierHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}

/** The public offer. Exactly these four keys go over the wire (see README contract). */
export interface HotelOffer {
  name: string;
  price: number;
  supplier: SupplierName;
  commissionPct: number;
}

export type SupplierStatus = 'up' | 'down';
export type SuppliersStatus = Record<SupplierId, SupplierStatus>;
export type ResultStatus = 'complete' | 'partial';

export type DecisionReason = 'cheaper' | 'tie_higher_commission' | 'tie_default' | 'single_source';

export interface Candidate {
  supplier: SupplierName;
  hotelId: string;
  name: string;
  price: number;
  commissionPct: number;
}

/** Why a given offer won. Feeds GET /api/hotels/insights. */
export interface Decision {
  key: string;
  name: string;
  candidates: Candidate[];
  winner: HotelOffer;
  reason: DecisionReason;
  /** Price difference between the losing and the winning offer (0 when single-source or tied). */
  savings: number;
}

export interface SelectionResult {
  offers: HotelOffer[];
  decisions: Decision[];
}
