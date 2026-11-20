import { describe, expect, it } from 'vitest';
import { normalizeName, selectBestOffers } from '../../src/domain/selectBestOffers';
import type { SupplierHotel } from '../../src/domain/types';
import { supplierAHotels } from '../../src/mocks/supplierA.data';
import { supplierBHotels } from '../../src/mocks/supplierB.data';

let seq = 0;
function h(
  name: string,
  price: number,
  commissionPct: number,
  hotelId = `h${++seq}`,
): SupplierHotel {
  return { hotelId, name, price, city: 'delhi', commissionPct };
}

describe('normalizeName', () => {
  it('trims, collapses inner whitespace and lowercases', () => {
    expect(normalizeName('  The   Leela ')).toBe('the leela');
    expect(normalizeName('HOLTIN')).toBe('holtin');
    expect(normalizeName('\tHyatt\nRegency')).toBe('hyatt regency');
  });
});

describe('selectBestOffers', () => {
  it('picks Supplier A when A is cheaper', () => {
    const { offers, decisions } = selectBestOffers({
      A: [h('Radison', 5900, 13)],
      B: [h('Radison', 6150, 11)],
    });
    expect(offers).toEqual([
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
    ]);
    expect(decisions[0]).toMatchObject({ reason: 'cheaper', savings: 250 });
  });

  it('picks Supplier B when B is cheaper', () => {
    const { offers, decisions } = selectBestOffers({
      A: [h('Holtin', 6000, 10)],
      B: [h('Holtin', 5340, 20)],
    });
    expect(offers).toEqual([
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
    ]);
    expect(decisions[0]).toMatchObject({ reason: 'cheaper', savings: 660 });
  });

  it('breaks a price tie with the higher commission', () => {
    const { offers, decisions } = selectBestOffers({
      A: [h('Hyatt Regency', 8400, 14)],
      B: [h('Hyatt Regency', 8400, 16)],
    });
    expect(offers[0]).toEqual({
      name: 'Hyatt Regency',
      price: 8400,
      supplier: 'Supplier B',
      commissionPct: 16,
    });
    expect(decisions[0]).toMatchObject({ reason: 'tie_higher_commission', savings: 0 });
  });

  it('falls back to Supplier A when price and commission are equal', () => {
    const { offers, decisions } = selectBestOffers({
      A: [h('Ibis', 3000, 10)],
      B: [h('Ibis', 3000, 10)],
    });
    expect(offers[0]?.supplier).toBe('Supplier A');
    expect(decisions[0]?.reason).toBe('tie_default');
  });

  it('keeps single-source hotels from either supplier', () => {
    const { offers, decisions } = selectBestOffers({
      A: [h('Lemon Tree', 3200, 8)],
      B: [h('Ibis', 2900, 9)],
    });
    expect(offers).toEqual([
      { name: 'Ibis', price: 2900, supplier: 'Supplier B', commissionPct: 9 },
      { name: 'Lemon Tree', price: 3200, supplier: 'Supplier A', commissionPct: 8 },
    ]);
    expect(decisions.map((d) => d.reason)).toEqual(['single_source', 'single_source']);
    expect(decisions.every((d) => d.candidates.length === 1 && d.savings === 0)).toBe(true);
  });

  it('dedupes names regardless of case and whitespace, using the winner display name', () => {
    const { offers, decisions } = selectBestOffers({
      A: [h(' holtin ', 6000, 10)],
      B: [h('HOLTIN', 5340, 20)],
    });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.name).toBe('HOLTIN');
    expect(decisions[0]?.key).toBe('holtin');
    expect(decisions[0]?.candidates.map((c) => c.supplier)).toEqual(['Supplier A', 'Supplier B']);
  });

  it('dedupes duplicates inside one supplier list, keeping the cheapest', () => {
    const { offers, decisions } = selectBestOffers({
      A: [
        h('Taj Palace', 13000, 15, 'a3'),
        h('taj palace', 12500, 15, 'a3x'),
        h('Taj  Palace', 12900, 30),
      ],
    });
    expect(offers).toEqual([
      { name: 'taj palace', price: 12500, supplier: 'Supplier A', commissionPct: 15 },
    ]);
    expect(decisions[0]?.candidates).toHaveLength(1);
    expect(decisions[0]?.candidates[0]?.hotelId).toBe('a3x');
  });

  it('returns empty results when both lists are empty', () => {
    expect(selectBestOffers({ A: [], B: [] })).toEqual({ offers: [], decisions: [] });
    expect(selectBestOffers({})).toEqual({ offers: [], decisions: [] });
  });

  it('works when one list is empty (partial result)', () => {
    const { offers } = selectBestOffers({ A: [], B: [h('Ibis', 2900, 9), h('Holtin', 5340, 20)] });
    expect(offers.map((o) => o.name)).toEqual(['Ibis', 'Holtin']);
    expect(offers.every((o) => o.supplier === 'Supplier B')).toBe(true);
  });

  it('sorts by price ascending, then name ascending', () => {
    const { offers } = selectBestOffers({
      A: [h('Zeta', 1000, 5), h('alpha', 1000, 5), h('Mid', 500, 5)],
    });
    expect(offers.map((o) => o.name)).toEqual(['Mid', 'alpha', 'Zeta']);
  });

  it('is deterministic regardless of input order', () => {
    const a = [h('One', 100, 1), h('Two', 200, 2), h('Three', 300, 3)];
    const b = [h('two', 150, 9), h('Four', 50, 4)];
    const first = selectBestOffers({ A: a, B: b });
    const second = selectBestOffers({ A: [...a].reverse(), B: [...b].reverse() });
    expect(second).toEqual(first);
  });

  it('produces the exact delhi result from the spec, with decision reasons', () => {
    const byCity = (list: SupplierHotel[]): SupplierHotel[] =>
      list.filter((x) => x.city === 'delhi');
    const { offers, decisions } = selectBestOffers({
      A: byCity(supplierAHotels),
      B: byCity(supplierBHotels),
    });

    expect(offers).toEqual([
      { name: 'Ibis', price: 2900, supplier: 'Supplier B', commissionPct: 9 },
      { name: 'Lemon Tree', price: 3200, supplier: 'Supplier A', commissionPct: 8 },
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
      { name: 'Hyatt Regency', price: 8400, supplier: 'Supplier B', commissionPct: 16 },
      { name: 'The Leela', price: 9800, supplier: 'Supplier A', commissionPct: 12 },
      { name: 'Taj Palace', price: 11900, supplier: 'Supplier B', commissionPct: 18 },
    ]);
    expect(Object.fromEntries(decisions.map((d) => [d.name, d.reason]))).toEqual({
      Ibis: 'single_source',
      'Lemon Tree': 'single_source',
      Holtin: 'cheaper',
      Radison: 'cheaper',
      'Hyatt Regency': 'tie_higher_commission',
      'The Leela': 'cheaper',
      'Taj Palace': 'cheaper',
    });
  });
});
