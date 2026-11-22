import type { SupplierHotel } from '../domain/types';

/**
 * Supplier B inventory. The delhi rows are the exact fixture from the spec and are
 * asserted by unit tests and the Postman collection — do not change them.
 */
export const supplierBHotels: SupplierHotel[] = [
  // delhi
  { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
  { hotelId: 'b2', name: 'Radison', price: 6150, city: 'delhi', commissionPct: 11 },
  { hotelId: 'b3', name: 'Taj Palace', price: 11900, city: 'delhi', commissionPct: 18 },
  { hotelId: 'b4', name: 'The Leela', price: 10200, city: 'delhi', commissionPct: 10 },
  { hotelId: 'b5', name: 'Ibis', price: 2900, city: 'delhi', commissionPct: 9 },
  { hotelId: 'b6', name: 'Hyatt Regency', price: 8400, city: 'delhi', commissionPct: 16 },

  // mumbai (Trident is a full tie with Supplier A → deterministic default to A)
  { hotelId: 'b10', name: 'Taj Mahal Palace', price: 17900, city: 'mumbai', commissionPct: 17 },
  { hotelId: 'b11', name: 'Trident', price: 9200, city: 'mumbai', commissionPct: 12 },
  { hotelId: 'b12', name: 'Holiday Inn', price: 6550, city: 'mumbai', commissionPct: 11 },
  { hotelId: 'b13', name: 'Sea Princess', price: 7300, city: 'mumbai', commissionPct: 13 },
  // Deliberately malformed record: dropped (and logged) by the fetch activity's validation.
  { hotelId: 'b14', name: '', price: -1, city: 'mumbai', commissionPct: 10 },

  // bangalore
  { hotelId: 'b20', name: 'ITC Gardenia', price: 10650, city: 'bangalore', commissionPct: 18 },
  { hotelId: 'b21', name: 'Taj West End', price: 12900, city: 'bangalore', commissionPct: 15 },
  { hotelId: 'b22', name: 'Fab Hotel', price: 2100, city: 'bangalore', commissionPct: 6 },

  // jaipur (Duplicate detection) — "Radison Blu" (typo), "Leela Palace" (stop-word), "Pearl Palace" are
  // near-duplicates of Supplier A; "Taj Jai Mahal Palace" looks similar but is a different hotel.
  { hotelId: 'b40', name: 'Radison Blu', price: 6900, city: 'jaipur', commissionPct: 13 },
  { hotelId: 'b41', name: 'Leela Palace', price: 15900, city: 'jaipur', commissionPct: 16 },
  { hotelId: 'b42', name: 'Taj Jai Mahal Palace', price: 21000, city: 'jaipur', commissionPct: 17 },
  { hotelId: 'b43', name: 'ITC Rajputana', price: 9600, city: 'jaipur', commissionPct: 13 },
  { hotelId: 'b44', name: 'Pearl Palace', price: 2500, city: 'jaipur', commissionPct: 9 },
  { hotelId: 'b45', name: 'Trident Jaipur', price: 8800, city: 'jaipur', commissionPct: 12 },
];
