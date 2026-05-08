// SendGrid v3 Mail Send. Returns the X-Message-Id header on success so we
// can correlate with bounce/spam webhooks later (FR-19/FR-21).
import sg from '@sendgrid/mail';
import { loadEnv } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';

let configured = false;

function configure(): void {
  if (configured) return;
  sg.setApiKey(loadEnv().SENDGRID_API_KEY);
  configured = true;
}

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  category?: string;
}

export interface SendResult {
  messageId: string | null;
  statusCode: number;
}

export async function sendDigestEmail(args: SendArgs): Promise<SendResult> {
  configure();
  const env = loadEnv();
  const [response] = await sg.send({
    to: args.to,
    from: { email: env.EMAIL_FROM, name: 'ScoutAgent' },
    subject: args.subject,
    html: args.html,
    text: args.text,
    categories: args.category ? [args.category] : ['scout-digest'],
    trackingSettings: {
      clickTracking: { enable: false, enableText: false },
      openTracking: { enable: false },
    },
  });

  const headers = response?.headers as Record<string, string | string[]> | undefined;
  const raw = headers?.['x-message-id'];
  const messageId = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  logger.info({ to: args.to, statusCode: response?.statusCode, messageId }, 'sendgrid.sent');
  return { messageId, statusCode: response?.statusCode ?? 0 };
}
