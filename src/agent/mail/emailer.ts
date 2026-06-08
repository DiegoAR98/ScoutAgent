// EmailJS REST sender. Posts the digest's template_params to the EmailJS
// template configured in the dashboard. Backend sends require the
// EMAIL_JS_PRIVATE_KEY access token; without it EmailJS rejects non-browser
// calls. The recipient email is passed as `email` / `to_email` template
// params so the dashboard template's "To Email" field can resolve to either.
import { loadEnv } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';
const REQUEST_TIMEOUT_MS = 10_000;

export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | TemplateValue[]
  | { [k: string]: TemplateValue };

export interface SendArgs {
  to: string;
  templateParams: Record<string, TemplateValue>;
}

export interface SendResult {
  statusCode: number;
}

export async function sendDigestEmail(args: SendArgs): Promise<SendResult> {
  const env = loadEnv();

  const body: Record<string, unknown> = {
    service_id: env.EMAIL_JS_SERVICE_ID,
    template_id: env.EMAIL_JS_TEMPLATE,
    user_id: env.EMAIL_JS_API_KEY,
    template_params: { ...args.templateParams, email: args.to, to_email: args.to },
  };
  if (env.EMAIL_JS_PRIVATE_KEY) {
    body['accessToken'] = env.EMAIL_JS_PRIVATE_KEY;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(EMAILJS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`EmailJS send timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    logger.error({ statusCode: response.status, body: text }, 'emailjs.failed');
    throw new Error(`EmailJS send failed (${response.status}): ${text}`);
  }
  logger.info({ statusCode: response.status, to: args.to }, 'emailjs.sent');
  return { statusCode: response.status };
}
