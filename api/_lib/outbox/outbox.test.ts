// The covering email and the RFx pack PDF. The model is always a fake: no test can reach the API.
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { addLines, addQuestions, emptyRfx, setTerms, type DraftRfx } from '../../../engine/rfx.js';
import type { CallDeps } from '../llm/call.js';
import type { LlmClient, LlmRequest } from '../llm/client.js';
import { memoryStore } from '../llm/store.js';
import { checkEmail, emailSummary, EMAIL_MAX_TOKENS, modelEmail, parseEmailJson, personalise, resolveEmail, templateEmail, type EmailDeps } from './email.js';
import { packBlocks, packFromDraft, renderPack } from './pack.js';

const ORG = 'Greenfield Foods Pvt Ltd';

function rfx(): DraftRfx {
  let r = emptyRfx();
  r = addLines(r, [
    { section: 'Cartons', description: '5 ply carton 450x300x250', spec: 'BF 22', uom: 'piece', annual_qty: 120000 },
    { section: 'Tapes and films', description: 'BOPP tape 48 mm x 100 m', uom: 'roll', annual_qty: 60000 },
    { section: 'Tapes and films', description: 'Mailers', uom: 'boxes', pack_size: 100, annual_qty: 500 },
  ]).rfx;
  r = setTerms(r, { title: 'Corrugated rate contract', scope_summary: 'Annual rate contract for cartons and tapes.', payment_terms_days: 45, validity_days: 90, delivery_location: 'Bengaluru plant', gst_basis: 'excl_gst', quotes_due_day: 14 }).rfx;
  r = addQuestions(r, [{ text: 'Valid ISO 9001 certificate?', answer_type: 'bool', is_knockout: true, pass_rule: { op: 'eq', value: true } }]).rfx;
  return r;
}

function fake(reply: string | ((req: LlmRequest) => string), opts: { fail?: boolean; stop?: string } = {}) {
  const calls: LlmRequest[] = [];
  const client: LlmClient = {
    async complete(req) {
      calls.push(req);
      if (opts.fail) throw new Error('boom');
      return { text: typeof reply === 'string' ? reply : reply(req), stop_reason: opts.stop ?? 'end_turn', usage: { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    },
  };
  return { client, calls };
}
function deps(client: LlmClient, dailyCapInr?: number): EmailDeps & { store: ReturnType<typeof memoryStore> } {
  const store = memoryStore();
  const call: CallDeps = { client, store, ...(dailyCapInr !== undefined ? { dailyCapInr } : {}) };
  return { call, model: 'claude-haiku-4-5-20251001', budgetSession: '00000000-0000-4000-8000-000000000001', route: 'api:rfx-draft', store };
}
const open = async () => ({ ok: true as const });

const GOOD = JSON.stringify({
  subject: 'Request for quotation: Corrugated rate contract',
  body: `Dear {{vendor_name}} team,\n\n${ORG} invites you to quote for an annual rate contract for cartons and tapes. The attached pack lists 3 line items across Cartons and Tapes and films, and a questionnaire of 1 question that must be passed for a quote to be considered.\n\nWe ask for payment terms of 45 days, a quote validity of 90 days, delivery to Bengaluru plant, and prices excluding GST in INR. Please send your quote by day 14 after this email.\n\nYou may reply in any format that suits you, and please answer the questionnaire and attach any certificates.\n\nThank you,\nProcurement\n${ORG}`,
});

describe('the email model call', () => {
  it('sees only a summary of the buyer RFx, sets max_tokens and makes one call', async () => {
    const f = fake(GOOD);
    const d = deps(f.client);
    const out = await modelEmail(rfx(), ORG, d);
    expect(out.source).toBe('model');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.max_tokens).toBe(EMAIL_MAX_TOKENS);
    const sent = JSON.stringify(f.calls[0]?.messages);
    expect(sent).toContain('<rfx_summary>');
    expect(sent).toContain('Corrugated rate contract');
    // A line description is not sent, only counts and section names.
    expect(sent).not.toContain('BOPP tape');
    expect(d.store.usage).toHaveLength(1);
    expect(d.store.usage[0]?.stage).toBe('email');
  });

  it('personalises the one draft for each vendor in code', async () => {
    const out = await modelEmail(rfx(), ORG, deps(fake(GOOD).client));
    const a = personalise(out.draft.body, 'Shree Balaji Corrugators');
    const b = personalise(out.draft.body, 'Kaveri Packaging Industries');
    expect(a.startsWith('Dear Shree Balaji Corrugators team,')).toBe(true);
    expect(b.startsWith('Dear Kaveri Packaging Industries team,')).toBe(true);
    expect(a).not.toContain('{{vendor_name}}');
  });

  it('falls back to the template when the draft invents a figure', async () => {
    const bad = JSON.stringify({ subject: 'RFx', body: GOOD.includes('45') ? (JSON.parse(GOOD) as { body: string }).body.replace('45 days', '60 days') : '' });
    const out = await modelEmail(rfx(), ORG, deps(fake(bad).client));
    expect(out.source).toBe('template');
    expect(out.label).toMatch(/failed a check/);
    expect(out.label).toMatch(/60/);
  });

  it('falls back when the reply is not JSON or was cut off', async () => {
    expect((await modelEmail(rfx(), ORG, deps(fake('Sure, here is an email!').client))).source).toBe('template');
    expect((await modelEmail(rfx(), ORG, deps(fake(GOOD, { stop: 'max_tokens' }).client))).source).toBe('template');
  });
});

describe('resolveEmail: model or template', () => {
  it('template mode never calls the model or the gate', async () => {
    const f = fake(GOOD);
    let gated = 0;
    const out = await resolveEmail(rfx(), ORG, { mode: 'template', admit: async () => (gated++, { ok: true }), deps: deps(f.client) });
    expect(out.source).toBe('template');
    expect(f.calls).toHaveLength(0);
    expect(gated).toBe(0);
  });

  it('uses the template, labelled, when the caps refuse', async () => {
    const f = fake(GOOD);
    const out = await resolveEmail(rfx(), ORG, { mode: 'model', admit: async () => ({ ok: false, message: 'The live demo has reached its spend cap for today.' }), deps: deps(f.client) });
    expect(out.source).toBe('template');
    expect(out.label).toMatch(/paused/);
    expect(f.calls).toHaveLength(0);
  });

  it('uses the template when the daily cap would be passed inside callModel', async () => {
    const f = fake(GOOD);
    const out = await resolveEmail(rfx(), ORG, { mode: 'model', admit: open, deps: deps(f.client, 0) });
    expect(out.source).toBe('template');
    expect(out.fallback).toMatch(/spend cap/);
    expect(f.calls).toHaveLength(0);
  });

  it('uses the template when the model call fails', async () => {
    const out = await resolveEmail(rfx(), ORG, { mode: 'model', admit: open, deps: deps(fake(GOOD, { fail: true }).client) });
    expect(out.source).toBe('template');
    expect(out.fallback).toMatch(/failed/);
  });
});

describe('template and checks', () => {
  it('the template states the RFx terms, passes its own check and has no dashes', () => {
    const t = templateEmail(rfx(), ORG);
    expect(t.body).toContain('{{vendor_name}}');
    expect(t.body).toMatch(/45 days/);
    expect(t.body).toMatch(/90 days/);
    expect(t.body).toMatch(/3 line items across Cartons, Tapes and films/);
    expect(t.body + t.subject).not.toMatch(/[–—]/);
    expect(checkEmail(t, JSON.stringify(emailSummary(rfx(), ORG))).reasons).toEqual([]);
  });

  it('reads naturally for one line and no questionnaire', () => {
    let r = addLines(emptyRfx(), [{ section: 'Cartons', description: 'Carton', uom: 'piece', annual_qty: 10 }]).rfx;
    r = setTerms(r, { payment_terms_days: 45, validity_days: 90 }).rfx;
    const t = templateEmail(r, ORG);
    expect(t.body).toMatch(/lists 1 line item across Cartons\./);
    expect(t.body).not.toMatch(/questionnaire of|0 questions/);
  });

  it('parses a fenced JSON reply and rejects other shapes', () => {
    expect(parseEmailJson('```json\n{"subject":"a","body":"b"}\n```')).toEqual({ subject: 'a', body: 'b' });
    expect(parseEmailJson('{"subject":1}')).toBeNull();
    expect(parseEmailJson('no json')).toBeNull();
  });
});

describe('the RFx pack PDF', () => {
  it('is a real PDF with the RFx content, from a draft', async () => {
    const bytes = await renderPack(packFromDraft(rfx(), ORG), new Date('2026-10-08T05:00:00Z'));
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toMatch(/Corrugated rate contract/);
  });

  it('lists every line, the questionnaire and the terms in its blocks', () => {
    const blocks = JSON.stringify(packBlocks(packFromDraft(rfx(), ORG), '8 October 2026'));
    for (const s of ['CAR-01', 'TAP-01', 'TAP-02', '5 ply carton 450x300x250', 'Valid ISO 9001 certificate?', '45 days', '90 days', 'Bengaluru plant', 'Prices excluding GST', 'Day 14 after issue', 'boxes (100 per box)', 'Must be yes']) {
      expect(blocks).toContain(s);
    }
    expect(blocks).not.toMatch(/[–—]/);
  });
});
