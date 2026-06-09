import { describe, it, expect } from 'vitest';
import {
  normalizeUrlForComparison,
  isGenericListUrl,
  findDuplicateUrls,
  dedupeCandidatesByUrl,
  preferProductPages,
} from './candidates.js';
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

describe('normalizeUrlForComparison', () => {
  it('treats #fragment variants as the same page', () => {
    expect(normalizeUrlForComparison('https://www.rtings.com/laptop/reviews/best/by-usage/gaming#razer-blade-16')).toBe(
      normalizeUrlForComparison('https://www.rtings.com/laptop/reviews/best/by-usage/gaming'),
    );
  });

  it('ignores trailing slashes', () => {
    expect(normalizeUrlForComparison('https://a.com/p/x/')).toBe(normalizeUrlForComparison('https://a.com/p/x'));
  });

  it('strips tracking params but keeps meaningful ones', () => {
    expect(normalizeUrlForComparison('https://a.com/p?utm_source=x&gclid=1&variant=red')).toBe(
      'https://a.com/p?variant=red',
    );
  });

  it('is insensitive to query param order', () => {
    expect(normalizeUrlForComparison('https://a.com/p?b=2&a=1')).toBe(normalizeUrlForComparison('https://a.com/p?a=1&b=2'));
  });

  it('passes through non-URL strings unchanged', () => {
    expect(normalizeUrlForComparison('not a url')).toBe('not a url');
  });
});

describe('isGenericListUrl', () => {
  it.each([
    // The exact URLs from the two reported incidents.
    'https://www.rtings.com/laptop/reviews/best/by-usage/gaming',
    'https://www.nytimes.com/wirecutter/reviews/best-noise-cancelling-headphones/',
    'https://www.amazon.com/s?k=noise+cancelling+headphones+under+120&rh=p_36%3A1-12000',
    // Other common shapes.
    'https://www.tomshardware.com/best-picks/best-gaming-laptops',
    'https://www.google.com/search?q=gaming+laptop',
    'https://www.ebay.com/sch/i.html?_nkw=gaming+laptop',
    'https://www.reddit.com/r/GamingLaptops/comments/abc/best_gaming_laptop_under_3000/',
    'https://www.rtings.com/laptop/tools/compare/razer-blade-16-vs-asus-rog/123',
    'https://www.razer.com/', // bare homepage is never a product page
  ])('flags list/search/landing URL %s', (url) => {
    expect(isGenericListUrl(url)).toBe(true);
  });

  it.each([
    'https://www.razer.com/gaming-laptops/razer-blade-16',
    'https://www.rtings.com/headphones/reviews/sony/wh-ch720n-wireless',
    'https://www.amazon.com/Razer-Blade-16-Gaming-Laptop/dp/B0CTHM6FK1',
    // "best" in the HOST must not trigger — only the path counts.
    'https://www.bestbuy.com/site/asus-rog-strix-scar-16/6571234.p',
    // "top" inside a word ("laptop") must not trigger.
    'https://www.lenovo.com/us/en/laptops/legion/legion-pro-7i',
    // Search-term param on a DEEP path is a product page someone reached via
    // search — not a search-results page.
    'https://www.amazon.com/dp/B0CTHM6FK1?keywords=razer+blade',
  ])('accepts product-specific URL %s', (url) => {
    expect(isGenericListUrl(url)).toBe(false);
  });

  it('still flags search params on shallow paths', () => {
    expect(isGenericListUrl('https://store.com/shop?q=gaming+laptop')).toBe(true);
  });
});

describe('preferProductPages', () => {
  it('drops roundup-URL candidates when a product page survived', () => {
    const digest: Digest = {
      scout_note: 'n',
      candidates: [
        cand('Razer Blade 16', 'https://www.razer.com/gaming-laptops/razer-blade-16', 90),
        cand('Mystery pick', 'https://www.rtings.com/laptop/reviews/best/by-usage/gaming', 80),
      ],
    };
    expect(preferProductPages(digest).candidates.map((c) => c.title)).toEqual(['Razer Blade 16']);
  });

  it('keeps everything when ALL candidates are generic (never empties the digest)', () => {
    const digest: Digest = {
      scout_note: 'n',
      candidates: [
        cand('A', 'https://www.rtings.com/laptop/reviews/best/by-usage/gaming', 80),
        cand('B', 'https://www.tomshardware.com/best-picks/best-gaming-laptops', 75),
      ],
    };
    expect(preferProductPages(digest).candidates).toHaveLength(2);
  });

  it('is a no-op when no candidate is generic', () => {
    const digest: Digest = {
      scout_note: 'n',
      candidates: [cand('A', 'https://a.com/p1', 90), cand('B', 'https://b.com/p2', 80)],
    };
    expect(preferProductPages(digest).candidates).toHaveLength(2);
  });
});

describe('findDuplicateUrls', () => {
  it('returns URLs shared by more than one candidate', () => {
    const dupes = findDuplicateUrls([
      cand('Sony XM4', 'https://x.com/roundup-page', 88),
      cand('Sony 720N', 'https://x.com/roundup-page', 84),
      cand('Anker Q45', 'https://shop.com/q45', 80),
    ]);
    expect(dupes).toEqual(['https://x.com/roundup-page']);
  });

  it('catches fragment variants of the same page', () => {
    const dupes = findDuplicateUrls([
      cand('A', 'https://x.com/page#asus', 90),
      cand('B', 'https://x.com/page#razer', 85),
    ]);
    expect(dupes).toHaveLength(1);
  });

  it('returns empty when every candidate has its own URL', () => {
    const dupes = findDuplicateUrls([cand('A', 'https://a.com/p1', 90), cand('B', 'https://b.com/p2', 80)]);
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

  it('collapses fragment variants of one page', () => {
    const digest: Digest = {
      scout_note: 'n',
      candidates: [
        cand('A', 'https://x.com/page#asus', 70),
        cand('B', 'https://x.com/page#razer', 90),
      ],
    };
    expect(dedupeCandidatesByUrl(digest).candidates.map((c) => c.title)).toEqual(['B']);
  });

  it('leaves a digest with all-distinct URLs unchanged', () => {
    const digest: Digest = {
      scout_note: 'n',
      candidates: [cand('A', 'https://a.com/p1', 90), cand('B', 'https://b.com/p2', 80)],
    };
    expect(dedupeCandidatesByUrl(digest).candidates).toHaveLength(2);
  });
});
