// Candidate-list URL-quality helpers used by the orchestrator. Kept pure and
// dependency-free (types only) so they can be unit-tested in isolation.
//
// Background: for "best X" queries SerpAPI returns mostly roundup/listicle
// articles and search-results pages, not individual product pages. The model
// would then assign the SAME roundup URL to several candidates — so every pick
// in the digest linked to the same "best of" article. These guard against that.
import type { Digest } from './schema.js';

// URLs that appear on more than one candidate. Each candidate must link to its
// OWN page; reusing a single roundup/search URL across candidates is the most
// common quality regression (all picks → same link).
export function findDuplicateUrls(candidates: Digest['candidates']): string[] {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.url, (counts.get(c.url) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([url]) => url);
}

// Safety net for when the model still reused a URL after its repair retry:
// keep only the highest-scoring candidate per URL so the digest never shows
// the same link twice. Original (best-first) order is otherwise preserved.
export function dedupeCandidatesByUrl(digest: Digest): Digest {
  const bestByUrl = new Map<string, Digest['candidates'][number]>();
  for (const c of digest.candidates) {
    const existing = bestByUrl.get(c.url);
    if (!existing || c.score > existing.score) bestByUrl.set(c.url, c);
  }
  const kept = new Set(bestByUrl.values());
  return { ...digest, candidates: digest.candidates.filter((c) => kept.has(c)) };
}
