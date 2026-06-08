// Fetches a URL and extracts readable text via Mozilla Readability. Falls
// back to a cheerio strip on Readability failures. Hard caps on time and
// body size keep the LLM token budget under control (SRS FR-10/FR-11).
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { logger } from '../../lib/logger.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BYTES = 500_000; // 500KB content cap (SRS FR-10)
const MAX_TEXT_CHARS = 12_000; // Trim extracted text to ~12k chars per page
const USER_AGENT = 'Mozilla/5.0 (compatible; ScoutAgent/0.1; +https://minasdigital.com)';

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  byline?: string;
  bytes: number;
}

export class FetchError extends Error {
  constructor(message: string, public readonly url: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'FetchError';
  }
}

export async function fetchAndExtract(url: string): Promise<FetchedPage> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);

  let html: string;
  let finalUrl = url;
  let bytes = 0;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`, url);
    finalUrl = res.url;

    const reader = res.body?.getReader();
    if (!reader) throw new FetchError('no response body', url);
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytes >= MAX_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    buf += decoder.decode();
    html = buf;
  } catch (err) {
    throw err instanceof FetchError ? err : new FetchError(String((err as Error).message ?? err), url, err);
  } finally {
    clearTimeout(t);
  }

  const { title, text, byline } = extractReadable(html, finalUrl);
  const trimmed = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  logger.debug({ url: finalUrl, bytes, chars: trimmed.length }, 'fetch.extract');
  return {
    url,
    finalUrl,
    title,
    text: trimmed,
    ...(byline ? { byline } : {}),
    bytes,
  };
}

export interface UrlVerifyResult {
  url: string;
  statusCode: number | null;
  finalUrl: string;
  /** true if status is 2xx/3xx — page loaded cleanly. */
  ok: boolean;
  /** true if the URL is verifiably gone (404/410). All other failures (403, 503,
   *  timeouts) are treated as "ambiguous, probably bot-blocked" and not dead. */
  dead: boolean;
}

// A browser-like User-Agent. Many retailers (Amazon, Best Buy, Target) and
// Cloudflare-fronted sites 403 anything that smells like a bot. We want
// verification to behave like a normal browser tab, not a scraper, since
// the goal is to confirm the link works for a human clicker.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Lightweight liveness check used to drop ONLY known-dead links before the
// digest is rendered. Tries HEAD first (cheap); if the origin doesn't allow
// HEAD, falls back to a short GET. The dead policy is intentionally narrow:
// only an explicit 404/410 marks the URL as dead. Bot-detection (403/503),
// rate limits (429), timeouts, and network errors keep the URL — a real
// browser will likely still load it.
export async function verifyUrlLive(url: string): Promise<UrlVerifyResult> {
  let attempt = await tryOnce(url, 'HEAD', 3500);
  // Many sites reject HEAD with 403/405 (or close the connection without a
  // status). Re-try with GET before deciding.
  if (
    attempt.statusCode === 403 ||
    attempt.statusCode === 405 ||
    attempt.statusCode === 501 ||
    attempt.statusCode === null
  ) {
    attempt = await tryOnce(url, 'GET', 6000);
  }
  const dead = attempt.statusCode === 404 || attempt.statusCode === 410;
  return { ...attempt, dead };
}

async function tryOnce(url: string, method: 'HEAD' | 'GET', timeoutMs: number): Promise<Omit<UrlVerifyResult, 'dead'>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    res.body?.cancel().catch(() => {});
    const statusCode = res.status;
    const ok = statusCode >= 200 && statusCode < 400;
    return { url, ok, statusCode, finalUrl: res.url || url };
  } catch {
    return { url, ok: false, statusCode: null, finalUrl: url };
  } finally {
    clearTimeout(t);
  }
}

function extractReadable(html: string, baseUrl: string): { title: string; text: string; byline?: string } {
  try {
    const dom = new JSDOM(html, { url: baseUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article?.textContent && article.textContent.trim().length > 200) {
      return {
        title: (article.title ?? '').trim() || dom.window.document.title || baseUrl,
        text: article.textContent.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
        ...(article.byline ? { byline: article.byline } : {}),
      };
    }
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'readability.fallback');
  }
  // Fallback: strip via cheerio.
  const $ = cheerio.load(html);
  $('script, style, noscript, header, footer, nav, aside, form').remove();
  const title = $('title').first().text().trim() || baseUrl;
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return { title, text };
}
