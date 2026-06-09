// Agent reasoning loop over the OpenAI-compatible TARS gateway.
//
// Three tools are exposed to the model:
//   - serpapi_search(query, source?)        → list of {title,url,snippet,...}
//   - fetch_url(url)                        → readable text + title
//   - record_candidates(candidates, note)   → structured final answer (terminates loop)
//
// The model is told to plan: search broadly, fetch the most promising pages,
// score per the rubric in §6.3, then call record_candidates exactly once.
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { getTarsClient, getTarsModel } from './tarsClient.js';
import { serpapiSearch } from '../search/serpapi.js';
import { fetchAndExtract, verifyUrlLive, FetchError } from '../fetch/fetcher.js';
import { digestSchema, type Digest } from './schema.js';
import { findDuplicateUrls, dedupeCandidatesByUrl, isGenericListUrl, preferProductPages } from './candidates.js';
import { logger } from '../../lib/logger.js';

const MAX_ITERATIONS = 20;
const MAX_SEARCH_CALLS = 6;
const MAX_FETCH_CALLS = 8;
const MIN_FETCHES_BEFORE_RECORD = 2;
// Gate D (URL quality) gets its own retry allowance: finding each product's
// own page may take one search per candidate, so one repair is often not
// enough when the first shortlist leaned on a single roundup.
const MAX_URL_QUALITY_REPAIRS = 2;
// Hard stop on record_candidates attempts across all gates (A..D repairs + final).
const MAX_RECORD_ATTEMPTS = 6;

export interface AlertInput {
  query: string;
  maxBudgetUsd: number;
}

export interface AgentRunResult {
  digest: Digest;
  iterations: number;
  toolCalls: { search: number; fetch: number; record: number };
  tokensIn: number;
  tokensOut: number;
}

const tools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'serpapi_search',
      description: 'Run a Google search via SerpAPI. Use this to discover candidate products and discussion threads. Returns up to 10 organic + shopping results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query string. Be specific (include the product type and price band).' },
          source: { type: 'string', enum: ['web', 'reddit'], description: 'Use "reddit" to restrict to site:reddit.com — good for community sentiment.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a URL and return the main readable text content plus title. Use this on the most promising results to verify price, specs, and credibility before scoring.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_candidates',
      description: 'Submit your final shortlist. Call this exactly once when you have evaluated enough sources. After this call you are done.',
      parameters: {
        type: 'object',
        properties: {
          candidates: {
            type: 'array',
            description: 'Up to 5 evaluated candidates ordered best-first. Include at most 3 with verdict="recommend"; you may include 1 with verdict="flag" if it is informative; never include "reject".',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string', description: "This product's OWN page — a retailer/product listing or the single review/thread specific to it. Must be UNIQUE across candidates (URLs differing only by #fragment count as the same page). Never a 'best of' roundup, listicle, or search-results URL." },
                price_usd: { type: ['number', 'null'] },
                score: { type: 'number', minimum: 0, maximum: 100 },
                verdict: { type: 'string', enum: ['recommend', 'flag', 'reject'] },
                reasoning: { type: 'string', description: '1–3 sentences justifying the score, citing observed evidence.' },
                flags: { type: 'array', items: { type: 'string' }, description: 'Short tags like "battery-fire-reports", "limited-reviews", "outside-budget".' },
                sources_considered: { type: 'array', items: { type: 'string' }, description: 'URLs of pages you read to make this judgment.' },
              },
              required: ['title', 'url', 'price_usd', 'score', 'verdict', 'reasoning', 'flags', 'sources_considered'],
              additionalProperties: false,
            },
          },
          scout_note: { type: 'string', description: '1–2 sentence summary for the email recipient. Plain, friendly, no marketing speak.' },
        },
        required: ['candidates', 'scout_note'],
        additionalProperties: false,
      },
    },
  },
];

const systemPrompt = `You are ScoutAgent, an autonomous shopping researcher. Given a product query and budget, you discover candidates via web search, read the most promising sources, and produce a curated shortlist.

PROCESS
1. Start with a broad serpapi_search to find products in the price range.
2. Run a second serpapi_search with source="reddit" to gather community sentiment.
3. Use fetch_url on the 3–6 most promising results — product pages, review articles, top Reddit threads. You MUST call fetch_url at least ${MIN_FETCHES_BEFORE_RECORD} times before calling record_candidates; the orchestrator enforces this.
4. For EACH product you intend to shortlist, run one more serpapi_search for that exact product name (e.g. "Razer Blade 16") and take that product's OWN page from the results — a retailer/manufacturer listing or a review dedicated to that one product. That is the url you record for it. A URL from search results is eligible without fetching it.
5. Score each viable candidate against the rubric. Discard candidates that fall short.
6. Call record_candidates EXACTLY ONCE with your final shortlist and a short scout_note. Then stop.

URL RULES (strict — enforced by the orchestrator)
- Every URL in record_candidates MUST be a URL that appeared in serpapi_search results or that you passed to fetch_url during THIS run.
- Do NOT invent URLs from memory. Do NOT guess product URLs.
- Do NOT modify URLs (no truncating, no removing query params, no swapping domains). Paste them EXACTLY as the tool returned them.
- Prefer URLs you have actually fetched and read — those are the ones you have evidence for.
- Each candidate's url MUST point to that ONE product's own page (a retailer/product listing, or the single review/thread about that product). NEVER use a "best of"/roundup/listicle URL or a generic search-results page as a candidate url, and NEVER reuse the same url for two candidates — every candidate needs its OWN distinct url. If your evidence came from a roundup, run another search for the specific product to find its own page, then record that. Cite roundups in sources_considered, never in url.
- A url that differs from another only by its #fragment (anchor) is the SAME page. Never use fragments or tracking params to make one page look like several distinct urls.

SCORING RUBRIC (0–100, weighted)
- Brand legitimacy: 25
- Community sentiment (Reddit, reviews): 25
- Price-to-budget fit: 20  (inside budget = full credit; over by ≤5% partial; over by >20% reject)
- Safety / red flags: 20  (subtractive — battery fires, recalls, scam reports = critical flags → verdict "reject")
- Source diversity: 10  (require ≥2 independent sources before recommending)

VERDICTS
- recommend: score ≥ 70, no critical safety flag, price ≤ budget × 1.05
- flag:      50 ≤ score < 70, OR caveats present, OR limited evidence
- reject:    score < 50, OR critical safety flag, OR price > budget × 1.20

CONSTRAINTS
- Do not exceed ${MAX_SEARCH_CALLS} searches or ${MAX_FETCH_CALLS} fetches, unless a tool message grants you a higher budget.
- Cite the URLs you actually read in sources_considered.
- Keep reasoning concise (1–3 sentences).
- USD only. If a price isn't visible, use null.
- Do not invent prices, recalls, or reviews. If unsure, say so in flags.`;

export async function runAgent(input: AlertInput): Promise<AgentRunResult> {
  const client = getTarsClient();
  const model = getTarsModel();

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Alert:
- query: ${input.query}
- max budget (USD): ${input.maxBudgetUsd}

Find the best candidates. Use the tools. Call record_candidates exactly once when done.`,
    },
  ];

  const counts = { search: 0, fetch: 0, record: 0 };
  // Mutable budgets: Gate D repairs raise them so "search for each product's
  // own page" is actionable even when the initial budget is already spent.
  let searchCap = MAX_SEARCH_CALLS;
  let fetchCap = MAX_FETCH_CALLS;
  // One repair per gate (instead of a shared retry counter) so tripping an
  // early gate doesn't consume the URL-quality gate's repair chance.
  const repairs = { fetchGate: false, schema: false, unknownUrls: false, urlQuality: 0 };
  const seenUrls = new Set<string>();
  let tokensIn = 0;
  let tokensOut = 0;
  let final: Digest | undefined;

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 4096,
    });

    tokensIn += completion.usage?.prompt_tokens ?? 0;
    tokensOut += completion.usage?.completion_tokens ?? 0;

    const choice = completion.choices[0];
    if (!choice) throw new Error('TARS returned no choices');
    const msg = choice.message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      logger.warn({ iter, content: msg.content?.slice(0, 200) }, 'agent.no_tool_call');
      // Nudge the model once.
      messages.push({
        role: 'user',
        content: 'You must call record_candidates to finish. If you have evaluated enough sources, do that now.',
      });
      continue;
    }

    for (const tc of msg.tool_calls) {
      if (tc.type !== 'function') continue;
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `error: tool arguments were not valid JSON` });
        continue;
      }

      if (name === 'serpapi_search') {
        if (counts.search >= searchCap) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `error: search budget exhausted (max ${searchCap}). Stop searching and call record_candidates.` });
          continue;
        }
        counts.search++;
        const queryArg = args['query'];
        const query = typeof queryArg === 'string' ? queryArg : '';
        const source = args['source'] === 'reddit' ? 'reddit' : 'web';
        try {
          const results = await serpapiSearch(query, source === 'reddit' ? { redditOnly: true } : {});
          for (const r of results) if (r.url) seenUrls.add(r.url);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(results.slice(0, 10)),
          });
          logger.info({ iter, tool: 'serpapi_search', query, source, returned: results.length }, 'agent.tool');
        } catch (err) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `error: ${(err as Error).message}` });
        }
      } else if (name === 'fetch_url') {
        if (counts.fetch >= fetchCap) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `error: fetch budget exhausted (max ${fetchCap}). Stop fetching and call record_candidates.` });
          continue;
        }
        counts.fetch++;
        const urlArg = args['url'];
        const url = typeof urlArg === 'string' ? urlArg : '';
        try {
          const page = await fetchAndExtract(url);
          // Allowlist only after a successful fetch: a URL the model merely
          // TRIED to fetch may be invented; success proves the page exists
          // and was actually read.
          if (url) seenUrls.add(url);
          if (page.finalUrl) seenUrls.add(page.finalUrl);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ url: page.finalUrl, title: page.title, byline: page.byline, text: page.text }),
          });
          logger.info({ iter, tool: 'fetch_url', url, chars: page.text.length }, 'agent.tool');
        } catch (err) {
          const reason = err instanceof FetchError ? err.message : String((err as Error).message ?? err);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `error: ${reason}` });
        }
      } else if (name === 'record_candidates') {
        counts.record++;
        if (counts.record > MAX_RECORD_ATTEMPTS) {
          throw new Error(`record_candidates exceeded ${MAX_RECORD_ATTEMPTS} attempts without passing validation gates`);
        }

        // Gate A: must have actually opened pages before recording.
        if (counts.fetch < MIN_FETCHES_BEFORE_RECORD) {
          if (repairs.fetchGate) {
            throw new Error(`record_candidates called with insufficient fetches (${counts.fetch} < ${MIN_FETCHES_BEFORE_RECORD}) after retry`);
          }
          repairs.fetchGate = true;
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `error: you must call fetch_url at least ${MIN_FETCHES_BEFORE_RECORD} times before recording candidates. You have fetched ${counts.fetch} so far. Fetch the most promising results, then call record_candidates again.`,
          });
          continue;
        }

        // Gate B: schema.
        const parsed = digestSchema.safeParse(args);
        if (!parsed.success) {
          if (repairs.schema) {
            throw new Error(`record_candidates schema invalid after retry: ${parsed.error.message}`);
          }
          repairs.schema = true;
          const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `error: schema validation failed (${issues}). Re-call record_candidates with corrected fields.`,
          });
          continue;
        }

        // Gate C: every URL must have been surfaced by a tool during this run.
        const unknownUrls = parsed.data.candidates
          .map((c) => c.url)
          .filter((u) => !seenUrls.has(u));
        if (unknownUrls.length > 0) {
          if (repairs.unknownUrls) {
            throw new Error(`record_candidates referenced unknown URLs after retry: ${unknownUrls.join(', ')}`);
          }
          repairs.unknownUrls = true;
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `error: these URLs were never returned by serpapi_search or fetch_url during this run: ${unknownUrls.join(', ')}. Replace them with URLs you have actually seen from the tool outputs and re-call record_candidates.`,
          });
          continue;
        }

        // Gate D: URL quality. Two failure modes, both observed in the wild:
        //  (1) one URL reused across candidates — compared in normalized form
        //      so #fragment / tracking-param variants of one page count as
        //      the same page;
        //  (2) a candidate url that is a roundup/"best of"/search page rather
        //      than that product's own page.
        // Repairs raise the search/fetch budgets so "search for each
        // product's own page" is actionable even when budgets were spent.
        const dupeUrls = findDuplicateUrls(parsed.data.candidates);
        const genericCands = parsed.data.candidates.filter((c) => isGenericListUrl(c.url));
        if (dupeUrls.length > 0 || genericCands.length > 0) {
          if (repairs.urlQuality < MAX_URL_QUALITY_REPAIRS) {
            repairs.urlQuality++;
            // +3 per repair: a full shortlist can need one search per
            // candidate (up to 5) on top of the 2 broad searches.
            searchCap = Math.min(searchCap + 3, 12);
            fetchCap = Math.min(fetchCap + 2, 12);
            const problems: string[] = [];
            if (dupeUrls.length > 0) {
              problems.push(`These URLs are used by more than one candidate (URLs differing only by #fragment are the SAME page): ${dupeUrls.join(', ')}.`);
            }
            for (const c of genericCands) {
              problems.push(`"${c.title}" links to ${c.url} — a roundup/list/search page, not that product's own page.`);
            }
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `error: candidate URL quality check failed. ${problems.join(' ')} For each affected product, run serpapi_search for its exact product name and use that product's OWN page from the results (a retailer/manufacturer listing, or a review/thread about that one product) — search-result URLs are eligible without fetching them. Keep roundups in sources_considered only. Your budgets were raised: ${searchCap} searches total (${searchCap - counts.search} remaining) and ${fetchCap} fetches total (${fetchCap - counts.fetch} remaining). Re-call record_candidates with a unique, product-specific url per candidate.`,
            });
            logger.warn({ iter, dupes: dupeUrls, generic: genericCands.map((c) => c.url), repair: repairs.urlQuality }, 'agent.url_quality.repair');
            continue;
          }
          // Out of repairs: accept rather than fail the run. The dedupe
          // safety net below collapses duplicates; surviving roundup URLs
          // are logged so we can see how often steering falls short.
          logger.warn({ iter, dupes: dupeUrls, generic: genericCands.map((c) => c.url) }, 'agent.url_quality.accepted_after_retries');
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: 'ok' });
        final = parsed.data;
        logger.info({ iter, candidates: final.candidates.length }, 'agent.record');
        break;
      } else {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `error: unknown tool ${name}` });
      }
    }

    if (final) {
      // Safety nets, in order: collapse same-page duplicates, then drop
      // roundup/search links when a real product page survived (keeps the
      // digest non-empty if EVERY url is generic), then prune dead links.
      const deduped = preferProductPages(dedupeCandidatesByUrl(final));
      if (deduped.candidates.length < final.candidates.length) {
        logger.warn(
          { recorded: final.candidates.length, kept: deduped.candidates.length },
          'agent.url_quality.safety_net_dropped',
        );
      }
      const verified = await pruneDeadLinks(deduped);
      return {
        digest: verified,
        iterations: iter,
        toolCalls: counts,
        tokensIn,
        tokensOut,
      };
    }
  }

  throw new Error(`Agent did not finish within ${MAX_ITERATIONS} iterations`);
}

// HEAD/GET-checks each candidate URL and drops ONLY explicitly dead links
// (404/410). Bot-detection 403/503, rate limits, timeouts, and network
// errors keep the URL — the user's real browser will likely still load it.
async function pruneDeadLinks(digest: Digest): Promise<Digest> {
  if (digest.candidates.length === 0) return digest;
  const checks = await Promise.all(digest.candidates.map((c) => verifyUrlLive(c.url)));
  const alive: Digest['candidates'] = [];
  const dropped: Array<{ url: string; status: number | null }> = [];
  const summary: Array<{ url: string; status: number | null; ok: boolean; kept: boolean }> = [];
  for (let i = 0; i < digest.candidates.length; i++) {
    const candidate = digest.candidates[i];
    const check = checks[i];
    if (!candidate || !check) continue;
    const kept = !check.dead;
    summary.push({ url: candidate.url, status: check.statusCode, ok: check.ok, kept });
    if (kept) {
      alive.push(candidate);
    } else {
      dropped.push({ url: candidate.url, status: check.statusCode });
    }
  }
  logger.info({ summary, dropped: dropped.length, kept: alive.length }, 'agent.url_verify');
  if (dropped.length > 0) {
    logger.warn({ dropped }, 'agent.url_verify.dead_links');
  }
  return { ...digest, candidates: alive };
}
