// Renders the digest into HTML + plaintext. Kept self-contained — no
// templating engine for the vertical slice. All user-controlled fields
// are HTML-escaped (NFR-SEC-3).
import type { Digest } from '../llm/schema.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtPrice(price: number | null): string {
  if (price == null) return '—';
  return `$${price.toFixed(2)}`;
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

export function renderDigest(query: string, budgetUsd: number, digest: Digest): RenderedDigest {
  const recommends = digest.candidates.filter((c) => c.verdict === 'recommend');
  const flags = digest.candidates.filter((c) => c.verdict === 'flag');

  const subject = recommends.length === 0
    ? `ScoutAgent: no strong picks for "${query}" this run`
    : `ScoutAgent: ${recommends.length} pick${recommends.length === 1 ? '' : 's'} for "${query}"`;

  const text = renderText(query, budgetUsd, digest, recommends, flags);
  const html = renderHtml(query, budgetUsd, digest, recommends, flags);

  return { subject, html, text };
}

function renderText(query: string, budgetUsd: number, digest: Digest, recommends: Digest['candidates'], flags: Digest['candidates']): string {
  const lines: string[] = [];
  lines.push(`ScoutAgent digest`);
  lines.push(`Query: ${query}`);
  lines.push(`Budget: $${budgetUsd}`);
  lines.push('');
  lines.push(digest.scout_note);
  lines.push('');

  if (recommends.length === 0) {
    lines.push('No strong picks this run.');
  } else {
    lines.push('— TOP PICKS —');
    for (const c of recommends) {
      lines.push('');
      lines.push(`${c.title}  (score ${c.score})`);
      lines.push(`  Price: ${fmtPrice(c.price_usd)}`);
      lines.push(`  ${c.reasoning}`);
      lines.push(`  ${c.url}`);
      if (c.flags.length > 0) lines.push(`  Notes: ${c.flags.join(', ')}`);
    }
  }

  if (flags.length > 0) {
    lines.push('');
    lines.push('— WORTH KNOWING —');
    for (const c of flags) {
      lines.push('');
      lines.push(`${c.title}  (score ${c.score})`);
      lines.push(`  ${c.reasoning}`);
      if (c.flags.length > 0) lines.push(`  Caveats: ${c.flags.join(', ')}`);
      lines.push(`  ${c.url}`);
    }
  }

  return lines.join('\n');
}

function renderHtml(query: string, budgetUsd: number, digest: Digest, recommends: Digest['candidates'], flags: Digest['candidates']): string {
  const card = (c: Digest['candidates'][number], badge: string, color: string): string => `
    <div style="border:1px solid #e5e7eb;border-left:4px solid ${color};padding:14px 16px;margin:12px 0;border-radius:6px;background:#fff;">
      <div style="font-size:12px;color:${color};font-weight:600;letter-spacing:0.05em;text-transform:uppercase;">${badge} · score ${c.score}</div>
      <div style="font-size:16px;font-weight:600;margin:4px 0 6px;"><a href="${escapeHtml(c.url)}" style="color:#111;text-decoration:none;">${escapeHtml(c.title)}</a></div>
      <div style="font-size:14px;color:#374151;margin-bottom:6px;">${escapeHtml(c.reasoning)}</div>
      <div style="font-size:13px;color:#6b7280;">Price: <strong>${escapeHtml(fmtPrice(c.price_usd))}</strong>${c.flags.length ? ` · ${c.flags.map(escapeHtml).join(' · ')}` : ''}</div>
    </div>`;

  const recsHtml = recommends.length === 0
    ? '<p style="color:#6b7280;">No strong picks this run — Scout will keep watching.</p>'
    : recommends.map((c) => card(c, 'Top pick', '#16a34a')).join('');

  const flagsHtml = flags.length === 0
    ? ''
    : `<h3 style="font-size:14px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin:24px 0 8px;">Worth knowing</h3>` +
      flags.map((c) => card(c, 'Caveat', '#d97706')).join('');

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f9fafb;margin:0;padding:24px;color:#111;">
  <div style="max-width:600px;margin:0 auto;">
    <h1 style="font-size:20px;margin:0 0 4px;">ScoutAgent digest</h1>
    <div style="font-size:13px;color:#6b7280;margin-bottom:16px;">Query: <strong>${escapeHtml(query)}</strong> · Budget: <strong>$${budgetUsd}</strong></div>
    <p style="font-size:14px;color:#374151;margin:0 0 16px;">${escapeHtml(digest.scout_note)}</p>
    ${recsHtml}
    ${flagsHtml}
    <p style="font-size:11px;color:#9ca3af;margin-top:24px;">You're receiving this because you signed up for a ScoutAgent alert. Reply to unsubscribe.</p>
  </div>
</body></html>`;
}
