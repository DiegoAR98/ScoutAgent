// Vertical-slice orchestrator. Hardcoded alert end-to-end:
//   serpapi → fetch → TARS tool-use loop → SendGrid send.
// No DB, no scheduler, no web form. Run with:
//   npx tsx src/agent/run.ts
// Override the alert via CLI args:
//   npx tsx src/agent/run.ts --query "electric bike" --budget 800 --to me@example.com
// Or set SCOUT_DRY_RUN=1 to skip the email send.
import { runAgent } from './llm/agent.js';
import { renderDigest } from './mail/digest.js';
import { sendDigestEmail } from './mail/sendgrid.js';
import { loadEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';

interface Args {
  query: string;
  budgetUsd: number;
  to: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const env = loadEnv();
  const out: Args = {
    query: 'electric bike under $1000 reliable for daily commute',
    budgetUsd: 1000,
    to: env.EMAIL_FROM,
    dryRun: process.env['SCOUT_DRY_RUN'] === '1',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--query' && next !== undefined) { out.query = next; i++; }
    else if (a === '--budget' && next !== undefined) { out.budgetUsd = Number(next); i++; }
    else if (a === '--to' && next !== undefined) { out.to = next; i++; }
    else if (a === '--dry-run') { out.dryRun = true; }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  logger.info({ ...args }, 'run.start');

  const result = await runAgent({ query: args.query, maxBudgetUsd: args.budgetUsd });
  const elapsedMs = Date.now() - startedAt;

  logger.info(
    {
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      candidates: result.digest.candidates.length,
      elapsedMs,
    },
    'run.agent.done',
  );

  const rendered = renderDigest(args.query, args.budgetUsd, result.digest);

  if (args.dryRun) {
    logger.info({ subject: rendered.subject }, 'run.dry_run.skip_send');
    process.stdout.write('\n=== DIGEST (dry run) ===\n');
    process.stdout.write(`Subject: ${rendered.subject}\n\n`);
    process.stdout.write(rendered.text);
    process.stdout.write('\n=== END ===\n');
    return;
  }

  const send = await sendDigestEmail({
    to: args.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  logger.info({ messageId: send.messageId, statusCode: send.statusCode }, 'run.email.sent');
}

main().catch((err: unknown) => {
  const e = err as Error;
  logger.error({ err: e.message, stack: e.stack }, 'run.fatal');
  process.exitCode = 1;
});
