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
import { fetchAndExtract, FetchError } from '../fetch/fetcher.js';
import { digestSchema, type Digest } from './schema.js';
import { logger } from '../../lib/logger.js';

const MAX_ITERATIONS = 12;
const MAX_SEARCH_CALLS = 4;
const MAX_FETCH_CALLS = 8;

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
                url: { type: 'string' },
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
3. Use fetch_url on the 3–6 most promising results — product pages, review articles, top Reddit threads.
4. Score each viable candidate against the rubric. Discard candidates that fall short.
5. Call record_candidates EXACTLY ONCE with your final shortlist and a short scout_note. Then stop.

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
- Do not exceed 4 searches or 8 fetches.
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
        if (counts.search >= MAX_SEARCH_CALLS) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: 'error: search budget exhausted (max 4). Stop searching and call record_candidates.' });
          continue;
        }
        counts.search++;
        const queryArg = args['query'];
        const query = typeof queryArg === 'string' ? queryArg : '';
        const source = args['source'] === 'reddit' ? 'reddit' : 'web';
        try {
          const results = await serpapiSearch(query, source === 'reddit' ? { redditOnly: true } : {});
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
        if (counts.fetch >= MAX_FETCH_CALLS) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: 'error: fetch budget exhausted (max 8). Stop fetching and call record_candidates.' });
          continue;
        }
        counts.fetch++;
        const urlArg = args['url'];
        const url = typeof urlArg === 'string' ? urlArg : '';
        try {
          const page = await fetchAndExtract(url);
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
        const parsed = digestSchema.safeParse(args);
        if (!parsed.success) {
          if (counts.record >= 2) {
            throw new Error(`record_candidates schema invalid after retry: ${parsed.error.message}`);
          }
          const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `error: schema validation failed (${issues}). Re-call record_candidates with corrected fields.`,
          });
          continue;
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
      return {
        digest: final,
        iterations: iter,
        toolCalls: counts,
        tokensIn,
        tokensOut,
      };
    }
  }

  throw new Error(`Agent did not finish within ${MAX_ITERATIONS} iterations`);
}
