// Vertical-slice orchestrator. Hardcoded request end-to-end:
//   serpapi → fetch → TARS tool-use loop → EmailJS send.
// No DB, no scheduler, no web form. Run with:
//   npx tsx src/agent/run.ts --to you@example.com
// Override the request via CLI args:
//   npx tsx src/agent/run.ts --query "electric bike" --budget 800 --to me@example.com
// Or set SCOUT_DRY_RUN=1 to skip the email send.
import { randomUUID } from 'node:crypto';
import { runAgent } from './llm/agent.js';
import { renderDigest } from './mail/digest.js';
import { sendDigestEmail } from './mail/emailer.js';
import { logger } from '../lib/logger.js';

interface Args {
  query: string;
  budgetUsd: number;
  to: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    query: 'electric bike under $1000 reliable for daily commute',
    budgetUsd: 1000,
    to: null,
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
  const requestId = randomUUID();
  const startedAt = Date.now();
  logger.info({ requestId, ...args }, 'run.start');

  if (!args.dryRun && !args.to) {
    throw new Error('Missing --to <email>. Required when not in dry-run mode.');
  }

  const result = await runAgent({ query: args.query, maxBudgetUsd: args.budgetUsd });
  const elapsedMs = Date.now() - startedAt;

  logger.info(
    {
      requestId,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      candidates: result.digest.candidates.length,
      elapsedMs,
    },
    'run.agent.done',
  );

  const rendered = renderDigest(args.query, args.budgetUsd, result.digest, requestId);

  if (args.dryRun) {
    logger.info({ requestId, subject: rendered.subject }, 'run.dry_run.skip_send');
    process.stdout.write('\n=== DIGEST (dry run) ===\n');
    process.stdout.write(`Subject: ${rendered.subject}\n\n`);
    process.stdout.write(JSON.stringify(rendered.templateParams, null, 2));
    process.stdout.write('\n=== END ===\n');
    return;
  }

  const send = await sendDigestEmail({
    to: args.to as string,
    templateParams: rendered.templateParams,
  });

  logger.info({ requestId, statusCode: send.statusCode }, 'run.email.sent');
}

main().catch((err: unknown) => {
  const e = err as Error;
  logger.error({ err: e.message, stack: e.stack }, 'run.fatal');
  process.exitCode = 1;
});
