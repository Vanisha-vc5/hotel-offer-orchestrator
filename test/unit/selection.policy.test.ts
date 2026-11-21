/**
 * Selection policy and name normalization edge cases (in addition to
 * selectBestOffers.test.ts, which covers the spec fixtures).
 */
import { describe, expect, it } from 'vitest';
import {
  isValidCommission,
  normalizeHotelName,
  normalizeName,
  selectBestOffers,
} from '../../src/domain/selectBestOffers';
import type { SupplierHotel } from '../../src/domain/types';

let seq = 0;
/** Builds a supplier record; `commission` may be any (invalid) value on purpose. */
function h(name: string, price: number, commission: unknown): SupplierHotel {
  // Cast: tests deliberately feed unvalidated commission values.
  return { hotelId: `x${++seq}`, name, price, city: 'test', commissionPct: commission as number };
}

const pick = (A: SupplierHotel[], B: SupplierHotel[]) => selectBestOffers({ A, B });

describe('normalizeHotelName', () => {
  it.each([
    ['  The Grand Hotel  ', 'the grand hotel'],
    ['THE GRAND HOTEL', 'the grand hotel'],
    ['The Grand  Hotel', 'the grand hotel'],
    ['The\tGrand\nHotel', 'the grand hotel'],
    ['The Grand Hotel', 'the grand hotel'], // non-breaking space
  ])('%j → %j', (input, expected) => {
    expect(normalizeHotelName(input)).toBe(expected);
  });

  it('treats canonically equivalent Unicode spellings as the same name (NFC)', () => {
    const precomposed = 'Hôtel Café'; // ô, é as single code points
    const decomposed = 'Hôtel Café'; // o + ◌̂, e + ◌́
    expect(precomposed).not.toBe(decomposed);
    expect(normalizeHotelName(precomposed)).toBe(normalizeHotelName(decomposed));
    expect(normalizeHotelName(decomposed)).toBe('hôtel café');
  });

  it('returns "" for empty and whitespace-only names', () => {
    expect(normalizeHotelName('')).toBe('');
    expect(normalizeHotelName('   \t\n ')).toBe('');
  });

  it('does not merge different hotels that merely look alike', () => {
    expect(normalizeHotelName('Leela Palace')).not.toBe(normalizeHotelName('Pearl Palace'));
    expect(normalizeHotelName('Radisson Blu')).not.toBe(normalizeHotelName('Radison Blu'));
    expect(normalizeHotelName('The Leela Palace')).not.toBe(normalizeHotelName('Leela Palace'));
    expect(normalizeHotelName('Hotel-Ibis')).not.toBe(normalizeHotelName('Hotel Ibis'));
  });

  it('keeps the old normalizeName export working', () => {
    expect(normalizeName('  A  B ')).toBe(normalizeHotelName('  A  B '));
  });
});

describe('selectBestOffers: price always first', () => {
  it('Supplier A cheaper wins even with a much lower commission', () => {
    const { offers, decisions } = pick([h('Grand', 4000, 1)], [h('Grand', 4001, 50)]);
    expect(offers).toEqual([
      { name: 'Grand', price: 4000, supplier: 'Supplier A', commissionPct: 1 },
    ]);
    expect(decisions[0]).toMatchObject({ reason: 'cheaper', savings: 1 });
  });

  it('Supplier B cheaper wins even when A has the higher commission', () => {
    const { offers } = pick([h('Grand', 5000, 30)], [h('Grand', 4999, 2)]);
    expect(offers[0]).toMatchObject({ supplier: 'Supplier B', price: 4999, commissionPct: 2 });
  });

  it('equal prices: higher commission wins (either supplier)', () => {
    expect(pick([h('G', 100, 10)], [h('G', 100, 12)]).offers[0]?.supplier).toBe('Supplier B');
    expect(pick([h('G', 100, 12)], [h('G', 100, 10)]).offers[0]?.supplier).toBe('Supplier A');
  });

  it('equal prices and commissions: Supplier A (deterministic)', () => {
    const { offers, decisions } = pick([h('G', 100, 10)], [h('G', 100, 10)]);
    expect(offers[0]?.supplier).toBe('Supplier A');
    expect(decisions[0]?.reason).toBe('tie_default');
  });
});

describe('selectBestOffers: invalid commission policy', () => {
  const INVALID: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -5],
    ['string', '15'],
  ];

  it.each(INVALID)('isValidCommission(%s) is false', (_label, value) => {
    expect(isValidCommission(value)).toBe(false);
  });

  it.each(INVALID)(
    'missing/invalid (%s) from A loses a price tie to a valid B commission',
    (_l, value) => {
      const { offers, decisions } = pick([h('G', 100, value)], [h('G', 100, 3)]);
      expect(offers[0]).toEqual({
        name: 'G',
        price: 100,
        supplier: 'Supplier B',
        commissionPct: 3,
      });
      expect(decisions[0]?.reason).toBe('tie_higher_commission');
    },
  );

  it.each(INVALID)(
    'missing/invalid (%s) from B loses a price tie to a valid A commission of 0',
    (_l, value) => {
      const { offers } = pick([h('G', 100, 0)], [h('G', 100, value)]);
      expect(offers[0]).toMatchObject({ supplier: 'Supplier A', commissionPct: 0 });
    },
  );

  it('both commissions invalid: full tie → Supplier A, reported commission 0', () => {
    const { offers, decisions } = pick([h('G', 100, null)], [h('G', 100, Number.NaN)]);
    expect(offers[0]).toEqual({ name: 'G', price: 100, supplier: 'Supplier A', commissionPct: 0 });
    expect(decisions[0]?.reason).toBe('tie_default');
  });

  it('an invalid commission never overrides a cheaper price', () => {
    const { offers } = pick([h('G', 99, undefined)], [h('G', 100, 40)]);
    expect(offers[0]).toMatchObject({ supplier: 'Supplier A', price: 99, commissionPct: 0 });
  });

  it('never emits a non-number commission in the public 4-key offer', () => {
    const { offers } = pick([h('X', 10, 'abc'), h('Y', 20, -1)], [h('Z', 30, undefined)]);
    for (const o of offers) {
      expect(Object.keys(o)).toEqual(['name', 'price', 'supplier', 'commissionPct']);
      expect(Number.isFinite(o.commissionPct)).toBe(true);
    }
  });

  it('skips offers with an invalid price instead of mis-ranking them', () => {
    const { offers } = pick(
      [h('G', Number.NaN, 10), h('Ok', 50, 1)],
      [h('G', 80, 5), h('Neg', -1, 5)],
    );
    expect(offers.map((o) => [o.name, o.supplier, o.price])).toEqual([
      ['Ok', 'Supplier A', 50],
      ['G', 'Supplier B', 80],
    ]);
  });
});

describe('selectBestOffers: coverage and duplicates', () => {
  it('keeps hotels only one supplier has, from either side', () => {
    const { offers } = pick([h('Only A', 10, 1)], [h('Only B', 20, 2)]);
    expect(offers.map((o) => `${o.name}/${o.supplier}`)).toEqual([
      'Only A/Supplier A',
      'Only B/Supplier B',
    ]);
  });

  it('duplicate names within one supplier: cheapest kept, then higher commission', () => {
    const { decisions } = pick(
      [h('Dup', 300, 5), h(' dup ', 200, 5), h('DUP', 200, 9), h('Dup', 200, null)],
      [],
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.winner).toMatchObject({ price: 200, commissionPct: 9 });
  });

  it('exact normalized matches across suppliers merge; similar names do not', () => {
    const { offers } = pick(
      [h('  The Leela Palace ', 15500, 15), h('Pearl Palace', 2600, 8)],
      [h('THE LEELA  PALACE', 15900, 16), h('Leela Palace', 15000, 12)],
    );
    expect(offers.map((o) => `${o.name}:${o.supplier}`)).toEqual([
      'Pearl Palace:Supplier A',
      'Leela Palace:Supplier B',
      'The Leela Palace:Supplier A',
    ]);
  });

  it('skips empty and whitespace-only names', () => {
    expect(pick([h('', 10, 1), h('   ', 20, 1)], [h('\t', 5, 1)]).offers).toEqual([]);
  });
});
