import type { SupplierHotel } from '../domain/types';

/**
 * Supplier A inventory. The delhi rows are the exact fixture from the spec and are
 * asserted by unit tests and the Postman collection — do not change them.
 */
export const supplierAHotels: SupplierHotel[] = [
  // delhi
  { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
  { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
  { hotelId: 'a3', name: 'Taj Palace', price: 12500, city: 'delhi', commissionPct: 15 },
  { hotelId: 'a4', name: 'The Leela', price: 9800, city: 'delhi', commissionPct: 12 },
  { hotelId: 'a5', name: 'Lemon Tree', price: 3200, city: 'delhi', commissionPct: 8 },
  { hotelId: 'a6', name: 'Hyatt Regency', price: 8400, city: 'delhi', commissionPct: 14 },

  // mumbai
  { hotelId: 'a10', name: 'Taj Mahal Palace', price: 18500, city: 'mumbai', commissionPct: 15 },
  { hotelId: 'a11', name: 'Trident', price: 9200, city: 'mumbai', commissionPct: 12 },
  { hotelId: 'a12', name: 'Holiday Inn', price: 6400, city: 'mumbai', commissionPct: 10 },
  { hotelId: 'a13', name: 'ITC Maratha', price: 11800, city: 'mumbai', commissionPct: 14 },
  { hotelId: 'a14', name: 'Ginger', price: 2800, city: 'mumbai', commissionPct: 7 },

  // bangalore (a21 is a deliberate in-supplier duplicate of a20, differently spaced)
  { hotelId: 'a20', name: 'ITC Gardenia', price: 10500, city: 'bangalore', commissionPct: 14 },
  { hotelId: 'a21', name: ' itc  gardenia ', price: 10900, city: 'bangalore', commissionPct: 14 },
  { hotelId: 'a22', name: 'Taj West End', price: 13200, city: 'bangalore', commissionPct: 16 },
  { hotelId: 'a23', name: 'Lemon Tree', price: 3500, city: 'bangalore', commissionPct: 8 },

  // goa — only Supplier A has inventory here (single-supplier city)
  { hotelId: 'a30', name: 'Taj Exotica', price: 14200, city: 'goa', commissionPct: 15 },
  { hotelId: 'a31', name: 'Novotel', price: 7800, city: 'goa', commissionPct: 11 },
  { hotelId: 'a32', name: 'Zostel', price: 1500, city: 'goa', commissionPct: 5 },
];
