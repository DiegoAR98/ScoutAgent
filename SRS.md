# ScoutAgent — Software Requirements Specification

**Version:** 1.1 — buildathon scope
**Date:** 2026-06-08
**Status:** Approved for buildathon implementation (single-shot, no scheduler, no DB)
**Owner:** Diego Araujo / Minas Digital LLC

---

## 1. Introduction

### 1.1 Purpose

This Software Requirements Specification (SRS) defines the functional and non-functional requirements, external interfaces, agent behavior, data models, and error-handling contracts for **ScoutAgent**, an autonomous shopping research agent. It is the canonical reference for implementation, testing, and demo acceptance during the hackathon.

Intended audience: implementing engineer (the builder), reviewers, and judges evaluating completeness against the proposal.

### 1.2 Scope

ScoutAgent ingests a single user request (query + budget + email) via a public web form, runs one research pass that combines web search, page fetching, and LLM-based reasoning, and delivers one curated email digest of legitimate, on-budget product picks. No scheduling, no recurrence, no persistent storage of past requests.

Product vision and pitch are described in [Scoutagentproposal.md](Scoutagentproposal.md). This SRS supersedes the proposal where they conflict on technical detail.

### 1.3 Definitions, Acronyms & Abbreviations

| Term | Definition |
|---|---|
| Request | A single user submission (query + budget + email), identified by a generated request id. Not persisted beyond the lifetime of its run. |
| Run | A single execution of the agent loop for one request. |
| Candidate | A product/URL surfaced by search and scored by the agent. |
| Pick | A candidate whose verdict is `recommend` and which appears in the digest. |
| Digest | The HTML email sent to the user summarizing picks, warnings, and avoids. |
| Verdict | One of `recommend`, `flag`, `reject` assigned to each candidate. |
| TARS | Tetrate Agent Router Service — OpenAI-compatible LLM gateway routing to Claude/GPT/etc. by model id. |
| SerpAPI | Third-party Google search results API used for source discovery. |
| SRS | Software Requirements Specification (this document). |
| FR | Functional Requirement (numbered FR-NN). |
| NFR | Non-Functional Requirement. |

### 1.4 References

- [Scoutagentproposal.md](Scoutagentproposal.md) — product proposal and demo plan
- SerpAPI documentation — https://serpapi.com/search-api
- EmailJS REST API — https://www.emailjs.com/docs/rest-api/send/
- OpenAI Chat Completions API (TARS exposes a compatible shape) — https://platform.openai.com/docs/api-reference/chat
- IEEE 830-1998 — Recommended Practice for Software Requirements Specifications

---

## 2. Overall Description

### 2.1 Product Perspective

ScoutAgent is a self-contained single-shot system: a web form, an in-process agent worker, and three outbound integrations.

```
   user browser ──► Web Form (HTML) ──► POST /api/research ──► Agent Worker
                                                                    │
                                                  ┌─────────────────┼─────────────────┐
                                                  ▼                 ▼                 ▼
                                              SerpAPI         Readability            TARS
                                                                    │
                                                                    ▼
                                                                EmailJS
                                                                    │
                                                                    ▼
                                                          user inbox (HTML email)
```

The form returns `202 Accepted` immediately; the agent worker runs the loop in the background and the email is the final artifact. No real-time interaction; no persistent storage.

### 2.2 Product Functions (high-level)

1. Accept a single research request via a public web form.
2. Search the web, fetch top candidate pages, and reason over the content.
3. Score, filter, and select up to three picks plus optional warnings.
4. Render and send a curated HTML email digest.
5. Emit structured logs covering the run for ops visibility.

### 2.3 User Classes

| Class | Description | Access |
|---|---|---|
| End User | Submits the form, receives one digest. Identified solely by email. No password, no account. | Web form, email inbox. |
| Operator | Builder / on-call developer. Reads logs to diagnose failed runs. | Log dashboard, environment secrets. |

### 2.4 Operating Environment

- Node.js ≥ 20 LTS, TypeScript ≥ 5.4
- TLS-capable outbound network access to SerpAPI, TARS, and EmailJS endpoints
- ESM-compatible toolchain (top-level `await`, `import` syntax)

### 2.5 Design & Implementation Constraints

- TypeScript `strict: true` mode required; no `any` in business logic
- No frontend framework (plain HTML + minimal vanilla JS for form submission)
- All LLM calls **must** route through Tetrate TARS — direct calls to provider APIs (`api.anthropic.com`, `api.openai.com`) are forbidden
- TARS speaks the OpenAI Chat Completions protocol; the official `openai` SDK is used with `baseURL = TARS_API_URL`
- Secrets only via environment variables (`SERPAPI_KEY`, `TARS_API_KEY`, `TARS_API_URL`, `EMAIL_JS_SERVICE_ID`, `EMAIL_JS_TEMPLATE`, `EMAIL_JS_API_KEY`, `EMAIL_JS_PRIVATE_KEY`)
- All outbound HTTP must enforce timeouts; no unbounded waits

### 2.6 Assumptions & Dependencies

- Tetrate TARS exposes an OpenAI Chat Completions-compatible endpoint (`POST /v1/chat/completions`) with function/tool-calling support; model id selects the upstream provider (e.g., `claude-sonnet-4-6`, `claude-haiku-4-5`, `gpt-4o-mini`).
- SerpAPI quota is sufficient for the buildathon demo (≥ 100 searches/month available).
- An EmailJS account is configured with: an email service (`EMAIL_JS_SERVICE_ID`), a published template (`EMAIL_JS_TEMPLATE`) whose Mustache variables match the names emitted by the digest renderer (see [template.html](template.html)), the account's public key (`EMAIL_JS_API_KEY`), and a private access token (`EMAIL_JS_PRIVATE_KEY`) — the private token is required because backend (non-browser) sends are blocked by default.
- The user trusts ScoutAgent with their email address for the duration of one run; no persistence means no at-rest data protection requirement.

---

## 3. Functional Requirements

Each requirement is testable. Acceptance criteria are stated in Given/When/Then form.

### 3.1 Request Submission

#### FR-01 — Submit research request via web form

**Description:** The system shall accept research-request submissions via `POST /api/research` with JSON body `{ query, max_budget_usd, email }`.

**Validation:**
- `query`: trimmed string, length 3–200 chars
- `max_budget_usd`: integer, 1 ≤ x ≤ 100000
- `email`: RFC 5322 valid syntax, length ≤ 254

**Acceptance Criteria:**
- Given a valid request, when the endpoint is called, then it returns `202 Accepted` with `{ "request_id": "<uuid>", "eta_seconds": <integer> }`.
- Given any invalid field, when the endpoint is called, then it returns `400 Bad Request` with a JSON error listing offending field(s).
- Given malformed JSON, when posted, then it returns `400` with `{"error":"invalid_json"}`.

#### FR-02 — Trigger background run

**Description:** On a valid submission, the server shall generate a UUID `request_id`, return `202 Accepted` to the client, and dispatch the agent run as a fire-and-forget background task in the same Node process. No DB write is performed; the request id appears only in logs and in the outbound email's EmailJS `template_params`.

**Acceptance Criteria:**
- Given FR-01 success, then a `run.start` log entry is emitted with the same `request_id` returned to the client.
- Given the HTTP response, then it is sent before the agent loop begins executing (i.e., the client is not blocked on the run).

#### FR-03 — Confirmation page after submit

**Description:** The web form shall display a confirmation message ("You're all set — your report should arrive within 2 minutes.") on success, and a field-level error message on failure. No email confirmation is sent.

**Acceptance Criteria:**
- Given a successful submit, when the response is received, then a confirmation panel replaces the form.
- Given an HTTP 4xx response, then the offending field is highlighted with the server-provided message.

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

### 3.6 Email Delivery

#### FR-18 — Build digest template_params

**Description:** The system shall transform the parsed `Digest` into an EmailJS `template_params` object whose keys match the Mustache variables defined in [template.html](template.html). The rendered subject (also passed as a param) shall follow the form `ScoutAgent: <N> pick(s) for "<query>"` or `ScoutAgent: no strong picks for "<query>"`.

The agent does NOT HTML-escape values — EmailJS / Mustache escapes `{{var}}` references automatically. Variables used inside a section block referencing the same key (e.g., `{{scout_note}}` inside `{{#scout_note}}`) are gated by a separate boolean (e.g., `has_scout_note`) to avoid Mustache's context-switch behavior.

**Acceptance Criteria:**
- Given a request with query `<script>alert(1)</script>`, then the rendered email contains the literal text and no executable script tag (EmailJS escapes `{{query}}` by default).
- Given a digest with `recommend` candidates, then `template_params.has_picks` is `true` and `template_params.picks` is a non-empty array of pick objects.
- Given a digest with no `recommend` candidates and no `flag` candidates, then `template_params.no_results` is `true`.

#### FR-19 — Send via EmailJS

**Description:** The system shall send the digest via the EmailJS REST API (`POST https://api.emailjs.com/api/v1.0/email/send`) with body:

```json
{
  "service_id":   "${EMAIL_JS_SERVICE_ID}",
  "template_id":  "${EMAIL_JS_TEMPLATE}",
  "user_id":      "${EMAIL_JS_API_KEY}",
  "accessToken":  "${EMAIL_JS_PRIVATE_KEY}",
  "template_params": { /* FR-18 output, plus email + to_email = request.email */ }
}
```

The HTTP status code shall be captured and emitted in the `run.email.sent` log line. EmailJS does not return a per-message id; correlation is by `request_id` carried in the template_params.

#### FR-20 — Empty-result digest

**Description:** When 0 candidates pass FR-14, the system shall still send an email using the same template (with `template_params.no_results = true` and `has_picks = false`) rather than skipping silently. The template renders an empty-state block explaining that no on-budget, legitimate options were found and suggesting broader search criteria.

### 3.7 Observability

#### FR-22 — Structured logs

**Description:** Each run shall emit structured JSON logs at key milestones (`run.start`, `search.done`, `fetch.done`, `reason.done`, `email.sent`, `run.end`) including: `request_id`, `duration_ms`, `tool_calls_count`, `tokens_input`, `tokens_output`, `cost_cents` where applicable.

---

## 4. Non-Functional Requirements

### 4.1 Performance

- **NFR-PERF-1:** Single run completes in < 90 seconds at p95, measured from `run.start` to `run.end`.
- **NFR-PERF-2:** Web form submit endpoint responds in < 500 ms at p95 (excluding network) — the response is returned before the agent loop begins (FR-02).

### 4.2 Reliability

- **NFR-REL-1:** Transient failures from SerpAPI, TARS, and EmailJS are retried up to 3 times with exponential backoff (base 500 ms, factor 2, jitter ±25%).
- **NFR-REL-2:** A single run is allowed to complete or fail; no auto-recovery across runs (there are no future runs to defer to).

### 4.3 Security

- **NFR-SEC-1:** All secrets in environment variables; never committed; never logged.
- **NFR-SEC-2:** TLS required for all outbound HTTP. Reject self-signed certs in production.
- **NFR-SEC-3:** All user-controlled fields are HTML-escaped before email rendering (FR-18).
- **NFR-SEC-4:** PII handled: only `email` and `query` text, held in memory for the duration of one run. Not persisted.
- **NFR-SEC-5:** Form endpoint (`POST /api/research`) requires `Content-Type: application/json`; rejects other types with 415.

### 4.4 Maintainability

- **NFR-MAINT-1:** TypeScript strict mode, ESLint with `@typescript-eslint/recommended-type-checked`.
- **NFR-MAINT-2:** Module layout (matches the implemented tree under [src/](src/)):
  - `src/web/` — form HTML + Express handler for `POST /api/research`
  - `src/agent/` — orchestrator entrypoint
  - `src/agent/search/` — SerpAPI client
  - `src/agent/fetch/` — readable-text fetcher
  - `src/agent/llm/` — TARS client + prompt + schema + agent loop
  - `src/agent/mail/` — EmailJS client + digest template_params builder
  - `src/lib/` — env loader, logger, html-escape
- **NFR-MAINT-3:** Each external integration module exports a single typed client; no global mutable state (beyond a cached, lazily-initialized client instance).

### 4.5 Scalability

- **NFR-SCALE-1:** Single-tenant per request; no concurrency target for the buildathon. Multiple concurrent submissions are handled by the Node event loop on a single instance and bounded by SerpAPI / TARS rate limits.

### 4.6 Cost guardrails

- **NFR-COST-1:** Per-run LLM cap: `max_input_tokens = 40000`, `max_output_tokens = 4000`.
- **NFR-COST-2:** Per-run SerpAPI call cap: 4 (2 base queries + up to 2 follow-ups).
- **NFR-COST-3:** Per-run page fetch cap: 8 (FR-10).

### 4.7 Compliance

- **NFR-COMP-1:** Privacy notice on the web form: "We use your email and query only to send you this one digest. Nothing is stored."
- **NFR-COMP-2:** No purchase, payment, or affiliate tracking is performed.

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

### 5.3 EmailJS

- **Endpoint:** `POST https://api.emailjs.com/api/v1.0/email/send`
- **Auth:** body-level credentials (`user_id` + `accessToken`); no `Authorization` header. EmailJS rejects backend (non-browser) sends unless `accessToken` (the private key, `EMAIL_JS_PRIVATE_KEY`) is supplied.
- **Template management:** the HTML body lives in [template.html](template.html) on disk (source of truth) and must be kept in sync with the published template in the EmailJS dashboard identified by `EMAIL_JS_TEMPLATE`. The dashboard template's "To Email" field should reference `{{email}}` (or `{{to_email}}`); the sender passes both.
- **Request shape:**

```json
{
  "service_id":   "${EMAIL_JS_SERVICE_ID}",
  "template_id":  "${EMAIL_JS_TEMPLATE}",
  "user_id":      "${EMAIL_JS_API_KEY}",
  "accessToken":  "${EMAIL_JS_PRIVATE_KEY}",
  "template_params": {
    "subject":         "ScoutAgent: 2 picks for \"electric bike under $500\"",
    "query":           "electric bike under $500",
    "budget":          500,
    "scout_note":      "Community consensus suggests $800+ for daily commuters...",
    "has_scout_note":  true,
    "has_picks":       true,
    "picks":           [ { "title": "...", "url": "...", "price_display": "$399", "score": 82, "reasoning": "...", "flags_text": "", "has_flags_text": false } ],
    "has_flags":       false,
    "flagged":         [],
    "no_results":      false,
    "pick_count":      2,
    "pick_plural":     "s",
    "request_id":      "...",
    "email":           "user@example.com",
    "to_email":        "user@example.com"
  }
}
```

- **Response handling:** EmailJS returns `200 OK` with body `OK` on success. Log the HTTP status and `request_id` in `run.email.sent`. EmailJS does not return a per-message id; the `request_id` is the only correlation key.
- **Failure modes:**
  - `400` invalid template params → log `email_invalid` with the response body against the request id; do not retry; run ends `errored`
  - `401/403` (`API calls are disabled for non-browser applications`, expired key, or wrong service/template id) → abort run, log secret-config error, do not retry
  - `429` → retry up to 3 times with exponential backoff
  - `5xx` → retry up to 3 times; on final failure log `email_send_failed` and end the run `errored`
- **Timeout:** 10 s per attempt.

### 5.4 Web Frontend (internal interface)

- **Endpoint:** `POST /api/research` (Express handler on a Node 20 server)
- **Request:** `Content-Type: application/json`, body per FR-01
- **Response:** `202 Accepted` with `{ "request_id": "<uuid>", "eta_seconds": <integer> }` or `400/415` with `{ "error": "...", "field": "..." }`
- **Static asset:** `GET /` returns `index.html` with the request form

---

## 6. Agent Behavior Specification

### 6.1 Reasoning loop (pseudocode)

```
function runAgent(request):
    log("run.start", request.id)

    sources = []
    sources += serpapiSearch(`${request.query} under $${request.budget} review`)
    sources += serpapiSearch(`${request.query} under $${request.budget} site:reddit.com`)
    if not diverseEnough(sources): abort(request, 'insufficient_source_diversity')

    pages = fetchTopN(sources, n=8)               // FR-10
    text  = pages.map(extractReadable)             // FR-11

    response = callTARS(systemPrompt, userPrompt(request, sources, text))
    parsed   = validateSchema(response)            // FR-12; one repair retry on fail

    candidates = applyVerdictRules(parsed.candidates, request.budget)  // FR-13
    picks      = topN(candidates.recommend, 3)     // FR-14
    flags      = topN(candidates.flag, 1)          // FR-15
    if picks.empty AND flags.empty:
        sendEmptyDigest(request)                   // FR-20
    else:
        sendDigest(request, picks, flags, parsed.scout_note)

    log("run.end", request.id, success)
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

Critical safety flags (non-exhaustive list emitted in the `flags` field of each candidate): `battery_fire_risk`, `active_recall`, `missing_safety_cert`, `mass_scam_reports`, `counterfeit_listing`.

### 6.5 Determinism guards

- Temperature `0.2` for the main reasoning call (NFR-COST-1 max tokens applied)
- Tool input schemas enforced by the API; orchestrator additionally validates with Zod
- Output schema (FR-12) re-validated server-side; one repair retry permitted; second failure aborts run
- System prompt explicitly forbids speculation when evidence is absent — model must mark such candidates `flag` with reason `insufficient_evidence`

---

## 7. Data Models (in-memory only)

No database. The agent operates on in-memory values for the duration of a single run; everything is discarded after the email is sent. The TypeScript types below describe the shapes that flow through the agent loop, the LLM tool contract, and the digest renderer.

```ts
export type Verdict = 'recommend' | 'flag' | 'reject';
export type RunStatus = 'success' | 'errored' | 'success_empty';

export interface ResearchRequest {
  id: string;            // uuid generated at POST /api/research time
  email: string;
  query: string;
  maxBudgetUsd: number;
  receivedAt: Date;
}

export interface Candidate {
  title: string;
  url: string;
  canonicalUrl: string;  // FR-13 helper; tracking-stripped form of url
  priceUsd: number | null;
  score: number;         // 0..100 integer
  verdict: Verdict;
  reasoning: string;     // <= 500 chars
  flags: string[];       // e.g. ["battery_fire_risk"]
  sources: string[];     // URLs cited
}

export interface RunResult {
  requestId: string;
  status: RunStatus;
  error: string | null;
  candidates: Candidate[];
  scoutNote: string;
  emailMessageId: string | null;
  tokensInput: number;
  tokensOutput: number;
  durationMs: number;
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
| 4 | TARS 429 / 529 | rate / overload | retry 3× backoff (1 s / 2 s / 4 s) | `success` or `errored` | conditional |
| 5 | TARS schema violation | Zod validation fail | one repair attempt with explicit instruction; second fail abort | `errored` | No |
| 6 | TARS tool-loop overflow | > 12 iterations | abort (`tool_loop_overflow`) | `errored` | No |
| 7 | EmailJS 4xx (invalid params / disabled API) | 400 / 401 / 403 | log `email_invalid` against request id; no retry | `errored` | No |
| 8 | EmailJS 5xx | retryable | retry 3×; on final fail log `email_send_failed`; process exits non-zero so logs surface clearly | `errored` | No |
| 9 | 0 valid recommended candidates | post-filter | send empty digest (FR-20) | `success_empty` | Yes (empty-state) |
| 10 | All candidates rejected | post-filter | same as #9 | `success_empty` | Yes (empty-state) |
| 11 | Source diversity insufficient | FR-09 fail | abort | `errored` | No |

---

## 9. Out of Scope (buildathon)

ScoutAgent v1.1 (buildathon) explicitly does NOT include:

- Recurring schedules of any kind (daily, weekly, biweekly, or custom cadence)
- Persistent storage of past requests, runs, candidates, or sent emails (no PostgreSQL, no SQLite, no flat-file store)
- Deduplication of repeated requests across time
- User accounts, login, password reset, magic-link confirmation, unsubscribe flows
- Alert lifecycle / management UI (no concept of a saved alert)
- Bounce / spam-report event webhook handling (EmailJS does not expose per-message bounce events)
- Real-time price tracking or push notifications
- Mobile app, browser extension, WhatsApp / SMS delivery
- Affiliate links, monetization, checkout integration
- Multi-language / i18n support
- Image analysis of product photos
- Aggressive scraping of sites that block crawlers (best-effort robots.txt only)
- Multi-region / multi-currency comparison (USD only)
- Long-term price history or trend visualization
- Form rate limiting / IP-based abuse protection (open submission — revisit post-buildathon)
- A/B testing of email templates
- Custom prompts or per-user reasoning configuration

These are candidates for post-buildathon work — see `Future Extensions` in [Scoutagentproposal.md](Scoutagentproposal.md).

---

## Appendix A — Requirement Traceability

| Requirement | Section | Tested by |
|---|---|---|
| FR-01..03 | §3.1 | API integration test (one end-to-end run from `POST /api/research` to a captured outbound EmailJS call) |
| FR-08..11 | §3.3 | Search & fetch unit + integration tests |
| FR-12..15 | §3.4 | LLM contract tests (replay fixtures) |
| FR-18..20 | §3.6 | template_params builder unit tests + EmailJS stub tests |
| FR-22 | §3.7 | Log assertion |
| §6 rules | §6.4 | Verdict rule unit tests |
| §8 table | §8.1 | Failure-injection integration tests |

**Note on FR numbering:** FR-04, FR-05, FR-06, FR-07, FR-16, FR-17, FR-21, and FR-23 are intentionally absent — they covered alert lifecycle, scheduling, deduplication, webhook handling, and persistent run records, all of which are out of buildathon scope (§9). Numbering is left gapped rather than renumbered to keep cross-references in commit history readable.
