import { z } from 'zod';

// Presence and shape only. Values are never logged or returned by any route.
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  MODEL_EXTRACT: z.string().min(1).default('claude-sonnet-5-5'),
  MODEL_ANALYST: z.string().min(1).default('claude-sonnet-5-5'),
  MODEL_FAST: z.string().min(1).default('claude-haiku-4-5-20251001'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_URL: z.string().min(1),
  SUPABASE_DB_READONLY_URL: z.string().optional(),
  DAILY_SPEND_CAP_INR: z.coerce.number().positive(),
  PER_IP_HOURLY_CALLS: z.coerce.number().int().positive(),
  DEFAULT_USD_INR: z.coerce.number().positive(),
  DEFAULT_GST_PCT: z.coerce.number().min(0).max(100),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Name the keys, never the values.
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Server configuration is incomplete: ${keys}`);
  }
  cached = parsed.data;
  return cached;
}

export function envStatus(): { complete: boolean; missing: string[] } {
  const parsed = EnvSchema.safeParse(process.env);
  if (parsed.success) return { complete: true, missing: [] };
  return { complete: false, missing: parsed.error.issues.map((i) => i.path.join('.')) };
}
