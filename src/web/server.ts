// Express server. One endpoint that matters:
//   POST /api/research → validate, return 202, run agent in background, email digest.
// Plus GET / serving the static form, and GET /healthz for Render.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { loadEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { runAgent } from '../agent/llm/agent.js';
import { renderDigest } from '../agent/mail/digest.js';
import { sendDigestEmail } from '../agent/mail/emailer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const requestSchema = z.object({
  query: z.string().trim().min(3).max(200),
  max_budget_usd: z.coerce.number().int().min(1).max(100_000),
  email: z.string().email().max(254),
});

function buildApp(): express.Express {
  loadEnv();

  const app = express();
  app.use(express.json({ limit: '32kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  app.post('/api/research', (req: Request, res: Response) => {
    const ct = req.header('content-type') ?? '';
    if (!ct.includes('application/json')) {
      res.status(415).json({ error: 'unsupported_media_type', expected: 'application/json' });
      return;
    }

    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.') ?? 'unknown';
      const message = parsed.error.issues[0]?.message ?? 'invalid';
      res.status(400).json({ error: 'invalid_request', field, message });
      return;
    }

    const requestId = randomUUID();
    const { query, max_budget_usd, email } = parsed.data;
    const etaSeconds = 120;

    res.status(202).json({ request_id: requestId, eta_seconds: etaSeconds });

    void runInBackground(requestId, query, max_budget_usd, email);
  });

  return app;
}

async function runInBackground(
  requestId: string,
  query: string,
  budgetUsd: number,
  email: string,
): Promise<void> {
  const startedAt = Date.now();
  logger.info({ requestId, query, budgetUsd, to: email }, 'run.start');
  try {
    const result = await runAgent({ query, maxBudgetUsd: budgetUsd });
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

    const rendered = renderDigest(query, budgetUsd, result.digest, requestId);
    const send = await sendDigestEmail({ to: email, templateParams: rendered.templateParams });
    logger.info({ requestId, statusCode: send.statusCode }, 'run.email.sent');
  } catch (err) {
    const e = err as Error;
    logger.error({ requestId, err: e.message, stack: e.stack }, 'run.background.failed');
  }
}

const port = Number.parseInt(process.env['PORT'] ?? '3000', 10);
const app = buildApp();
app.listen(port, () => {
  logger.info({ port }, 'web.listening');
});
