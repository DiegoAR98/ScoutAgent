# ScoutAgent

An autonomous shopping research agent. Submit a product and a budget; the agent searches the web, reads reviews and Reddit, scores the options against a transparent rubric, and emails you one curated digest in under two minutes.

No chat interface. No app to install. One request, one report.

> Built for the Tetrate AI Agent Buildathon. All LLM traffic routes through Tetrate TARS (Tetrate Agent Router Service); the codebase has no direct dependency on any specific model provider.

---

## Why it exists

Searching `"electric bike under $500"` returns 91 million results — a mix of drop-shippers, fake discounts, sponsored listings, and outright safety hazards. The average high-consideration purchase costs the buyer two or more hours of cross-referencing Reddit, review sites, and price-history tools.

That is research work. Agents are good at research work. ScoutAgent does it.

---

## Demo flow

1. User opens the form and submits `{ query, max_budget_usd, email }`.
2. Server returns `202 Accepted` immediately with a `request_id`.
3. A background task runs the agent loop:
   - 1–2 `serpapi_search` calls (Google web + `site:reddit.com`)
   - 2–6 `fetch_url` calls against the most promising results
   - LLM reasons over the extracted text, scores each candidate against the rubric, and emits a structured shortlist via the `record_candidates` tool
   - Recommended URLs are HEAD/GET-verified; explicit 404s and 410s are dropped
4. The shortlist is sent as an HTML digest via EmailJS.
5. Email arrives in the user's inbox in ~60–90 seconds.

---

## Architecture

```
   user browser
        |
        v
   Web form (HTML)
        |
        | POST /api/research  ──►  202 Accepted (fire-and-forget)
        v
   Express server
        |
        +──► Agent loop  (background task)
              |
              +──► SerpAPI  (search)
              +──► Mozilla Readability + jsdom  (page extraction)
              +──► Tetrate TARS  (LLM tool-use reasoning)
              |
              v
        EmailJS REST
              |
              v
        user's inbox
```

| Component       | Technology |
|-----------------|------------|
| Runtime         | Node.js 20+ |
| Language        | TypeScript (strict) |
| Web server      | Express |
| Search          | SerpAPI |
| Page extraction | `@mozilla/readability` + `jsdom`, `cheerio` fallback |
| LLM gateway     | Tetrate TARS (OpenAI Chat Completions protocol) |
| Default model   | `claude-sonnet-4-6` (set via `TARS_MODEL`) |
| LLM SDK         | `openai` (pointed at `TARS_API_URL`) |
| Email           | EmailJS (template lives in their dashboard) |
| Validation      | Zod (env, request body, LLM output) |
| Logging         | pino (pino-pretty in dev, JSON in prod) |
| Deployment      | Render (single web service, free tier) |

---

## Project structure

```
src/
  lib/
    env.ts            Zod-validated environment loader (fails fast)
    logger.ts         pino logger
  agent/
    search/
      serpapi.ts      Thin SerpAPI client; supports site:reddit.com mode
    fetch/
      fetcher.ts      fetchAndExtract + verifyUrlLive (HEAD/GET liveness check)
    llm/
      tarsClient.ts   OpenAI SDK pointed at TARS
      schema.ts       Zod schemas for the LLM's structured output
      agent.ts        Tool-use loop, guardrails, scoring rubric
    mail/
      digest.ts       Builds EmailJS template_params (no HTML generated here)
      emailer.ts      EmailJS REST sender (requires private access token)
    run.ts            CLI entrypoint (also used for local smoke testing)
  web/
    server.ts         Express server: GET /, GET /healthz, POST /api/research
    index.html        Single-page submission form
template.html         The digest template; mirror this in your EmailJS dashboard
```

---

## How the agent works

### Tools exposed to the model

| Tool                  | Purpose |
|-----------------------|---------|
| `serpapi_search`      | Google search; `source: 'web' \| 'reddit'`. Returns up to 10 organic + shopping hits. |
| `fetch_url`           | Fetches a URL with a 10s timeout + 500KB body cap; returns readable text via Readability. |
| `record_candidates`   | Submits the final shortlist. Calling it terminates the loop. |

### Scoring rubric (sum to 100)

| Dimension              | Weight | What it measures |
|------------------------|--------|------------------|
| Brand legitimacy       | 25     | Real brand, real warranty, not a drop-shipper |
| Community sentiment    | 25     | Reddit / forum consensus |
| Price-to-budget fit    | 20     | Inside budget = full credit; over by >20% = reject |
| Safety / red flags     | 20     | Subtractive — fires, recalls, scam reports = critical flag |
| Source diversity       | 10     | At least two independent source types |

### Verdicts

- `recommend`: `score >= 70` AND no critical safety flag AND `price <= budget * 1.05`
- `flag`: `50 <= score < 70`, or caveats, or limited evidence
- `reject`: `score < 50`, or critical safety flag, or `price > budget * 1.20`

### Anti-hallucination guardrails

The orchestrator enforces three rules around the `record_candidates` tool call. Each runs as a separate gate; if any fails, the model gets a repair message and one retry.

1. **Fetch gate.** The model must call `fetch_url` at least twice before it's allowed to record findings. Prevents recording based on SerpAPI snippets alone.
2. **URL allowlist.** Every URL in the shortlist must have appeared in a tool output during this run (either a `serpapi_search` result or a URL passed to `fetch_url`). Prevents the model from inventing product URLs from memory.
3. **Liveness check.** After parsing the shortlist, each URL is verified with a 3–6 s HEAD (falling back to GET). URLs returning explicit `404` or `410` are dropped. Bot-detection `403`/`503`, rate limits, and timeouts keep the URL — a real browser will likely still load it.

If pruning leaves zero recommended candidates, the empty-state digest is sent rather than skipping silently.

---

## Running locally

### Prerequisites

- Node.js 20 or later
- A SerpAPI key (free tier: 100 searches/month)
- A Tetrate TARS account with `TARS_API_KEY` and `TARS_API_URL`
- An EmailJS account with a service id, published template, public key, and private access token

### Setup

```bash
git clone https://github.com/DiegoAR98/ScoutAgent.git
cd ScoutAgent
npm install
cp .env.example .env
```

Fill in `.env` with your real credentials. See [.env.example](.env.example) for the full list of variables and notes.

### Commands

| Command                  | What it does |
|--------------------------|--------------|
| `npm run dev:web`        | Start the web server with auto-reload at http://localhost:3000 |
| `npm run run:slice`      | Run the agent once from the CLI; requires `--to <email>` |
| `npm run run:slice:dry`  | Same as above but skips the EmailJS send; prints the digest payload to stdout |
| `npm run build`          | Compile TypeScript and copy `index.html` into `dist/` |
| `npm start`              | Run the compiled server from `dist/` (production mode) |
| `npm run typecheck`      | Type-check without emitting |
| `npm run lint`           | ESLint (`@typescript-eslint/recommended-type-checked`) |

### Quick CLI smoke test

```bash
npm run run:slice:dry -- --query "noise-cancelling headphones" --budget 200
```

Prints the EmailJS `template_params` JSON to stdout without sending an email — useful for verifying the agent loop without burning an EmailJS quota.

For a real send:

```bash
npm run run:slice -- --query "noise-cancelling headphones" --budget 200 --to you@example.com
```

---

## Deploying to Render

This repo includes a [`render.yaml`](render.yaml) blueprint for one-click Render deploys.

1. Push the repo to GitHub.
2. In the Render dashboard: **New → Blueprint**, point at the repo.
3. Render creates one Web Service named `scoutagent`.
4. Fill in the secret env vars when prompted (the ones marked `sync: false` in `render.yaml`).
5. Deploy. First build takes ~2 minutes; subsequent deploys are faster.

The live form is at the service root. The health check is at `/healthz`.

**Note on the free tier:** the service sleeps after 15 minutes of inactivity and pays a ~50-second cold start on the next request. For a live demo, ping `/healthz` 60 seconds before showing the form to keep it warm.

### Required environment variables

| Variable                  | Purpose                                                                  |
|---------------------------|--------------------------------------------------------------------------|
| `TARS_API_URL`            | Tetrate TARS base URL (no trailing quotes when pasting into Render)      |
| `TARS_API_KEY`            | TARS bearer token                                                        |
| `TARS_MODEL`              | Model id; defaults to `claude-sonnet-4-6`                                |
| `SERPAPI_KEY`             | SerpAPI key                                                              |
| `EMAIL_JS_SERVICE_ID`     | EmailJS service id (from Email Services)                                 |
| `EMAIL_JS_TEMPLATE`       | EmailJS template id (from Email Templates)                               |
| `EMAIL_JS_API_KEY`        | EmailJS Public Key (the `user_id` field in their REST API)               |
| `EMAIL_JS_PRIVATE_KEY`    | EmailJS Private Key — required for backend (non-browser) sends           |
| `NODE_ENV`                | `production` on Render; `development` locally                            |
| `LOG_LEVEL`               | `info` in production; `debug` locally                                    |
| `PORT`                    | Provided automatically by Render                                         |

EmailJS also requires you to enable **API access from non-browser environments** in the dashboard at `Account → Security`. Without it, server-side sends are rejected with `403`.

---

## Documents

- [Scoutagentproposal.md](Scoutagentproposal.md) — product pitch and demo plan
- [SRS.md](SRS.md) — software requirements specification (functional and non-functional)

---

## Out of scope for the buildathon

These were in the original spec but cut to keep the build focused. They are the natural follow-ups:

- Recurring schedules (daily / weekly / biweekly alerts on a saved query)
- Persistent storage of past requests, runs, or candidates
- Deduplication of repeated requests
- User accounts and unsubscribe flows
- SendGrid / bounce webhook handling
- Multi-currency support
- Rate limiting and per-IP abuse protection
- WhatsApp / SMS delivery

---

## License

See [LICENSE](LICENSE).
