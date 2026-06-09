// Candidate-list URL-quality helpers used by the orchestrator. Kept pure and
// dependency-free (types only) so they can be unit-tested in isolation.
//
// Background: for "best X" queries SerpAPI returns mostly roundup/listicle
// articles and search-results pages, not individual product pages. Left
// unchecked, the model assigns the SAME roundup URL to several candidates —
// so every pick in the digest links to one "best of" article. These helpers
// detect both failure modes: reused URLs (including #fragment variants of one
// page) and URLs that are roundups/search pages rather than a product's own
// page.
import type { Digest } from './schema.js';

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|msclkid|ref|ref_|tag|affid|affiliate)$/i;

// Canonical form for "is this the same page?" comparisons. Strips the
// #fragment (anchors never change the page), tracking params, and trailing
// slashes, and sorts the query string so param order doesn't matter. The
// result is for comparison only — never ship it to the user.
export function normalizeUrlForComparison(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  const path = u.pathname.replace(/\/+$/, '');
  const qs = u.searchParams.toString();
  return `${u.protocol}//${u.host}${path}${qs ? `?${qs}` : ''}`;
}

// Roundup/listicle segments ("best", "top-10", buying guides, comparison
// tools) checked against the PATH ONLY — never the host, so bestbuy.com
// product pages don't false-positive. Word-ish boundaries keep "laptop" from
// matching "top".
const LIST_SEGMENT =
  /(^|[/_-])(best|top-?\d+|roundup|rankings?|buying-?guides?|buyers-?guide|comparisons?|leaderboard|by-usage|vs|versus)(?=$|[/_.-])/i;

// Search-results paths (amazon /s, google /search, ebay /sch/i.html) and the
// query params search engines use for the search term.
const SEARCH_PATH = /(^|\/)(search|s|sch|results|findproducts)(\/|$)/i;
const SEARCH_PARAM_NAMES = new Set([
  'q',
  'k',
  'query',
  'search',
  'searchterm',
  'search_query',
  '_nkw',
  'keywords',
  'keyword',
]);

// True when the URL is a generic list/search/landing page rather than one
// product's own page: roundups, "top N" listicles, buying guides, comparison
// tools, search results, and bare homepages.
export function isGenericListUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path on malformed percent-encoding
  }
  if (path === '' || path === '/') return true;
  if (LIST_SEGMENT.test(path)) return true;
  if (SEARCH_PATH.test(path)) return true;
  // Search-term params only mark a search page on shallow paths (e.g.
  // /shop?q=x). Deep paths are product pages that may carry a leftover
  // ?keywords= from how the user got there (amazon /dp/ASIN?keywords=...).
  const depth = path.split('/').filter(Boolean).length;
  if (depth <= 1) {
    for (const name of u.searchParams.keys()) {
      if (SEARCH_PARAM_NAMES.has(name.toLowerCase())) return true;
    }
  }
  return false;
}

// Final-digest filter: when at least one candidate links to a real product
// page, drop the ones that still link to roundup/search pages. If EVERY
// candidate is generic, keep the digest unchanged — a roundup link beats an
// empty "no picks" email that would misreport the research as fruitless.
export function preferProductPages(digest: Digest): Digest {
  const generic = digest.candidates.filter((c) => isGenericListUrl(c.url));
  if (generic.length === 0 || generic.length === digest.candidates.length) return digest;
  return { ...digest, candidates: digest.candidates.filter((c) => !isGenericListUrl(c.url)) };
}

// URLs that appear on more than one candidate, compared in normalized form so
// fragment/tracking-param variants of one page count as the same URL. Returns
// one representative URL (as the model wrote it) per duplicated group.
export function findDuplicateUrls(candidates: Digest['candidates']): string[] {
  const groups = new Map<string, { first: string; count: number }>();
  for (const c of candidates) {
    const key = normalizeUrlForComparison(c.url);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { first: c.url, count: 1 });
  }
  return [...groups.values()].filter((g) => g.count > 1).map((g) => g.first);
}

// Safety net for when the model still reused a page after its repair retries:
// keep only the highest-scoring candidate per normalized URL so the digest
// never shows the same page twice. Original (best-first) order is preserved.
export function dedupeCandidatesByUrl(digest: Digest): Digest {
  const bestByUrl = new Map<string, Digest['candidates'][number]>();
  for (const c of digest.candidates) {
    const key = normalizeUrlForComparison(c.url);
    const existing = bestByUrl.get(key);
    if (!existing || c.score > existing.score) bestByUrl.set(key, c);
  }
  const kept = new Set(bestByUrl.values());
  return { ...digest, candidates: digest.candidates.filter((c) => kept.has(c)) };
}
