// TARS is an OpenAI-compatible gateway. We use the openai SDK and point
// baseURL at TARS_API_URL. Model id selects the upstream provider.
import OpenAI from 'openai';
import { loadEnv } from '../../lib/env.js';

let cached: OpenAI | undefined;

export function getTarsClient(): OpenAI {
  if (cached) return cached;
  const env = loadEnv();
  cached = new OpenAI({
    apiKey: env.TARS_API_KEY,
    baseURL: env.TARS_API_URL,
  });
  return cached;
}

export function getTarsModel(): string {
  return loadEnv().TARS_MODEL;
}
