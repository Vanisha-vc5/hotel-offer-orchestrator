/**
 * Rules-based natural-language query parser. PURE, no AI: always available and
 * the fallback whenever the LLM parser is off, slow or wrong.
 *
 * Understands: "under/below/less than/max/up to X", "over/above/at least/min/from X",
 * "between X and Y", "X-Y", "X to Y", amounts like "6k", "6.5k", "₹6,000", "rs 6000",
 * and city names from a known list (case-insensitive, with common aliases).
 */
export interface ParsedQuery {
  city: string | null;
  minPrice: number | null;
  maxPrice: number | null;
}

const CITY_ALIASES: Record<string, string> = {
  bengaluru: 'bangalore',
  bombay: 'mumbai',
  'new delhi': 'delhi',
};

/** "6k" → 6000, "6.5k" → 6500, "₹6,000" → 6000, "rs. 6000" → 6000. */
export function parseAmount(raw: string): number | null {
  const m = /^(?:₹|rs\.?|inr)?\s*(\d+(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k)?$/i.exec(
    raw.trim(),
  );
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2] ? n * 1000 : n);
}

// An amount token: optional currency, digits (with thousands separators/decimals), optional k.
const AMT = String.raw`(?:₹|rs\.?\s*|inr\s*)?\d+(?:,\d{3})*(?:\.\d+)?\s*k?\b`;

function detectCity(text: string, knownCities: readonly string[]): string | null {
  const candidates = [
    ...Object.entries(CITY_ALIASES),
    ...knownCities.map((c) => [c, c] as const),
  ].sort((a, b) => b[0].length - a[0].length); // prefer the longest match ("new delhi")
  for (const [name, city] of candidates) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (new RegExp(`(?:^|[^\\p{L}])${escaped}(?:$|[^\\p{L}])`, 'iu').test(text)) return city;
  }
  return null;
}

function detectRange(text: string): Pick<ParsedQuery, 'minPrice' | 'maxPrice'> {
  const between = new RegExp(
    String.raw`(?:between|from)\s+(${AMT})\s*(?:and|to|-|–)\s*(${AMT})`,
    'i',
  ).exec(text);
  const dash = new RegExp(String.raw`(${AMT})\s*(?:-|–|to)\s*(${AMT})`, 'i').exec(text);
  const pair = between ?? dash;
  if (pair?.[1] && pair[2]) {
    const a = parseAmount(pair[1]);
    const b = parseAmount(pair[2]);
    if (a !== null && b !== null) return { minPrice: Math.min(a, b), maxPrice: Math.max(a, b) };
  }

  const max = new RegExp(
    String.raw`(?:under|below|less\s+than|cheaper\s+than|max(?:imum)?|up\s*to|upto|within|at\s+most|<=?)\s*(${AMT})`,
    'i',
  ).exec(text);
  const min = new RegExp(
    String.raw`(?:over|above|more\s+than|at\s+least|min(?:imum)?|from|starting\s+(?:at|from)|>=?)\s*(${AMT})`,
    'i',
  ).exec(text);
  return {
    minPrice: min?.[1] ? parseAmount(min[1]) : null,
    maxPrice: max?.[1] ? parseAmount(max[1]) : null,
  };
}

export function parseQueryRules(query: string, knownCities: readonly string[]): ParsedQuery {
  const text = query.replace(/\s+/g, ' ').trim();
  return { city: detectCity(text, knownCities), ...detectRange(text) };
}
