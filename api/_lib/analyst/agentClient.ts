// The only place the analyst constructs the real Anthropic client. Tests inject a fake
// AgentClient, and constructing the real one under Vitest throws, so no test can reach the API.
import Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '../llm/pricing.js';

export type AgentRequest = {
  model: string;
  max_tokens: number;
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  tool_choice?: Anthropic.ToolChoice;
};

export type AgentResponse = {
  content: Anthropic.ContentBlock[];
  stop_reason: string | null;
  usage: TokenUsage;
};

export interface AgentClient {
  stream(req: AgentRequest, onText: (delta: string) => void): Promise<AgentResponse>;
}

let real: AgentClient | null = null;

export function realAgentClient(): AgentClient {
  if (process.env.VITEST) throw new Error('Refusing to create the real Anthropic client inside a test. Inject a fake AgentClient.');
  if (real) return real;
  const sdk = new Anthropic({ maxRetries: 0, timeout: 120_000 });
  real = {
    async stream(req, onText) {
      const s = sdk.messages.stream({
        model: req.model,
        max_tokens: req.max_tokens,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
        thinking: { type: 'disabled' },
      });
      s.on('text', (d: string) => onText(d));
      const m = await s.finalMessage();
      return {
        content: m.content,
        stop_reason: m.stop_reason,
        usage: {
          input_tokens: m.usage.input_tokens,
          output_tokens: m.usage.output_tokens,
          cache_creation_input_tokens: m.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: m.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
  return real;
}
