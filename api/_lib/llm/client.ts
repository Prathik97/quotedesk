// The only place that constructs the real Anthropic client. Tests inject a fake
// LlmClient; constructing the real one under Vitest throws, so a unit test can
// never reach the API even by mistake.
import Anthropic from '@anthropic-ai/sdk';

export type LlmRequest = {
  model: string;
  max_tokens: number;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  thinking_off?: boolean;
};

export type LlmResponse = {
  text: string;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
};

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

let real: LlmClient | null = null;

export function realClient(): LlmClient {
  if (process.env.VITEST) {
    throw new Error('Refusing to create the real Anthropic client inside a test. Inject a fake LlmClient.');
  }
  if (real) return real;
  // maxRetries 0: the SDK must not retry on its own. One repair retry is the only retry we allow.
  const sdk = new Anthropic({ maxRetries: 0, timeout: 180_000 });
  real = {
    async complete(req) {
      const res = await sdk.messages.create({
        model: req.model,
        max_tokens: req.max_tokens,
        system: req.system,
        messages: req.messages,
        ...(req.thinking_off ? { thinking: { type: 'between_tools' as const } } : {}),
      });
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return {
        text,
        stop_reason: res.stop_reason,
        usage: {
          input_tokens: res.usage.input_tokens,
          output_tokens: res.usage.output_tokens,
          cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
  return real;
}
