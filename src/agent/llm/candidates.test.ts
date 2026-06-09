import { describe, it, expect } from 'vitest';
import { findDuplicateUrls, dedupeCandidatesByUrl } from './candidates.js';
import type { Candidate, Digest } from './schema.js';

function cand(title: string, url: string, score: number): Candidate {
  return {
    title,
    url,
    price_usd: null,
    score,
    verdict: 'recommend',
    reasoning: 'because',
    flags: [],
    sources_considered: [],
  };
}

describe('findDuplicateUrls', () => {
  it('returns URLs shared by more than one candidate', () => {
    const dupes = findDuplicateUrls([
      cand('Sony XM4', 'https://x.com/best-of-roundup', 88),
      cand('Sony 720N', 'https://x.com/best-of-roundup', 84),
      cand('Anker Q45', 'https://shop.com/q45', 80),
    ]);
    expect(dupes).toEqual(['https://x.com/best-of-roundup']);
  });

  it('returns empty when every candidate has its own URL', () => {
    const dupes = findDuplicateUrls([
      cand('A', 'https://a.com', 90),
      cand('B', 'https://b.com', 80),
    ]);
    expect(dupes).toEqual([]);
  });
});

describe('dedupeCandidatesByUrl', () => {
  it('keeps only the highest-scoring candidate per URL, preserving order', () => {
    // Mirrors the reproduced bug: 4 candidates collapse onto 2 shared URLs.
    const digest: Digest = {
      scout_note: 'note',
      candidates: [
        cand('Sony XM4', 'https://nyt.com/wirecutter/best-anc', 88),
        cand('Sony 720N', 'https://nyt.com/wirecutter/best-anc', 84),
        cand('Anker Q45', 'https://amazon.com/s?k=anc', 80),
        cand('EarFun', 'https://amazon.com/s?k=anc', 65),
      ],
    };
    const out = dedupeCandidatesByUrl(digest);
    expect(out.candidates.map((c) => c.title)).toEqual(['Sony XM4', 'Anker Q45']);
  });

  it('leaves a digest with all-distinct URLs unchanged', () => {
    const digest: Digest = {
      scout_note: 'n',
      candidates: [cand('A', 'https://a.com', 90), cand('B', 'https://b.com', 80)],
    };
    expect(dedupeCandidatesByUrl(digest).candidates).toHaveLength(2);
  });
});
