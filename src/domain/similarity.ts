/**
 * Name similarity for near-duplicate detection (report-only; the main endpoint
 * still dedupes by exact normalized name). PURE and DETERMINISTIC: also runs
 * inside the duplicate-review workflow. No dependencies.
 */

/** Words that say nothing about which property it is. */
const STOP_WORDS = new Set([
  'the',
  'hotel',
  'hotels',
  'resort',
  'resorts',
  'and',
  'by',
  'spa',
  'inn',
  'suites',
  'a',
  'an',
  'of',
]);

/** Lowercase, strip punctuation/diacritics, drop stop-words and the city name. */
export function normalizeForSimilarity(name: string, city?: string): string {
  const cityTokens = new Set((city ?? '').toLowerCase().split(/\s+/).filter(Boolean));
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t) && !cityTokens.has(t))
    .join(' ');
}

/** Jaro similarity in [0, 1]. */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  return (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
}

/** Jaro-Winkler: Jaro boosted for a common prefix (up to 4 chars, p = 0.1). */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return j + prefix * 0.1 * (1 - j);
}

/**
 * Token-set similarity: tokens are matched one-to-one when their Jaro-Winkler
 * is ≥ 0.9 (so "radison" ≈ "radisson"); score = 2·matches / (|A| + |B|).
 */
export function tokenSetSimilarity(a: string, b: string): number {
  const ta = a.split(' ').filter(Boolean);
  const tb = b.split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const used = new Array<boolean>(tb.length).fill(false);
  let matches = 0;
  for (const x of ta) {
    let best = -1;
    let bestScore = 0.9;
    tb.forEach((y, j) => {
      if (used[j]) return;
      const s = x === y ? 1 : jaroWinkler(x, y);
      if (s >= bestScore) {
        best = j;
        bestScore = s;
      }
    });
    if (best >= 0) {
      used[best] = true;
      matches++;
    }
  }
  return (2 * matches) / (ta.length + tb.length);
}

/**
 * Combined name similarity in [0, 1]: the stronger of whole-string
 * Jaro-Winkler (catches typos) and token-set (catches reordering / extra words),
 * computed on stop-word- and city-stripped names.
 */
export function nameSimilarity(a: string, b: string, city?: string): number {
  const na = normalizeForSimilarity(a, city);
  const nb = normalizeForSimilarity(b, city);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return Math.max(jaroWinkler(na, nb), tokenSetSimilarity(na, nb));
}
