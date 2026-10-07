// One tiny live call to verify the API key works. Prints success or failure only.
import Anthropic from '@anthropic-ai/sdk';
import { callModel } from '../api/_lib/llm/call.js';
import { runtime, sessionSpend } from './runtime.js';

async function main(): Promise<void> {
  const { pool, deps, session_id } = runtime();
  try {
    const r = await callModel(
      { model: process.env.MODEL_FAST ?? 'claude-haiku-4-5-20251001', max_tokens: 5, system: [{ type: 'text', text: 'Reply with OK.' }], messages: [{ role: 'user', content: 'ping' }] },
      { stage: 'ping', route: 'script:ping', prompt_version: 'ping', document_sha256: '-', context_hash: '-', document_id: null, run_id: null, session_id, fresh: true, estimated_input_tokens: 30 },
      deps,
    );
    console.log(`API key check: SUCCESS (${r.usage.input_tokens + r.usage.output_tokens} tokens, Rs ${r.cost_inr.toFixed(4)}). Session spend Rs ${(await sessionSpend(pool, session_id)).toFixed(2)}.`);
  } catch (e) {
    const kind = e instanceof Anthropic.AuthenticationError ? 'authentication rejected' : e instanceof Anthropic.APIError ? `API error ${e.status}` : 'not reachable';
    console.log(`API key check: FAILURE (${kind}).`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
