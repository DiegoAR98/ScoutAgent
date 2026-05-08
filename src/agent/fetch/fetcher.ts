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
