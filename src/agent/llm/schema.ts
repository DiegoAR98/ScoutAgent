// Zod schema for the final structured output the LLM emits via the
// record_candidates tool. Matches the JSON contract in SRS §6.2 / FR-12.
import { z } from 'zod';

export const verdict = z.enum(['recommend', 'flag', 'reject']);
export type Verdict = z.infer<typeof verdict>;

export const candidateSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  price_usd: z.number().nonnegative().nullable(),
  score: z.number().min(0).max(100),
  verdict,
  reasoning: z.string().min(1),
  flags: z.array(z.string()).default([]),
  sources_considered: z.array(z.string().url()).default([]),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const digestSchema = z.object({
  candidates: z.array(candidateSchema).min(0),
  scout_note: z.string().min(1),
});
export type Digest = z.infer<typeof digestSchema>;
