// Loads and validates environment variables. Fails fast on startup if any
// required secret is missing, so we never get cryptic errors deep in a run.
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  TARS_API_URL: z.string().url(),
  TARS_API_KEY: z.string().min(1),
  TARS_MODEL: z.string().min(1).default('claude-sonnet-4-6'),

  SERPAPI_KEY: z.string().min(1),

  SENDGRID_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().email(),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('debug'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
