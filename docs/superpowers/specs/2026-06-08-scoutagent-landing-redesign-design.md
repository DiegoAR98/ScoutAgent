# ScoutAgent landing redesign — design spec

**Date:** 2026-06-08
**Scope:** Visual + structural redesign of the public submission page, `src/web/index.html`.
**Status:** Approved (brainstorming).

## Goal

Turn the current plain single-card form into a professional, polished landing page
that doubles as the Tetrate buildathon demo's first impression — while keeping the
exact same backend contract and zero new dependencies.

## Hard constraints

- **Single self-contained file.** All markup, CSS, and JS stay inline in
  `src/web/index.html`. No new dependencies, no web fonts, no build changes. The
  build step only copies this file into `dist/`, and that must keep working.
- **JS contract unchanged.** The form still does `POST /api/research` with
  `{ query, max_budget_usd, email }`. It must keep handling:
  - `202` → hide form, show success panel with `request_id`.
  - `400` with `{ field, message }` → mark that field's inline error.
  - other / network errors → top error panel.
  - disabled + "Submitting…" button state during the request.
- **No behavior regressions.** Same fields, same validation attributes
  (required, min/max length, number range, email), same accessibility of labels.

## Layout (top → bottom, centered single column)

1. **Top bar** — wordmark `◆ ScoutAgent` left, tagline `one request · one report` right.
2. **Hero** — confident display headline ("Stop drowning in 91 million search
   results.") + one-line subhead about an agent reading the reviews for you. Tight.
3. **Form card** — the visual focal point. Same three fields (query, budget with a
   `$` adornment, email) + the full-width CTA. This is where the eye lands.
4. **How it works** — four compact numbered steps mirroring the real flow:
   ① Search the web + Reddit · ② Read the reviews · ③ Score against a rubric ·
   ④ Email you the digest.
5. **Footer** — existing privacy reassurance ("we use your email and query only to
   send this one digest; nothing is stored") + a quiet
   "Built for the Tetrate AI Agent Buildathon" credit.

Mobile: everything stacks; card stays full-width with comfortable padding.

## Palette (premium refine)

Green stays the brand, but layered and intentional:

- Deep forest green for ink/headings/CTA.
- Existing `#458500` as the live accent (focus ring, links, step numerals).
- Soft green-tinted surface for hero / how-it-works backgrounds.
- Warm off-white page background (not flat `#f5f5f5`); warm-gray body neutrals.
- AA contrast on all green-on-light and white-on-green pairings.

## Type

- System font stack stays (no web-font dependency).
- Tighter, larger display headline with negative tracking; clearly differentiated
  label / body / hint sizes; consistent spacing rhythm.

## Components & states

- **Inputs** — larger targets, rounded corners, refined borders, crisp green
  focus-visible ring. Budget field shows a `$` adornment.
- **CTA** — full-width deep-green button with subtle hover lift; clear disabled /
  "Submitting…" state.
- **Success panel** — confirmation moment: checkmark, "report is on its way,"
  request ID in a styled chip, restart affordance.
- **Errors** — inline field errors + top error panel, same logic, restyled to match.

## Motion (restrained, pure CSS)

- Gentle entrance fade/rise on load; soft CTA hover.
- No libraries. `prefers-reduced-motion: reduce` disables entrance motion.

## Accessibility

- Semantic landmarks (`header`/`main`/`footer`), labels stay associated with inputs,
  visible focus rings, AA contrast, reduced-motion respected.

## Out of scope

- Backend, agent loop, email, and API behavior — untouched.
- New routes or pages. This is the one form page only.
