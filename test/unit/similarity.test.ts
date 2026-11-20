import { describe, expect, it } from 'vitest';
import { findDuplicatePairs, similarityVerdict } from '../../src/domain/duplicates';
import { selectBestOffers } from '../../src/domain/selectBestOffers';
import {
  jaroWinkler,
  nameSimilarity,
  normalizeForSimilarity,
  tokenSetSimilarity,
} from '../../src/domain/similarity';
import type { SupplierHotel } from '../../src/domain/types';
import { supplierAHotels } from '../../src/mocks/supplierA.data';
import { supplierBHotels } from '../../src/mocks/supplierB.data';

const decisionsFor = (city: string) =>
  selectBestOffers({
    A: supplierAHotels.filter((h: SupplierHotel) => h.city === city),
    B: supplierBHotels.filter((h: SupplierHotel) => h.city === city),
  }).decisions;

describe('similarity primitives', () => {
  it('Jaro-Winkler matches the textbook values', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler('dwayne', 'duane')).toBeCloseTo(0.84, 4);
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.8133, 4);
    expect(jaroWinkler('same', 'same')).toBe(1);
    expect(jaroWinkler('abc', '')).toBe(0);
  });

  it('normalizes punctuation, case, stop-words and the city name', () => {
    expect(normalizeForSimilarity('The Leela Palace')).toBe('leela palace');
    expect(normalizeForSimilarity('Hotel Pearl-Palace!')).toBe('pearl palace');
    expect(normalizeForSimilarity('Fairmont Jaipur', 'jaipur')).toBe('fairmont');
    expect(normalizeForSimilarity('Café & Resort')).toBe('cafe');
  });

  it('token-set similarity tolerates typos within tokens', () => {
    expect(tokenSetSimilarity('radisson blu', 'radison blu')).toBe(1);
    expect(tokenSetSimilarity('taj rambagh palace', 'taj jai mahal palace')).toBeCloseTo(4 / 7, 4);
  });

  it('scores known pairs', () => {
    expect(nameSimilarity('Radisson Blu', 'Radison Blu', 'jaipur')).toBeGreaterThanOrEqual(0.92);
    expect(nameSimilarity('The Leela Palace', 'Leela Palace', 'jaipur')).toBe(1);
    expect(nameSimilarity('Hotel Pearl Palace', 'Pearl Palace', 'jaipur')).toBe(1);
    const taj = nameSimilarity('Taj Rambagh Palace', 'Taj Jai Mahal Palace', 'jaipur');
    expect(taj).toBeGreaterThanOrEqual(0.75);
    expect(taj).toBeLessThan(0.92);
    expect(nameSimilarity('Fairmont Jaipur', 'Trident Jaipur', 'jaipur')).toBeLessThan(0.75);
    expect(nameSimilarity('Ibis', 'Taj Palace')).toBeLessThan(0.75);
  });
});

describe('findDuplicatePairs', () => {
  it('finds exactly the deliberate jaipur near-duplicates (mutual best match)', () => {
    const pairs = findDuplicatePairs(decisionsFor('jaipur'), 'jaipur');
    expect(pairs.map((p) => [p.a.name, p.b.name])).toEqual([
      ['Hotel Pearl Palace', 'Pearl Palace'],
      ['Radisson Blu', 'Radison Blu'],
      ['The Leela Palace', 'Leela Palace'],
      ['Taj Rambagh Palace', 'Taj Jai Mahal Palace'],
    ]);
    // exact name matches (ITC Rajputana) are merged by the main dedupe, never reported
    expect(pairs.some((p) => p.a.name === 'ITC Rajputana')).toBe(false);
    // "The Leela Palace" vs "Pearl Palace" scores 0.79 but is not a mutual best match
    expect(pairs.some((p) => p.a.name === 'The Leela Palace' && p.b.name === 'Pearl Palace')).toBe(
      false,
    );
  });

  it('reports nothing for the original cities', () => {
    for (const city of ['delhi', 'mumbai', 'bangalore', 'goa']) {
      expect(findDuplicatePairs(decisionsFor(city), city)).toEqual([]);
    }
  });

  it('computes potential savings for a likely_same verdict', () => {
    const [pearl] = findDuplicatePairs(decisionsFor('jaipur'), 'jaipur');
    expect(similarityVerdict(pearl!)).toMatchObject({
      verdict: 'likely_same',
      decidedBy: 'similarity',
      potentialSavings: 100,
      a: { name: 'Hotel Pearl Palace', supplier: 'Supplier A', price: 2600 },
      b: { name: 'Pearl Palace', supplier: 'Supplier B', price: 2500 },
    });
  });
});
