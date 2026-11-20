import { describe, expect, it } from 'vitest';
import { parseAmount, parseQueryRules } from '../../src/domain/queryRules';

const CITIES = ['delhi', 'mumbai', 'bangalore', 'goa', 'jaipur'];

describe('parseAmount', () => {
  it.each([
    ['6k', 6000],
    ['6.5k', 6500],
    ['₹6,000', 6000],
    ['rs 6000', 6000],
    ['Rs. 12,500', 12500],
    ['INR 900', 900],
    ['7000', 7000],
  ])('%s → %d', (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });

  it('rejects non-amounts', () => {
    expect(parseAmount('cheap')).toBeNull();
  });
});

describe('parseQueryRules (table-driven)', () => {
  const cases: Array<[string, string | null, number | null, number | null]> = [
    ['cheap hotels in delhi under 6k', 'delhi', null, 6000],
    ['hotels in Delhi below ₹6,000', 'delhi', null, 6000],
    ['delhi hotels less than 5000', 'delhi', null, 5000],
    ['max 8k in mumbai', 'mumbai', null, 8000],
    ['mumbai stays up to rs 9,500', 'mumbai', null, 9500],
    ['luxury hotels in goa over 10k', 'goa', 10000, null],
    ['goa above 7000 please', 'goa', 7000, null],
    ['at least 3k in bangalore', 'bangalore', 3000, null],
    ['min 4500 bangalore', 'bangalore', 4500, null],
    ['hotels in delhi between 5000 and 9000', 'delhi', 5000, 9000],
    ['between 5k and 9k in mumbai', 'mumbai', 5000, 9000],
    ['delhi 5000-9000', 'delhi', 5000, 9000],
    ['delhi 5k - 9k', 'delhi', 5000, 9000],
    ['jaipur 6000 to 15000', 'jaipur', 6000, 15000],
    ['from 4k to 8k in goa', 'goa', 4000, 8000],
    ['9000-5000 in delhi (reversed)', 'delhi', 5000, 9000],
    ['Hotels in BENGALURU under 12k', 'bangalore', null, 12000],
    ['stay in Bombay above 6k', 'mumbai', 6000, null],
    ['New Delhi hotels within 7,500', 'delhi', null, 7500],
    ['show me everything in delhi', 'delhi', null, null],
    ['cheap hotels under 5k', null, null, 5000],
    ['hotels in atlantis', null, null, null],
    ['   DELHI    under    6K   ', 'delhi', null, 6000],
    ['over 2k and under 4k in goa', 'goa', 2000, 4000],
  ];

  it.each(cases)('"%s"', (query, city, minPrice, maxPrice) => {
    expect(parseQueryRules(query, CITIES)).toEqual({ city, minPrice, maxPrice });
  });

  it('does not match a city inside another word', () => {
    expect(parseQueryRules('goal: hotels under 5k', CITIES).city).toBeNull();
  });
});
