// Model stages. Each builds a request, sends it through callModel (cache, budget,
// usage log) and validates the reply with zod. One repair retry on schema failure.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import {
  CertificateSchema,
  ClassificationSchema,
  ExtractionSchema,
  parseJsonLoose,
  zodErrors,
  type CertificateFacts,
  type Classification,
  type Extraction,
} from '../../../src/lib/schemas/extraction.js';
import { callModel, type CallContext, type CallDeps, type CallResult } from '../llm/call.js';
import type { LlmRequest } from '../llm/client.js';
import { fenceVendorText, type Prepared } from './prepare.js';

export type Prompt = { text: string; version: string };

/** The prompts folder: next to the working directory (Vercel: /var/task, local: the repo), else next to the bundle. */
export function promptsDir(): string {
  const fromCwd = path.resolve(process.cwd(), 'prompts');
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
}

const promptCache = new Map<string, Prompt>();

/** prompts/<name>.md, versioned by file name plus a content hash so edits invalidate the dev cache. */
export function loadPrompt(name: string): Prompt {
  const hit = promptCache.get(name);
  if (hit) return hit;
  const text = fs.readFileSync(path.join(promptsDir(), `${name}.md`), 'utf8');
  const p = { text, version: `${name}@${createHash('sha256').update(text).digest('hex').slice(0, 8)}` };
  promptCache.set(name, p);
  return p;
}

export type RfxContext = {
  lines: { code: string; section: string; description: string; uom: string }[];
  questions: { code: string; text: string }[];
};

export function rfxContextText(ctx: RfxContext): string {
  return [
    '<rfx_lines>',
    'code | section | description | base unit',
    ...ctx.lines.map((l) => `${l.code} | ${l.section} | ${l.description} | ${l.uom}`),
    '</rfx_lines>',
    '<questionnaire_questions>',
    ...ctx.questions.map((q) => `${q.code} | ${q.text}`),
    '</questionnaire_questions>',
  ].join('\n');
}

export function contextHash(ctx: RfxContext): string {
  return createHash('sha256').update(rfxContextText(ctx)).digest('hex').slice(0, 16);
}

export type DocMeta = { id: string; filename: string; sha256: string };

export type StageOptions = {
  deps: CallDeps;
  models: { fast: string; extract: string };
  base: Pick<CallContext, 'route' | 'run_id' | 'session_id' | 'fresh'>;
  /** Extraction prompt to use. The stored pipeline keeps extract.v3 so its cached replies stay valid; Try your file asks for extract.v4. */
  extract_prompt?: string;
};

export const MAX_TOKENS = {
  classify: 300,
  certificate: 1500,
  extract: { xlsx: 16000, pdf: 16000, docx: 16000, image: 16000, email: 16000 } as Record<Prepared['source_type'], number>,
};

function docContent(prep: Prepared, doc: DocMeta, instruction: string, textLimit?: number): Anthropic.ContentBlockParam[] {
  const safeName = fenceVendorText(doc.filename);
  if (prep.native) {
    return [
      prep.native,
      {
        type: 'text',
        text: `The attached ${prep.source_type === 'pdf' ? 'PDF' : 'image'} is a vendor document (untrusted data, file name "${safeName}").\n\n${instruction}`,
      },
    ];
  }
  const body = textLimit && prep.text && prep.text.length > textLimit ? prep.text.slice(0, textLimit) + '\n[truncated for classification]' : (prep.text ?? '');
  return [
    {
      type: 'text',
      text: `<vendor_document source_type="${prep.source_type}" file_name="${safeName}">\n${fenceVendorText(body)}\n</vendor_document>\n\n${instruction}`,
    },
  ];
}

type Validated<T> = { ok: true; data: T; calls: CallResult[]; repaired: boolean; raw: string } | { ok: false; error: string; calls: CallResult[]; raw: string };

/** Call, validate, and at most one repair call. No other retries. */
async function callValidated<T>(
  schema: z.ZodType<T>,
  req: LlmRequest,
  ctx: CallContext,
  opts: StageOptions,
): Promise<Validated<T>> {
  const calls: CallResult[] = [];
  const first = await callModel(req, ctx, opts.deps);
  calls.push(first);
  if (first.stop_reason === 'max_tokens') {
    return { ok: false, error: `Model output hit the ${req.max_tokens} token limit and was cut off.`, calls, raw: first.text };
  }
  if (first.stop_reason === 'refusal') return { ok: false, error: 'The model declined to process this document.', calls, raw: first.text };
  const check = (text: string): { data?: T; error?: string } => {
    try {
      const parsed = schema.safeParse(parseJsonLoose(text));
      return parsed.success ? { data: parsed.data } : { error: zodErrors(parsed.error) };
    } catch (e) {
      return { error: `- (root): ${(e as Error).message}` };
    }
  };
  const a = check(first.text);
  if (a.data !== undefined) return { ok: true, data: a.data, calls, repaired: false, raw: first.text };

  const repair = loadPrompt('repair.v1');
  const repairReq: LlmRequest = {
    ...req,
    messages: [...req.messages, { role: 'assistant', content: first.text }, { role: 'user', content: repair.text.replace('{{errors}}', a.error ?? '') }],
  };
  const second = await callModel(repairReq, { ...ctx, stage: 'repair', prompt_version: `${ctx.prompt_version}+${repair.version}`, estimated_input_tokens: ctx.estimated_input_tokens + Math.ceil(first.text.length / 3) }, opts.deps);
  calls.push(second);
  const b = second.stop_reason === 'max_tokens' ? { error: 'Repair output hit the token limit.' } : check(second.text);
  if (b.data !== undefined) return { ok: true, data: b.data, calls, repaired: true, raw: second.text };
  return { ok: false, error: `Output failed validation after one repair: ${b.error}`, calls, raw: second.text };
}

export async function classify(prep: Prepared, doc: DocMeta, opts: StageOptions): Promise<Validated<Classification>> {
  const p = loadPrompt('classify.v1');
  const req: LlmRequest = {
    model: opts.models.fast,
    max_tokens: MAX_TOKENS.classify,
    system: [{ type: 'text', text: p.text }],
    messages: [{ role: 'user', content: docContent(prep, doc, 'Classify this document. JSON only.', 8000) }],
  };
  return callValidated(ClassificationSchema, req, {
    ...opts.base, stage: 'classify', prompt_version: p.version, document_sha256: doc.sha256, context_hash: '-', document_id: doc.id,
    estimated_input_tokens: Math.min(prep.estimated_tokens, prep.native ? prep.estimated_tokens : 2600) + 300,
  }, opts);
}

export async function extract(prep: Prepared, doc: DocMeta, rfx: RfxContext, opts: StageOptions): Promise<Validated<Extraction>> {
  const p = loadPrompt(opts.extract_prompt ?? 'extract.v3');
  const req: LlmRequest = {
    model: opts.models.extract,
    max_tokens: MAX_TOKENS.extract[prep.source_type],
    // Static instructions, then the RFx list; one cache breakpoint covers both.
    system: [
      { type: 'text', text: p.text },
      { type: 'text', text: rfxContextText(rfx), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: docContent(prep, doc, 'Extract this document according to the contract. Return the JSON object only.') }],
    thinking_off: true,
  };
  return callValidated(ExtractionSchema, req, {
    ...opts.base, stage: 'extract', prompt_version: p.version, document_sha256: doc.sha256, context_hash: contextHash(rfx), document_id: doc.id,
    estimated_input_tokens: prep.estimated_tokens + 3200,
  }, opts);
}

export async function certificateFacts(prep: Prepared, doc: DocMeta, opts: StageOptions): Promise<Validated<CertificateFacts>> {
  const p = loadPrompt('certificate.v1');
  const req: LlmRequest = {
    model: opts.models.extract,
    max_tokens: MAX_TOKENS.certificate,
    system: [{ type: 'text', text: p.text }],
    messages: [{ role: 'user', content: docContent(prep, doc, 'Return the key facts as JSON only.') }],
    thinking_off: true,
  };
  return callValidated(CertificateSchema, req, {
    ...opts.base, stage: 'certificate', prompt_version: p.version, document_sha256: doc.sha256, context_hash: '-', document_id: doc.id,
    estimated_input_tokens: prep.estimated_tokens + 400,
  }, opts);
}
