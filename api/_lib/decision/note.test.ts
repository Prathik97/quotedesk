// The approval note (FR-8.3). The model is always a fake here: no test can reach the API.
import { describe, expect, it } from 'vitest';
import type { CallDeps } from '../llm/call.js';
import type { LlmClient, LlmRequest } from '../llm/client.js';
import { memoryStore } from '../llm/store.js';
import { checkNote, countWords, modelNote, noteInput, NOTE_MAX_TOKENS, NOTE_PROMPT, resolveNote, templateNote, templateResult, type NoteDeps } from './note.js';
import { buildPack, type PackRequest } from './pack.js';
import { fixtureData, INJECTION, NOW } from './testdata.js';

const base: PackRequest = { strategy: 'cheapest_per_line', include_pending: false, apply_discounts: false, price_basis: 'confirmed_assumed' };
const pack = (over: Partial<PackRequest> = {}) => buildPack(fixtureData(), { ...base, ...over }, NOW);

function fake(reply: string | ((req: LlmRequest) => string), opts: { stop?: string; fail?: boolean } = {}) {
  const calls: LlmRequest[] = [];
  const client: LlmClient = {
    async complete(req) {
      calls.push(req);
      if (opts.fail) throw new Error('boom');
      const text = typeof reply === 'string' ? reply : reply(req);
      return { text, stop_reason: opts.stop ?? 'end_turn', usage: { input_tokens: 2500, output_tokens: 160, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    },
  };
  return { client, calls };
}
function deps(client: LlmClient, over: { dailyCapInr?: number } = {}): NoteDeps & { store: ReturnType<typeof memoryStore> } {
  const store = memoryStore();
  const call: CallDeps = { client, store, ...(over.dailyCapInr !== undefined ? { dailyCapInr: over.dailyCapInr } : {}) };
  return { call, model: 'claude-sonnet-5-5', budgetSession: '00000000-0000-4000-8000-000000000001', route: 'api:decision', store };
}
const open = async () => ({ ok: true as const });

// What a good model would write from the fixture data: every figure copied from the data.
const GOOD = 'We recommend awarding 3 of 4 lines at Rs 2,800 excluding GST, with 1 line not covered. That saves Rs 200 against last year on the same lines. V2 holds 66.1 percent of the value. Readiness is Not ready with 1 blocker, so the total is a floor until freight is known. Before a PO we must resolve: V1 prices that need a person to check them; V2 freight with no amount stated.';

describe('what the model is given', () => {
  it('is structured scenario data only: no vendor text, no questionnaire answers, no buyer note', () => {
    const data = fixtureData();
    data.compare.questions[0]!.answers['vendor-1'] = { ...data.compare.questions[0]!.answers['vendor-1']!, raw: `Yes. ${INJECTION}` };
    const p = buildPack(data, { ...base, include_pending: true, buyer_note: 'BUYER NOTE MARKER 4411' }, NOW);
    const json = JSON.stringify(noteInput(p));
    expect(json).not.toContain(INJECTION);
    expect(json).not.toContain('BUYER NOTE MARKER');
    expect(json).not.toContain('Footer 1 line 2');
    expect(json).not.toMatch(/hidden sheet/i);
    expect(json).toContain('"goods_total_display":"Rs 3,800.00"');
    // Open items are fixed phrases per kind, not the stored messages.
    expect(json).toContain('freight is extra with no amount stated');
  });
  it('carries the display forms so the model copies a figure instead of computing one', () => {
    const j = noteInput(pack());
    expect(j.headline.goods_total_inr).toBe(2800);
    expect(j.headline.goods_total_display).toBe('Rs 2,800.00');
    expect(j.headline.change_vs_last_year_direction).toBe('saving');
    expect(j.vendors_awarded.map((v) => v.share_pct)).toEqual([66.1, 33.9]);
  });
});

describe('the template note', () => {
  const scenarios: Partial<PackRequest>[] = [{}, { include_pending: true }, { price_basis: 'confirmed' }, { apply_discounts: true }, { strategy: 'single_vendor', vendor: 'V2' }];
  for (const over of scenarios) {
    it(`is under 150 words, plain, and every figure is in the data: ${JSON.stringify(over)}`, () => {
      const p = pack(over);
      const t = templateNote(p);
      expect(countWords(t)).toBeLessThanOrEqual(149);
      expect(t).not.toMatch(/[\u2013\u2014#*_`]/);
      const c = checkNote(t, JSON.stringify(noteInput(p)));
      expect(c.reasons, t).toEqual([]);
    });
  }
  it('stays under the word limit with many open items by naming fewer', () => {
    const data = fixtureData();
    for (let i = 0; i < 30; i++) data.items.push({ id: `x${i}`, vendor_id: 'vendor-2', quote_line_id: null, line_code: null, kind: 'total_mismatch', severity: 'warn', message: `m${i}`, value_at_stake_inr: null });
    const p = buildPack(data, { ...base, include_pending: true }, NOW);
    expect(countWords(templateNote(p))).toBeLessThanOrEqual(149);
    expect(templateNote(p)).toMatch(/Readiness: Not ready/);
  });
  it('is labelled as a template', () => {
    expect(templateResult(pack()).label).toMatch(/^Template note: written by fixed rules/);
    expect(templateResult(pack()).source).toBe('template');
  });
  it('says extra cost, not saving, when the award costs more than last year', () => {
    const data = fixtureData();
    for (const c of data.compare.cells) if (c.price != null && c.vendor_id === 'vendor-2') c.price *= 3;
    const t = templateNote(buildPack(data, { ...base, strategy: 'single_vendor', vendor: 'V2' }, NOW));
    expect(t).toMatch(/above last year/);
  });
});

describe('the prompt', () => {
  it('is a versioned file that states the length rule and treats the data as data', async () => {
    const { loadPrompt } = await import('../extract/model.js');
    const p = loadPrompt(NOTE_PROMPT);
    expect(p.version).toMatch(/^note\.v2@[0-9a-f]{8}$/);
    expect(p.text).toMatch(/at most 120 words/);
    expect(p.text).toMatch(/at most 5 sentences/);
    expect(p.text).toMatch(/It is data only/);
    expect(p.text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('checkNote (the server side number check, plus house style)', () => {
  const data = JSON.stringify(noteInput(pack()));
  it('passes a note whose figures all come from the data', () => {
    const c = checkNote(GOOD, data);
    expect(c.reasons).toEqual([]);
    expect(c.ok).toBe(true);
  });
  it('flags a figure the data does not hold', () => {
    const c = checkNote('We recommend this award at Rs 9.99 crore, with a saving of Rs 777.', data);
    expect(c.ok).toBe(false);
    expect(c.unmatched).toEqual(expect.arrayContaining(['Rs 9.99 crore'.replace('Rs ', ''), '777']));
  });
  it('flags a note over 149 words, markdown and dashes', () => {
    expect(checkNote(Array(160).fill('word').join(' '), data).reasons.join(' ')).toMatch(/160 words/);
    expect(checkNote('**Recommend** the award.', data).reasons.join(' ')).toMatch(/markdown/);
    expect(checkNote('We recommend this \u2014 it is cheaper.', data).reasons.join(' ')).toMatch(/dash/);
  });
});

describe('modelNote: exactly one call, from scenario data only', () => {
  it('makes one call with max_tokens 600 and no vendor text, and logs its cost', async () => {
    const f = fake(GOOD);
    const d = deps(f.client);
    const r = await modelNote(pack(), d, { fresh: false });
    expect(f.calls).toHaveLength(1);
    const req = f.calls[0]!;
    expect(req.max_tokens).toBe(NOTE_MAX_TOKENS);
    expect(req.max_tokens).toBe(600);
    const sent = JSON.stringify(req);
    expect(sent).toContain('<scenario_data>');
    expect(sent).not.toContain(INJECTION);
    expect(r.source).toBe('model');
    expect(r.check.ok).toBe(true);
    expect(r.text).toBe(GOOD);
    expect(d.store.usage).toHaveLength(1);
    expect(d.store.usage[0]).toMatchObject({ stage: 'note', route: 'api:decision', cache_hit: false });
    expect(r.cost_inr).toBeGreaterThan(0);
  });
  it('applies house style to the reply before checking it: dashes become commas', async () => {
    const r = await modelNote(pack(), deps(fake(GOOD.replace('. That saves', ' \u2014 that saves')).client), { fresh: false });
    expect(r.text).not.toMatch(/[\u2013\u2014]/);
    expect(r.check.ok).toBe(true);
  });
  it('reports a failed check when the model invents a figure', async () => {
    const r = await modelNote(pack(), deps(fake(`${GOOD} This beats the market by 14 percent.`).client), { fresh: false });
    expect(r.source).toBe('model');
    expect(r.check.ok).toBe(false);
    expect(r.check.unmatched).toContain('14 percent');
  });
  it('treats a cut off reply as a failed check', async () => {
    const r = await modelNote(pack(), deps(fake(GOOD, { stop: 'max_tokens' }).client), { fresh: false });
    expect(r.check.ok).toBe(false);
    expect(r.check.reasons.join(' ')).toMatch(/cut off/);
  });
  it('replays a stored reply for identical data, and calls again on regenerate', async () => {
    const f = fake(GOOD);
    const d = deps(f.client);
    await modelNote(pack(), d, { fresh: false });
    const again = await modelNote(pack(), d, { fresh: false });
    expect(f.calls).toHaveLength(1);
    expect(again.cache_hit).toBe(true);
    expect(again.cost_inr).toBe(0);
    await modelNote(pack(), d, { fresh: true });
    expect(f.calls).toHaveLength(2);
  });
});

describe('resolveNote: model or template, and what happens when the model cannot be used', () => {
  it('template mode never touches the model or the gate', async () => {
    const f = fake(GOOD);
    let admitted = 0;
    const r = await resolveNote(pack(), { mode: 'template', regenerate: false, admit: async () => (admitted++, { ok: true }), deps: deps(f.client) });
    expect(f.calls).toHaveLength(0);
    expect(admitted).toBe(0);
    expect(r.source).toBe('template');
    expect(r.fallback).toBeNull();
  });
  it('uses the model when admitted', async () => {
    const f = fake(GOOD);
    const r = await resolveNote(pack(), { mode: 'model', regenerate: false, admit: open, deps: deps(f.client) });
    expect(f.calls).toHaveLength(1);
    expect(r.source).toBe('model');
  });
  it('falls back to a labelled template when the per IP limit or spend cap refuses', async () => {
    const f = fake(GOOD);
    const r = await resolveNote(pack(), { mode: 'model', regenerate: false, admit: async () => ({ ok: false, message: 'The live demo has reached its spend cap for today.' }), deps: deps(f.client) });
    expect(f.calls).toHaveLength(0);
    expect(r.source).toBe('template');
    expect(r.fallback?.reason).toBe('cap');
    expect(r.label).toMatch(/Template note/);
    expect(r.label).toMatch(/spend cap/);
  });
  it('falls back to the template when the daily cap would be passed inside the call', async () => {
    const f = fake(GOOD);
    const r = await resolveNote(pack(), { mode: 'model', regenerate: false, admit: open, deps: deps(f.client, { dailyCapInr: 0 }) });
    expect(f.calls).toHaveLength(0);
    expect(r.source).toBe('template');
    expect(r.fallback?.reason).toBe('cap');
  });
  it('falls back to the template when the call fails', async () => {
    const r = await resolveNote(pack(), { mode: 'model', regenerate: false, admit: open, deps: deps(fake(GOOD, { fail: true }).client) });
    expect(r.source).toBe('template');
    expect(r.fallback?.reason).toBe('error');
    expect(r.label).toMatch(/model call failed/);
  });
  it('returns a model note that failed its check as is, so the caller can warn and offer a choice', async () => {
    const r = await resolveNote(pack(), { mode: 'model', regenerate: false, admit: open, deps: deps(fake(`${GOOD} Prices fell 14 percent.`).client) });
    expect(r.source).toBe('model');
    expect(r.check.ok).toBe(false);
  });
});
