// Token pricing and cost estimates in INR. USD to INR for cost accounting is
// fixed at 96 (owner instruction), independent of the editable FX assumption.

export const COST_USD_INR = 96;

type Price = { input: number; output: number; cache_write: number; cache_read: number }; // USD per 1M tokens

const PRICES: Record<string, Price> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
};

// Unknown models are priced at the most expensive known rate so the guard errs safe.
const FALLBACK: Price = { input: 10, output: 50, cache_write: 12.5, cache_read: 1 };

export function priceFor(model: string): Price {
  return PRICES[model] ?? FALLBACK;
}

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export function costInr(model: string, u: TokenUsage): number {
  const p = priceFor(model);
  const usd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_creation_input_tokens * p.cache_write +
      u.cache_read_input_tokens * p.cache_read) /
    1_000_000;
  return usd * COST_USD_INR;
}

/** Worst case for a call: every input token billed as a cache write, output at max_tokens. */
export function worstCaseInr(model: string, inputTokens: number, maxTokens: number): number {
  const p = priceFor(model);
  return ((inputTokens * p.cache_write + maxTokens * p.output) / 1_000_000) * COST_USD_INR;
}

/** Expected cost for a dry run: input at the base rate, a typical output size. */
export function expectedInr(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return ((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * COST_USD_INR;
}
