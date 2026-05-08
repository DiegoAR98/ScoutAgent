# ScoutAgent — Software Requirements Specification

**Version:** 1.0
**Date:** 2026-04-30
**Status:** Approved for hackathon implementation
**Owner:** Diego Araujo / Minas Digital LLC

---

## 1. Introduction

### 1.1 Purpose

This Software Requirements Specification (SRS) defines the functional and non-functional requirements, external interfaces, agent behavior, data models, and error-handling contracts for **ScoutAgent**, an autonomous shopping research agent. It is the canonical reference for implementation, testing, and demo acceptance during the hackathon.

Intended audience: implementing engineer (the builder), reviewers, and judges evaluating completeness against the proposal.

### 1.2 Scope

ScoutAgent ingests user-defined shopping alerts (query + budget + email + frequency) via a public web form, runs scheduled research jobs that combine web search, page fetching, and LLM-based reasoning, and delivers curated email digests of legitimate, on-budget product picks.

Product vision and pitch are described in [Scoutagentproposal.md](Scoutagentproposal.md). This SRS supersedes the proposal where they conflict on technical detail.

### 1.3 Definitions, Acronyms & Abbreviations

| Term | Definition |
|---|---|
| Alert | A persisted user request to research a query on a recurring schedule. |
| Run | A single execution of the agent loop for one alert at one point in time. |
| Candidate | A product/URL surfaced by search and scored by the agent. |
| Pick | A candidate whose verdict is `recommend` and which appears in the digest. |
| Digest | The HTML email sent to the user summarizing picks, warnings, and avoids. |
| Verdict | One of `recommend`, `flag`, `reject` assigned to each candidate. |
| Dedupe key | Stable identifier (canonical URL + price bucket) used to suppress repeats. |
| TARS | Tetrate Agent Router Service — OpenAI-compatible LLM gateway routing to Claude/GPT/etc. by model id. |
| SerpAPI | Third-party Google search results API used for source discovery. |
| SRS | Software Requirements Specification (this document). |
| FR | Functional Requirement (numbered FR-NN). |
| NFR | Non-Functional Requirement. |

### 1.4 References

- [Scoutagentproposal.md](Scoutagentproposal.md) — product proposal and demo plan
- SerpAPI documentation — https://serpapi.com/search-api
- SendGrid Mail Send v3 — https://docs.sendgrid.com/api-reference/mail-send/mail-send
- OpenAI Chat Completions API (TARS exposes a compatible shape) — https://platform.openai.com/docs/api-reference/chat
- Azure Functions Node.js timer trigger — https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer
- IEEE 830-1998 — Recommended Practice for Software Requirements Specifications

---

## 2. Overall Description

### 2.1 Product Perspective

ScoutAgent is a self-contained system composed of three logical components:

```
                     ┌─────────────────────┐
   user browser ───► │  Web Form (HTML)    │ ──► POST /api/alerts ──┐
                     └─────────────────────┘                        │
                                                                    ▼
                                                      ┌──────────────────────┐
                                                      │   PostgreSQL         │
                                                      │   (alerts, runs,     │
                                                      │    candidates,       │
                                                      │    dedupe, sends)    │
                                                      └──────────┬───────────┘
                                                                 │
   Azure Functions timer trigger (every 15 min) ────────────────►│
                              │                                  │
                              ▼                                  │
                ┌──────────────────────────┐                     │
                │   Agent Worker           │  reads/writes ◄─────┘
                │   ┌────────────────────┐ │
                │   │ search (SerpAPI)   │ │
                │   │ fetch (Readability)│ │
                │   │ reason (TARS)      │ │
                │   │ compose            │ │
                │   │ send (SendGrid)    │ │
                │   └────────────────────┘ │
                └──────────────────────────┘
                              │
                              ▼
                       user inbox (HTML email)
```

No real-time interaction; all output is asynchronous via email.

### 2.2 Product Functions (high-level)

1. Accept and persist user alerts via a public web form.
2. On a fixed cadence, evaluate alerts due for refresh.
3. For each due alert, search the web, fetch top candidate pages, and reason over the content.
4. Score, filter, and select up to three picks plus optional warnings.
5. Deduplicate against prior digests.
6. Render and send a curated HTML email digest.
7. Record run metrics, costs, and outcomes for observability and dedupe.

### 2.3 User Classes

| Class | Description | Access |
|---|---|---|
| End User | Submits the form, receives digests. Identified solely by email. No password, no account. | Web form, email inbox. |
| Operator | Builder / on-call developer. Reads logs, queries DB, manages alert lifecycle manually if needed. | DB credentials, log dashboard, environment secrets. |

### 2.4 Operating Environment

- Node.js ≥ 20 LTS, TypeScript ≥ 5.4
- PostgreSQL ≥ 15
- **Production scheduler:** Azure Functions (Node 20 runtime, Consumption or Flex plan) using a timer trigger
- **Local development:** node-cron inside a long-running container (functional parity, not deployed to prod)
- TLS-capable outbound network access to SerpAPI, TARS, and SendGrid endpoints
- ESM-compatible toolchain (top-level `await`, `import` syntax)

### 2.5 Design & Implementation Constraints

- TypeScript `strict: true` mode required; no `any` in business logic
- No frontend framework (plain HTML + minimal vanilla JS for form submission)
- All scheduling is server-side; no on-demand "run now" endpoint in MVP (operator may run via DB update of `next_run_at`)
- All LLM calls **must** route through Tetrate TARS — direct calls to provider APIs (`api.anthropic.com`, `api.openai.com`) are forbidden
- TARS speaks the OpenAI Chat Completions protocol; the official `openai` SDK is used with `baseURL = TARS_API_URL`
- Secrets only via environment variables (`SERPAPI_KEY`, `TARS_API_KEY`, `TARS_API_URL`, `SENDGRID_API_KEY`, `DATABASE_URL`, `EMAIL_FROM`)
- All outbound HTTP must enforce timeouts; no unbounded waits
- All SQL must be parameterized; no string interpolation into queries

### 2.6 Assumptions & Dependencies

- Tetrate TARS exposes an OpenAI Chat Completions-compatible endpoint (`POST /v1/chat/completions`) with function/tool-calling support; model id selects the upstream provider (e.g., `claude-sonnet-4-6`, `claude-haiku-4-5`, `gpt-4o-mini`).
- SerpAPI quota is sufficient for demo and post-demo soak (≥ 1k searches/month available).
- SendGrid sender identity (`EMAIL_FROM`) is verified before deployment.
- PostgreSQL is reachable from the Azure Functions runtime (managed instance or Azure DB for PostgreSQL recommended).
- The user trusts ScoutAgent with their email address; no encryption at rest beyond database defaults is required for MVP.

---

## 3. Functional Requirements

Each requirement is testable. Acceptance criteria are stated in Given/When/Then form.

### 3.1 Alert Management

#### FR-01 — Submit alert via web form

**Description:** The system shall accept alert submissions via `POST /api/alerts` with JSON body `{ query, max_budget_usd, email, frequency }`.

**Validation:**
- `query`: trimmed string, length 3–200 chars
- `max_budget_usd`: integer, 1 ≤ x ≤ 100000
- `email`: RFC 5322 valid syntax, length ≤ 254
- `frequency`: enum `daily` | `weekly` | `biweekly`

**Acceptance Criteria:**
- Given a valid request, when the endpoint is called, then it returns `201 Created` with the new alert's `id`.
- Given any invalid field, when the endpoint is called, then it returns `400 Bad Request` with a JSON error listing offending field(s).
- Given malformed JSON, when posted, then it returns `400` with `{"error":"invalid_json"}`.

#### FR-02 — Persist alert to PostgreSQL

**Description:** A successful alert submission shall create a row in `alerts` with a generated UUID, `created_at`, `updated_at`, and `next_run_at = now() + 1 minute`.

**Acceptance Criteria:**
- Given FR-01 success, then a row exists in `alerts` with `active = true` and `next_run_at` set to within 60–90s of the request time.

#### FR-03 — Confirmation page after submit

**Description:** The web form shall display a confirmation message ("You're all set — first digest within 24 hours") on success, and a field-level error message on failure. No email confirmation is sent in MVP.

**Acceptance Criteria:**
- Given a successful submit, when the response is received, then a confirmation panel replaces the form.
- Given an HTTP 4xx response, then the offending field is highlighted with the server-provided message.

#### FR-04 — Idempotent re-submission

**Description:** When a submission's `(lower(email), lower(trim(query)))` pair matches an existing active alert, the system shall update that alert's `max_budget_cents`, `frequency`, and `updated_at` instead of inserting a duplicate.

**Acceptance Criteria:**
- Given an existing alert for `(alice@x.com, "electric bike")`, when the same email re-submits with a new budget, then exactly one row remains with the new budget.

### 3.2 Scheduling

#### FR-05 — Timer-triggered evaluation

**Description:** An Azure Functions timer trigger (CRON `0 */15 * * * *`, every 15 minutes) shall claim all alerts where `active = true` AND `next_run_at <= now()` AND `status != 'running'`, mark each `status = 'running'`, and execute the agent loop sequentially per claim.

**Acceptance Criteria:**
- Given two alerts due at the same time, when the trigger fires, then both run within the same invocation (or queue up across invocations) and neither runs twice.

#### FR-06 — Reschedule after run

**Description:** After a run completes (success OR error), the system shall set `last_run_at = now()`, `status = 'idle'`, and recompute `next_run_at`:
- `daily` → `now() + interval '1 day'`
- `weekly` → `now() + interval '7 days'`
- `biweekly` → `now() + interval '14 days'`

On retryable failure (see §8), `next_run_at` is set to `now() + interval '15 minutes'` instead, up to `error_count` of 3.

**Acceptance Criteria:**
- Given a successful weekly run at T, then `next_run_at = T + 7d ± 1s`.
- Given 3 consecutive errored runs, then the alert is deactivated (`active = false`, see FR-21 / §8).

#### FR-07 — Concurrency lock

**Description:** Alert claiming shall use `SELECT ... FOR UPDATE SKIP LOCKED` (or equivalent atomic compare-and-set on `status`) to prevent the same alert from running concurrently across overlapping function invocations.

**Acceptance Criteria:**
- Given two simultaneous timer invocations, when both attempt to claim the same alert, then exactly one succeeds.

### 3.3 Search & Fetch

#### FR-08 — Build SerpAPI query

**Description:** For each run, the system shall call SerpAPI with `q = "<alert.query> under $<budget> review"` (and `engine = google`). It shall make at least two distinct queries: one general and one with `site:reddit.com` to capture community discussion.

**Acceptance Criteria:**
- Given an alert with query `"electric bike"` and budget `500`, then SerpAPI is called with `q="electric bike under $500 review"` and `q="electric bike under $500 site:reddit.com"`.

#### FR-09 — Source diversity

**Description:** The candidate set passed to the LLM shall contain results from ≥ 3 distinct domains across ≥ 2 source types (general, reddit, review-site).

**Acceptance Criteria:**
- Given SerpAPI returns 20 results all from `amazon.com`, then the run aborts with `error = 'insufficient_source_diversity'` and emails are NOT sent.

#### FR-10 — Page fetching

**Description:** The agent shall fetch up to 8 candidate pages with:
- per-request timeout of 10 seconds
- response body cap of 500 KB (truncate, do not abort)
- `User-Agent: ScoutAgent/1.0 (+contact@minasdigital.com)`
- respect `robots.txt` for review sites (best-effort; failure to retrieve robots.txt is non-blocking)

**Acceptance Criteria:**
- Given 8 URLs, when fetching, then no fetch blocks the run for more than 10 s.
- Given a 5 MB page, then only the first 500 KB is retained.

#### FR-11 — HTML to text extraction

**Description:** Fetched HTML shall be reduced to readable text (e.g., via `@mozilla/readability` or `cheerio` extraction of `<article>`, `<main>`, paragraphs, headings, lists) before being passed to the LLM. Scripts, styles, navs, and footers must be stripped.

**Acceptance Criteria:**
- Given a typical product review page, the extracted text contains the review body and excludes nav/footer boilerplate.
- Given a page that fails extraction, the system falls back to plain text (`textContent`) capped at 50 KB per page.

### 3.4 Reasoning & Scoring

#### FR-12 — Structured LLM output

**Description:** The reasoning step shall produce a JSON object matching this schema:

```ts
{
  candidates: Array<{
    title: string;
    url: string;
    price_usd: number | null;
    score: number;          // 0..100 integer
    verdict: 'recommend' | 'flag' | 'reject';
    reasoning: string;       // <= 500 chars
    flags: string[];         // e.g., ["battery_fire_risk"]
    sources_considered: string[]; // URLs cited
  }>;
  scout_note: string;        // <= 240 chars; market context for the user
}
```

The LLM call shall use temperature `0.2` and a forced tool/JSON-output mechanism. On schema validation failure, the agent retries the call once with a corrective system message; a second failure aborts the run (see §8).

**Acceptance Criteria:**
- Given a successful run, then the persisted run record references at least one candidate row whose `verdict ∈ {recommend, flag, reject}` and whose `score` is an integer in `[0, 100]`.

#### FR-13 — Verdict rules

**Description:** Verdicts are assigned per the rules in §6.4. The LLM is instructed via system prompt to apply them; the worker re-validates each candidate after parsing and downgrades any verdict that contradicts the rules (e.g., `recommend` with `price > budget × 1.05` is forced to `flag`).

#### FR-14 — Top picks selection

**Description:** From the parsed candidates, the system shall select up to 3 with `verdict = 'recommend'`, ordered by `score` descending, breaking ties by lowest `price_usd`.

**Acceptance Criteria:**
- Given 5 recommend candidates, then exactly 3 appear in the digest.
- Given 1 recommend candidate, then 1 appears.
- Given 0 recommend candidates, then FR-20 applies.

#### FR-15 — Surface a flag

**Description:** The system shall include up to 1 `flag` candidate in the "Worth knowing" / "Avoid" digest section if it adds informational value (e.g., a popular product with a noteworthy concern).

### 3.5 Deduplication

#### FR-16 — Compute dedupe key

**Description:** For each candidate eventually included in a digest, the system shall compute:

```
dedupe_key = sha1(canonicalize(url) + ':' + price_bucket)
price_bucket = floor(price_usd / max(10, budget * 0.05))
```

`canonicalize` strips tracking params (`utm_*`, `tag=`, `ref=`, fragment), lowercases host, removes trailing slash.

#### FR-17 — Suppress repeats

**Description:** Before sending, the system shall query `digest_log` for `(alert_id, dedupe_key)` records sent within the last 30 days. A candidate is suppressed unless its `price_cents` is at least 10% lower than the stored `last_price_cents`. Suppressed picks are replaced from the next-best `recommend` candidate.

**Acceptance Criteria:**
- Given a pick sent last week at $399, when it appears again at $395 this week, then it is suppressed.
- Given the same pick at $349 this week (≥ 10% drop from $399), then it is included again with a "price dropped" indicator.

### 3.6 Email Delivery

#### FR-18 — Render HTML email

**Description:** The system shall render an HTML email containing:
- Subject: `🔍 Your <frequency> ScoutAgent report — <query>`
- A "Top Pick" block (highest-scoring recommend)
- Up to two additional pick blocks
- An optional "Worth knowing" / "Avoid" block (FR-15)
- The agent's `scout_note`
- A footer with the alert id, "change settings" link (URL with alert id token), and unsubscribe link

All user-controlled fields (query, scout note, candidate titles) must be HTML-escaped.

**Acceptance Criteria:**
- Given an alert with query `<script>alert(1)</script>`, then the rendered email contains the literal text and no executable script tag.

#### FR-19 — Send via SendGrid

**Description:** The system shall send the digest via SendGrid `/v3/mail/send` with:
- `from = EMAIL_FROM`, `to = alert.email`
- `categories = ['scoutagent', frequency]`
- `custom_args = { alert_id, run_id }`

The returned `X-Message-Id` shall be persisted in `email_sends.sendgrid_message_id`.

#### FR-20 — Empty-result digest

**Description:** When 0 candidates pass FR-14 + FR-17, the system shall still send a brief email titled "No new picks this <frequency>" rather than skipping silently. The body explains that no new on-budget, legitimate options were found and confirms the next check date.

#### FR-21 — Bounce / spam-report handling

**Description:** A SendGrid event webhook (`POST /api/sendgrid/events`) shall, for events of type `bounce` or `spamreport` matching a known `alert_id`, set the alert's `active = false` and `deactivated_reason = '<event_type>'`. Webhook signature verification (HMAC) is required. Webhook handler is best-effort; absence of webhook does not block other functionality.

### 3.7 Observability

#### FR-22 — Structured logs

**Description:** Each run shall emit structured JSON logs at key milestones (`run.start`, `search.done`, `fetch.done`, `reason.done`, `dedupe.done`, `email.sent`, `run.end`) including: `alert_id`, `run_id`, `duration_ms`, `tool_calls_count`, `tokens_input`, `tokens_output`, `cost_cents` where applicable.

#### FR-23 — Persist run record

**Description:** Every run (success, error, or abort) shall produce a row in `runs` with `status ∈ {success, errored, no_results, deactivated}`, `started_at`, `ended_at`, optional `error`, `candidate_count`, `email_send_id`, and token/cost fields.

---

## 4. Non-Functional Requirements

### 4.1 Performance

- **NFR-PERF-1:** Single alert run completes in < 90 seconds at p95, measured from `run.start` to `run.end`.
- **NFR-PERF-2:** Web form submit endpoint responds in < 500 ms at p95 (excluding network).
- **NFR-PERF-3:** A single timer invocation can drain at least 10 due alerts before the function timeout (default 5 min on Consumption plan).

### 4.2 Reliability

- **NFR-REL-1:** Email delivery is at-least-once. Duplicate sends within the same run are prevented by checking `email_sends.run_id` before sending.
- **NFR-REL-2:** Transient failures from SerpAPI, TARS, and SendGrid are retried up to 3 times with exponential backoff (base 500 ms, factor 2, jitter ±25%).
- **NFR-REL-3:** An alert with 3 consecutive `errored` runs is auto-deactivated (see §8).
- **NFR-REL-4:** Database transactions wrap all multi-row state changes (claim → write run → write candidates → write email_send).

### 4.3 Security

- **NFR-SEC-1:** All secrets in environment variables; never committed; never logged.
- **NFR-SEC-2:** TLS required for all outbound HTTP. Reject self-signed certs in production.
- **NFR-SEC-3:** All SQL is parameterized. No dynamic identifier substitution.
- **NFR-SEC-4:** All user-controlled fields are HTML-escaped before email rendering (FR-18).
- **NFR-SEC-5:** PII stored: only `email` and `query` text. No payment data, no addresses.
- **NFR-SEC-6:** SendGrid webhook (FR-21) verifies HMAC signature on every request.
- **NFR-SEC-7:** Form endpoint (`POST /api/alerts`) sets `Content-Type: application/json` requirement; rejects other types with 415.

### 4.4 Maintainability

- **NFR-MAINT-1:** TypeScript strict mode, ESLint with `@typescript-eslint/recommended-type-checked`.
- **NFR-MAINT-2:** Module layout:
  - `src/web/` — form HTML + Express handlers
  - `src/scheduler/` — Azure Functions timer entrypoint + node-cron dev runner
  - `src/agent/` — orchestrator
  - `src/agent/search/` — SerpAPI client
  - `src/agent/fetch/` — Playwright/web fetch
  - `src/agent/llm/` — TARS client + prompt + schema
  - `src/agent/mail/` — SendGrid client + template
  - `src/db/` — pool, queries, migrations
  - `src/lib/` — logger, retry, canonicalize, html-escape
- **NFR-MAINT-3:** Migration files are append-only; numbered (`001_init.sql`, `002_dedupe.sql`, ...).
- **NFR-MAINT-4:** Each external integration module exports a single typed client; no global mutable state.

### 4.5 Scalability

- **NFR-SCALE-1:** Designed for ≤ 1 000 active alerts and ≤ 200 concurrent runs in MVP scope.
- **NFR-SCALE-2:** PostgreSQL connection pool sized to `min(20, function_max_concurrency)`.
- **NFR-SCALE-3:** Horizontal scaling path (post-MVP): partition alert claiming by `hashtext(alert_id::text) % N` shard.

### 4.6 Cost guardrails

- **NFR-COST-1:** Per-run LLM cap: `max_input_tokens = 40000`, `max_output_tokens = 4000`.
- **NFR-COST-2:** Per-alert daily LLM spend cap: `$0.50` (estimated; enforced by halting further runs that day if exceeded).
- **NFR-COST-3:** Per-run SerpAPI call cap: 4 (2 base queries + up to 2 follow-ups).
- **NFR-COST-4:** Per-run page fetch cap: 8 (FR-10).

### 4.7 Compliance

- **NFR-COMP-1:** Every email contains a one-click unsubscribe link that deactivates the originating alert.
- **NFR-COMP-2:** Privacy notice on the web form: "We store your email and query only to send you digests. No other use."
- **NFR-COMP-3:** No purchase, payment, or affiliate tracking is performed.

---

## 5. External Interface Requirements

For each external service: endpoint, auth, request shape, response handling, failure modes, retry policy, rate limits.

### 5.1 SerpAPI

- **Endpoint:** `GET https://serpapi.com/search.json`
- **Auth:** query param `api_key=$SERPAPI_KEY`
- **Required params:** `engine=google`, `q=<built query>`, `num=10`, `hl=en`, `gl=us`
- **Response handling:** parse `organic_results[]` (title, link, snippet) and, when present, `shopping_results[]` (title, link, price, source, rating).
- **Failure modes:**
  - `429 Too Many Requests` → retry with backoff up to 3 times
  - `5xx` → retry up to 3 times
  - Quota exhausted (HTTP 401/403 with `error: "Your account has run out of searches"`) → abort run, log `serpapi_quota_exhausted`, do not retry
- **Timeout:** 8 seconds per call
- **Rate limits:** SerpAPI free plan ~100 searches/month; paid plans up to 5 000+ /month. Worker enforces NFR-COST-3 (4 calls/run max).

### 5.2 Tetrate TARS (OpenAI-compatible LLM gateway)

- **Endpoint:** `POST $TARS_API_URL/v1/chat/completions` (OpenAI Chat Completions shape; the `openai` Node SDK handles the path)
- **SDK:** `openai` Node SDK initialized with `baseURL: $TARS_API_URL`, `apiKey: $TARS_API_KEY` (the SDK sends `Authorization: Bearer …`)
- **Model:** selected via the `model` field on each request (e.g., `claude-sonnet-4-6`); TARS routes by id to the upstream provider
- **Request shape:**

```json
{
  "model": "claude-sonnet-4-6",
  "temperature": 0.2,
  "max_tokens": 4096,
  "tool_choice": "auto",
  "messages": [
    { "role": "system", "content": "<scout-agent system prompt>" },
    { "role": "user",   "content": "<alert query + budget>" }
  ],
  "tools": [
    { "type": "function", "function": { "name": "serpapi_search",     "parameters": { "type":"object","properties":{"query":{"type":"string"},"source":{"type":"string","enum":["web","reddit"]}},"required":["query"] } } },
    { "type": "function", "function": { "name": "fetch_url",          "parameters": { "type":"object","properties":{"url":{"type":"string"}},"required":["url"] } } },
    { "type": "function", "function": { "name": "record_candidates",  "parameters": { /* see FR-12 */ } } }
  ]
}
```

- **Response handling:** Inspect `choices[0].message`. If `tool_calls` is present, append the assistant message verbatim, execute each `tool_calls[i].function` locally, then append one `{ role: "tool", tool_call_id, content: "<JSON result>" }` per call and continue the loop. Terminate the loop when the model calls `record_candidates` (its arguments are the final structured output) or when `finish_reason === "stop"` and a previous `record_candidates` was already accepted. Validate `record_candidates` arguments against the Zod schema (FR-12).
- **Failure modes:**
  - `429` → retry with exponential backoff up to 3 times
  - `5xx` (provider overload via TARS) → retry with longer backoff
  - schema validation failure → one repair attempt by feeding the validation error back as a `tool` message and asking the model to re-call `record_candidates`; second failure aborts the run
  - tool-loop exceeding 12 iterations → abort run (`error = 'tool_loop_overflow'`)
- **Timeout:** 60 s per HTTP call (cumulative loop budget tracked separately; abort at 75 s)
- **Token tracking:** persist `usage.prompt_tokens` and `usage.completion_tokens` to `runs`.

### 5.3 SendGrid

- **Endpoint:** `POST https://api.sendgrid.com/v3/mail/send`
- **Auth:** header `Authorization: Bearer $SENDGRID_API_KEY`
- **Request shape:**

```json
{
  "personalizations": [{ "to": [{ "email": "user@example.com" }] }],
  "from": { "email": "scout@minasdigital.com", "name": "ScoutAgent" },
  "subject": "🔍 Your weekly ScoutAgent report — Electric Bikes Under $500",
  "content": [
    { "type": "text/plain", "value": "<plain-text fallback>" },
    { "type": "text/html",  "value": "<rendered html>" }
  ],
  "categories": ["scoutagent", "weekly"],
  "custom_args": { "alert_id": "...", "run_id": "..." }
}
```

- **Response handling:** Read `X-Message-Id` from response headers; persist to `email_sends`.
- **Failure modes:**
  - `400` invalid email → set `alerts.active = false`, `deactivated_reason = 'email_invalid'`, do not retry
  - `401/403` → abort run, log secret-config error, do not retry
  - `429` → retry up to 3 times
  - `5xx` → retry up to 3 times; on final failure, persist run as `errored` and do **not** advance `last_run_at` (it will retry next tick per FR-06)
- **Webhook (FR-21):** `POST /api/sendgrid/events` — verify HMAC via `X-Twilio-Email-Event-Webhook-Signature`.
- **Timeout:** 10 s.

### 5.4 PostgreSQL

- **Driver:** `pg` (node-postgres) with connection pool
- **Connection:** `DATABASE_URL` with `?sslmode=require` in production
- **Pool size:** `max = 20` (NFR-SCALE-2)
- **Migrations:** raw SQL files in `migrations/` applied in order at startup; idempotent (`CREATE TABLE IF NOT EXISTS`, etc.)
- **Failure handling:**
  - Connection error at startup → exit non-zero, let function host restart
  - Transient query error → no retry (let upstream caller decide)
  - Deadlock (`40P01`) → retry transaction once

### 5.5 Web Frontend (internal interface)

- **Endpoint:** `POST /api/alerts` (Express handler running inside Azure Functions HTTP trigger or local dev server)
- **Request:** `Content-Type: application/json`, body per FR-01
- **Response:** `201 Created` with `{ "id": "<uuid>" }` or `400/415` with `{ "error": "...", "field": "..." }`
- **Static asset:** `GET /` returns `index.html` with the alert form
- **Unsubscribe:** `GET /unsubscribe?token=<signed alert_id>` → sets `active = false`; token signed with HMAC-SHA256 using a server secret; rejects expired/invalid tokens

---

## 6. Agent Behavior Specification

### 6.1 Reasoning loop (pseudocode)

```
function runAgent(alert):
    run = createRun(alert)
    log("run.start", alert.id, run.id)

    sources = []
    sources += serpapiSearch(`${alert.query} under $${alert.budget} review`)
    sources += serpapiSearch(`${alert.query} under $${alert.budget} site:reddit.com`)
    if not diverseEnough(sources): abort(run, 'insufficient_source_diversity')

    pages = fetchTopN(sources, n=8)               // FR-10
    text  = pages.map(extractReadable)             // FR-11

    response = callTARS(systemPrompt, userPrompt(alert, sources, text))
    parsed   = validateSchema(response)            // FR-12; one repair retry on fail

    candidates = applyVerdictRules(parsed.candidates, alert.budget)  // FR-13
    picks      = topN(candidates.recommend, 3)     // FR-14
    flags      = topN(candidates.flag, 1)          // FR-15
    picks      = applyDedupe(picks, alert.id)      // FR-16/17
    if picks.empty AND flags.empty:
        sendEmptyDigest(alert)                     // FR-20
    else:
        sendDigest(alert, picks, flags, parsed.scout_note)

    finalizeRun(run, success)                      // FR-06
```

### 6.2 Tool-use contract

The LLM may invoke these tools (declared in §5.2 request):

| Tool | Input | Output | Purpose |
|---|---|---|---|
| `serpapi_search` | `{ query, num? }` | `{ results: [{title, url, snippet, type}] }` | Discover additional sources mid-loop |
| `fetch_url` | `{ url }` | `{ url, text, truncated }` | Read a page beyond initial 8 |
| `record_candidates` | structured per FR-12 | terminates loop | Final output; **must** be the last tool call |

The orchestrator enforces:
- Max 12 total tool calls per run
- Max 4 `serpapi_search` and 8 `fetch_url` calls combined per run (NFR-COST-3/4)
- `record_candidates` may be called at most once; calling it terminates the loop

### 6.3 Scoring rubric (0–100, weighted)

| Dimension | Weight | What it measures |
|---|---|---|
| Brand legitimacy | 25 | Established brand, real warranty, real customer service, not a drop-shipper |
| Community sentiment | 25 | Reddit / forum consensus is positive; multiple independent verified-user reports |
| Price-to-budget fit | 20 | At or under budget; competitive vs comparable products |
| Safety / red flags | 20 (subtractive) | No fire risks, no missing certifications (UL/CE), no recall history, no scam reports |
| Source diversity | 10 | Evidence drawn from ≥ 2 source types (general, reddit, review-site) |

Total: **100**. Rubric weights MUST be reflected in the system prompt and verified in tests (sum to 100).

### 6.4 Decision rules

Applied by both the LLM (instructed) and the orchestrator (enforced post-parse):

- **`recommend`** ⇔ `score ≥ 70` AND no critical safety flag AND `price_usd ≤ budget × 1.05`
- **`flag`** ⇔ `50 ≤ score < 70` OR (`recommend`-eligible by score but caveats present like limited evidence or `price_usd > budget`)
- **`reject`** ⇔ `score < 50` OR critical safety flag (battery fire, active recall, mass scam reports) OR `price_usd > budget × 1.2`

Critical safety flags (non-exhaustive enum stored in `flags` jsonb): `battery_fire_risk`, `active_recall`, `missing_safety_cert`, `mass_scam_reports`, `counterfeit_listing`.

### 6.5 Determinism guards

- Temperature `0.2` for the main reasoning call (NFR-COST-1 max tokens applied)
- Tool input schemas enforced by the API; orchestrator additionally validates with Zod
- Output schema (FR-12) re-validated server-side; one repair retry permitted; second failure aborts run
- System prompt explicitly forbids speculation when evidence is absent — model must mark such candidates `flag` with reason `insufficient_evidence`

---

## 7. Data Models

PostgreSQL DDL. All tables use `gen_random_uuid()` for primary keys (requires `pgcrypto`).

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE alert_frequency AS ENUM ('daily', 'weekly', 'biweekly');
CREATE TYPE run_status      AS ENUM ('running', 'success', 'errored', 'no_results', 'deactivated');
CREATE TYPE candidate_verdict AS ENUM ('recommend', 'flag', 'reject');

CREATE TABLE alerts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email               text NOT NULL,
    query               text NOT NULL,
    max_budget_cents    integer NOT NULL CHECK (max_budget_cents BETWEEN 100 AND 10000000),
    frequency           alert_frequency NOT NULL,
    active              boolean NOT NULL DEFAULT true,
    deactivated_reason  text,
    error_count         integer NOT NULL DEFAULT 0,
    status              text NOT NULL DEFAULT 'idle',     -- 'idle' | 'running'
    next_run_at         timestamptz NOT NULL,
    last_run_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alerts_email_query_uniq
    ON alerts (lower(email), lower(btrim(query)))
    WHERE active;
CREATE INDEX alerts_due_idx ON alerts (next_run_at) WHERE active;

CREATE TABLE runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id        uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    started_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,
    status          run_status NOT NULL DEFAULT 'running',
    error           text,
    candidate_count integer NOT NULL DEFAULT 0,
    email_send_id   uuid,
    tokens_input    integer,
    tokens_output   integer,
    cost_cents      integer
);
CREATE INDEX runs_alert_idx ON runs (alert_id, started_at DESC);

CREATE TABLE candidates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    title           text NOT NULL,
    url             text NOT NULL,
    canonical_url   text NOT NULL,
    price_cents     integer,
    score           integer NOT NULL CHECK (score BETWEEN 0 AND 100),
    verdict         candidate_verdict NOT NULL,
    reasoning       text NOT NULL,
    flags           jsonb NOT NULL DEFAULT '[]'::jsonb,
    sources         jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX candidates_run_idx ON candidates (run_id);

CREATE TABLE digest_log (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id          uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    dedupe_key        text NOT NULL,
    last_price_cents  integer,
    sent_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (alert_id, dedupe_key)
);
CREATE INDEX digest_log_recent_idx ON digest_log (alert_id, sent_at DESC);

CREATE TABLE email_sends (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id                 uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    run_id                   uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sendgrid_message_id      text,
    status                   text NOT NULL DEFAULT 'queued',  -- queued | sent | failed
    sent_at                  timestamptz,
    error                    text
);
```

### TypeScript types (mirroring DB)

```ts
export type Frequency = 'daily' | 'weekly' | 'biweekly';
export type Verdict   = 'recommend' | 'flag' | 'reject';
export type RunStatus = 'running' | 'success' | 'errored' | 'no_results' | 'deactivated';

export interface Alert {
  id: string;
  email: string;
  query: string;
  maxBudgetCents: number;
  frequency: Frequency;
  active: boolean;
  deactivatedReason: string | null;
  errorCount: number;
  status: 'idle' | 'running';
  nextRunAt: Date;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Run {
  id: string;
  alertId: string;
  startedAt: Date;
  endedAt: Date | null;
  status: RunStatus;
  error: string | null;
  candidateCount: number;
  emailSendId: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costCents: number | null;
}

export interface Candidate {
  id: string;
  runId: string;
  title: string;
  url: string;
  canonicalUrl: string;
  priceCents: number | null;
  score: number;
  verdict: Verdict;
  reasoning: string;
  flags: string[];
  sources: string[];
}

export interface DigestLogEntry {
  id: string;
  alertId: string;
  dedupeKey: string;
  lastPriceCents: number | null;
  sentAt: Date;
}

export interface EmailSend {
  id: string;
  alertId: string;
  runId: string;
  sendgridMessageId: string | null;
  status: 'queued' | 'sent' | 'failed';
  sentAt: Date | null;
  error: string | null;
}
```

---

## 8. Error Handling & Fallback

### 8.1 Failure decision table

| # | Failure Source | Trigger | Behavior | Run outcome | Email sent? |
|---|---|---|---|---|---|
| 1 | SerpAPI 5xx / timeout | network or 5xx | retry 3× exp backoff (500 ms / 1 s / 2 s + jitter); on final fail abort | `errored` | No |
| 2 | SerpAPI quota exhausted | 401/403 with quota message | abort immediately, log `serpapi_quota_exhausted` | `errored` | No |
| 3 | Page fetch timeout / 403 / 4xx | per-page | skip that page; if remaining ≥ 3 candidates continue, else abort | `errored` if abort | conditional |
| 4 | TARS 429 / 529 | rate / overload | retry 3× backoff (1 s / 2 s / 4 s) | success or `errored` | conditional |
| 5 | TARS schema violation | Zod validation fail | one repair attempt with explicit instruction; second fail abort | `errored` | No |
| 6 | TARS tool-loop overflow | > 12 iterations | abort (`tool_loop_overflow`) | `errored` | No |
| 7 | SendGrid 4xx (invalid email) | 400 with email error | deactivate alert (`email_invalid`); persist run | `deactivated` | No |
| 8 | SendGrid 5xx | retryable | retry 3×; on final fail leave `last_run_at` unchanged | `errored` | No |
| 9 | PostgreSQL down | connection refused | crash process; Azure Functions host retries on next tick | (no run record) | No |
| 10 | 0 valid recommended candidates | post-filter | send empty digest (FR-20) | `no_results` | Yes (empty-state) |
| 11 | All candidates rejected | post-filter | same as #10 | `no_results` | Yes (empty-state) |
| 12 | Source diversity insufficient | FR-09 fail | abort | `errored` | No |

### 8.2 Circuit breaker

- After 3 consecutive `errored` runs for the same alert, set `alerts.active = false`, `deactivated_reason = 'consecutive_errors'`, and emit a high-severity log event.
- Counter resets to 0 on any `success` or `no_results` run.

### 8.3 Idempotency

- The `email_sends` table is keyed on `(run_id)` via business logic — before sending, the worker checks whether an `email_sends` row with `status = 'sent'` already exists for the run. If so, it skips re-sending.
- Run claiming (FR-07) ensures no two workers process the same alert concurrently; without this the email idempotency check is the second line of defense.

---

## 9. Out of Scope (MVP)

ScoutAgent v1.0 explicitly does NOT include:

- User accounts, login, password reset, magic-link confirmation
- Real-time price tracking or push notifications outside the configured cadence
- Mobile app, browser extension, WhatsApp / SMS delivery
- Affiliate links, monetization, checkout integration
- Multi-language / i18n support
- Image analysis of product photos
- Aggressive scraping of sites that block crawlers (best-effort robots.txt only)
- Multi-region / multi-currency comparison (USD only)
- Long-term price history or trend visualization
- Admin / operator UI (DB access only for ops)
- Form rate limiting / IP-based abuse protection (open submission for MVP — revisit if abused)
- Per-user dashboard for past digests
- A/B testing of email templates
- Custom prompts or per-user reasoning configuration

These are candidates for post-hackathon work — see `Future Extensions` in [Scoutagentproposal.md](Scoutagentproposal.md).

---

## Appendix A — Requirement Traceability

| Requirement | Section | Tested by |
|---|---|---|
| FR-01..04 | §3.1 | API integration tests |
| FR-05..07 | §3.2 | Scheduler integration test (concurrent claim) |
| FR-08..11 | §3.3 | Search & fetch unit + integration tests |
| FR-12..15 | §3.4 | LLM contract tests (replay fixtures) |
| FR-16..17 | §3.5 | Dedupe unit tests |
| FR-18..21 | §3.6 | Email rendering + SendGrid stub tests |
| FR-22..23 | §3.7 | Log assertion + DB row assertion |
| §6 rules | §6.4 | Verdict rule unit tests |
| §8 table | §8.1 | Failure-injection integration tests |
