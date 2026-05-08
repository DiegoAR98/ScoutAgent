// Thin SerpAPI client. Keeps the surface minimal for the vertical slice:
// one function that runs a Google query and returns normalized organic +
// shopping results. Reddit is reached by appending site:reddit.com to the q.
import { loadEnv } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';

const SERPAPI_BASE = 'https://serpapi.com/search.json';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface SerpResult {
  title: string;
  url: string;
  snippet?: string;
  source: 'organic' | 'shopping' | 'reddit';
  price_usd?: number;
}

interface SerpApiOrganic { title?: string; link?: string; snippet?: string; }
interface SerpApiShopping { title?: string; link?: string; product_link?: string; snippet?: string; price?: string; extracted_price?: number; }

export interface SearchOptions {
  num?: number;
  redditOnly?: boolean;
}

export async function serpapiSearch(query: string, opts: SearchOptions = {}): Promise<SerpResult[]> {
  const env = loadEnv();
  const num = opts.num ?? 10;
  const q = opts.redditOnly ? `${query} site:reddit.com` : query;

  const url = new URL(SERPAPI_BASE);
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', q);
  url.searchParams.set('num', String(num));
  url.searchParams.set('api_key', env.SERPAPI_KEY);
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', 'us');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`SerpAPI ${res.status}: ${await res.text().catch(() => '')}`);
    }
    body = await res.json();
  } finally {
    clearTimeout(t);
  }

  const data = body as { organic_results?: SerpApiOrganic[]; shopping_results?: SerpApiShopping[]; error?: string };
  if (data.error) throw new Error(`SerpAPI error: ${data.error}`);

  const results: SerpResult[] = [];
  for (const o of data.organic_results ?? []) {
    if (!o.link || !o.title) continue;
    const isReddit = /(?:^|\.)reddit\.com\//i.test(o.link);
    results.push({
      title: o.title,
      url: o.link,
      ...(o.snippet ? { snippet: o.snippet } : {}),
      source: isReddit ? 'reddit' : 'organic',
    });
  }
  for (const s of data.shopping_results ?? []) {
    const link = s.link ?? s.product_link;
    if (!link || !s.title) continue;
    results.push({
      title: s.title,
      url: link,
      ...(s.snippet ? { snippet: s.snippet } : {}),
      source: 'shopping',
      ...(typeof s.extracted_price === 'number' ? { price_usd: s.extracted_price } : {}),
    });
  }

  logger.debug({ query: q, count: results.length }, 'serpapi.search');
  return results;
}
