# ScoutAgent — Autonomous Shopping Research & Alert Agent

## 500-Character Pitch (for the application form)

> ScoutAgent monitors what you're shopping for and emails you only the best options. You set a search ("electric bike under $500"), and the agent runs autonomously — searching the web, fetching review sites and Reddit threads, scoring results for deal quality and legitimacy, filtering out junk, and sending a curated digest to your inbox on a schedule. No chat. No app. Just a smart agent watching the web for you.

*(499 characters)*

---

## Full Proposal

### What is ScoutAgent?

ScoutAgent is an autonomous shopping research agent for people who don't have time to wade through sponsored results, fake reviews, and inflated discounts. The user sets a search query and a budget once via a simple web form, and the agent does the rest — researching, reasoning, filtering, and delivering a curated email digest on a weekly schedule.

No app to install. No chat interface. Just results in your inbox.

---

### The Problem

Online shopping is broken for high-consideration purchases. A search for "electric bike under $500" returns 91 million results — a mix of Amazon drop-shippers, fake discounts, sponsored listings, and safety hazards. The average buyer spends hours cross-referencing Reddit threads, review sites, and price history tools before making a decision. Most give up or make a bad purchase.

This is a research job. Agents are good at research jobs.

---

### How It Works

**Step 1 — User sets an alert (web form)**
```
What are you looking for?  [ electric bike              ]
Max budget                 [ $500                       ]
Your email                 [ you@example.com            ]
How often?                 [ Weekly ▼                   ]
                           [ Start watching →           ]
```

**Step 2 — Agent runs autonomously on schedule**

```
SerpAPI search → top organic results, Reddit threads, review sites
        ↓
Agent fetches full pages for top candidates
(product pages, Reddit safety threads, expert review articles)
        ↓
Agent reasons and scores each result:
  - Is this a legitimate brand or a drop-shipper?
  - Do real users vouch for it on Reddit/forums?
  - Are there safety concerns flagged by the community?
  - Is this the best price available right now?
        ↓
Filters to top 3 picks with reasoning
        ↓
SendGrid delivers a clean, curated email digest
```

**Step 3 — User receives the digest**

```
Subject: 🔍 Your weekly ScoutAgent report — Electric Bikes Under $500

🏆 TOP PICK: Lectric XP Lite — $399
   ⭐ 4.6 stars · 25,000+ verified reviews
   ✅ Established brand, real warranty support
   ✅ Free delivery
   ⚠️  Best for flat terrain

💰 BEST VALUE: Heybike Race Max — $479
   ✅ Strong Reddit community approval
   ✅ 500+ miles reported by commuters
   ⚠️  Check return policy before buying

🚫 AVOID THIS WEEK:
   Generic Amazon listings under $350
   → Reddit flagged battery fire risks, no UL cert

💡 Scout note: Community consensus suggests
   $800+ if you're a daily commuter. Under $500
   is solid for casual/weekend use.

[ View full research → ]  [ Change alert settings → ]
```

---

### Why This Is a Real Agent (Not a Chat Wrapper)

| Criteria | ScoutAgent |
|---|---|
| Takes actions | ✅ Searches web, fetches URLs, sends email |
| Makes decisions | ✅ Scores, filters, flags risks, recommends |
| Runs autonomously | ✅ Scheduled, no user prompting required |
| Coordinates systems | ✅ SerpAPI + web fetcher + Claude + SendGrid |
| Solves a real problem | ✅ Used by the builder, immediately useful |

---

### Tech Stack

| Component | Technology |
|---|---|
| Runtime | TypeScript / Node.js |
| AI reasoning | Claude (tool use + web search) |
| Search | SerpAPI (Google Shopping + organic) |
| Page fetching | Playwright / web_fetch |
| Email delivery | SendGrid |
| Scheduling | Cron / Azure Functions |
| Storage | PostgreSQL (alert config, deduplication) |
| Frontend | Simple HTML form (no framework needed) |

---

### Demo Plan (Live, No Slides)

1. Open the web form live in front of judges
2. Submit: *"electric bike under $500, weekly"*
3. Show the agent running in the terminal — tool calls visible in real time
4. Email arrives within 2–3 minutes with curated picks and reasoning
5. Show the PostgreSQL record — alert stored, next run scheduled

Total demo time: under 5 minutes. No speculation. Everything is real.

---

### The User Is Me

I run Minas Digital LLC, an independent software business. I built this to solve my own problem first — I was spending 2+ hours researching a single purchase decision. ScoutAgent gives that time back.

The broader market is anyone who makes considered purchases online and is tired of doing the research manually. That is most people.

---

### What Makes This Different From Google Alerts or Honey?

- **Google Alerts** — notifies you when a keyword appears. No reasoning, no filtering, no quality judgment.
- **Honey** — tracks price drops on items you already found. Doesn't help you find the right item.
- **ScoutAgent** — actively researches, reads community sentiment, flags safety issues, and tells you *what to buy and what to avoid*, with reasoning. It thinks, not just monitors.

---

### Future Extensions (Post-Hackathon)

- WhatsApp delivery (strong fit for Brazilian market via Minas Digital LLC)
- Price drop triggers (alert immediately when a specific product drops)
- Multi-source comparison (Amazon vs Walmart vs manufacturer direct)
- Category expansion — flights, rental cars, electronics, furniture