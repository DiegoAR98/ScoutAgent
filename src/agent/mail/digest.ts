// Produces the EmailJS template_params object from the agent's parsed
// Digest. The HTML body itself lives in template.html and is rendered by
// EmailJS using these variables. We do NOT HTML-escape values here:
// EmailJS / Mustache escapes `{{var}}` references automatically.
import type { Digest } from '../llm/schema.js';
import type { TemplateValue } from './emailer.js';

function fmtPrice(price: number | null): string {
  if (price == null) return '—';
  return `$${price.toFixed(2)}`;
}

interface PickParams extends Record<string, TemplateValue> {
  title: string;
  url: string;
  price_display: string;
  score: number;
  reasoning: string;
  flags_text: string;
  has_flags_text: boolean;
}

export interface RenderedDigest {
  subject: string;
  templateParams: Record<string, TemplateValue>;
}

function toPickParams(c: Digest['candidates'][number]): PickParams {
  const flagsText = c.flags.join(', ');
  return {
    title: c.title,
    url: c.url,
    price_display: fmtPrice(c.price_usd),
    score: c.score,
    reasoning: c.reasoning,
    flags_text: flagsText,
    has_flags_text: flagsText.length > 0,
  };
}

export function renderDigest(
  query: string,
  budgetUsd: number,
  digest: Digest,
  requestId: string,
): RenderedDigest {
  const picks = digest.candidates.filter((c) => c.verdict === 'recommend').map(toPickParams);
  const flagged = digest.candidates.filter((c) => c.verdict === 'flag').map(toPickParams);
  const hasPicks = picks.length > 0;
  const hasFlags = flagged.length > 0;
  const noResults = !hasPicks && !hasFlags;
  const scoutNote = digest.scout_note.trim();

  const subject = hasPicks
    ? `ScoutAgent: ${picks.length} pick${picks.length === 1 ? '' : 's'} for "${query}"`
    : `ScoutAgent: no strong picks for "${query}"`;

  const templateParams: Record<string, TemplateValue> = {
    subject,
    query,
    budget: budgetUsd,
    pick_count: picks.length,
    pick_plural: picks.length === 1 ? '' : 's',
    scout_note: scoutNote,
    has_scout_note: scoutNote.length > 0,
    has_picks: hasPicks,
    has_flags: hasFlags,
    no_results: noResults,
    picks,
    flagged,
    request_id: requestId,
  };

  return { subject, templateParams };
}
