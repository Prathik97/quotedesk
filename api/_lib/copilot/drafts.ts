// Draft storage. A draft is one row in rfx_drafts, owned by an anonymous random browser id.
// Nothing here reads or writes the seeded rfx, rfx_lines, vendors or any extraction table.
import type pg from 'pg';
import { z } from 'zod';
import { emptyRfx, MAX_LINES, MAX_QUESTIONS, validateRfx, type DraftRfx, type Validation } from '../../../engine/rfx.js';

/** A random id the browser makes for itself. Anything else is refused. */
export const BrowserId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Reload the page: this browser has no valid session id.');

export const MAX_DRAFTS_PER_BROWSER = 5;
export const MAX_DRAFTS_TOTAL = 400;
const MAX_STATE_BYTES = 80_000;
const MAX_MESSAGES = 40;

const text = (max: number) => z.string().max(max);
const days = z.number().int().min(0).max(730).nullable();

const PassRule = z.discriminatedUnion('op', [
  z.object({ op: z.literal('eq'), value: z.union([z.boolean(), z.number(), text(60)]) }),
  z.object({ op: z.literal('lte'), value: z.number().finite() }),
  z.object({ op: z.literal('gte'), value: z.number().finite() }),
  z.object({ op: z.literal('valid_on_date'), field: text(40), date: z.literal('submission') }),
]);

/** The shape of a draft the buyer may save directly. Same limits as the co-pilot's tools. */
export const DraftRfxSchema = z.object({
  terms: z.object({
    title: text(150).nullable(), scope_summary: text(1200).nullable(), delivery_location: text(200).nullable(),
    payment_terms_days: days, validity_days: days, gst_basis: z.enum(['excl_gst', 'incl_gst']).nullable(), currency: z.enum(['INR', 'USD']).nullable(),
    clarifications_by_day: days, quotes_due_day: days, award_by_day: days,
  }),
  lines: z
    .array(
      z.object({
        code: z.string().regex(/^[A-Za-z0-9-]{1,20}$/),
        section: text(80).min(1), description: text(300), spec: text(300).nullable(), uom: text(40).nullable(),
        pack_size: z.number().finite().positive().max(1e6).nullable(), annual_qty: z.number().finite().positive().max(1e9).nullable(),
      }),
    )
    .max(MAX_LINES),
  questions: z
    .array(
      z.object({
        code: z.string().regex(/^[A-Za-z0-9-]{1,20}$/),
        text: text(300), answer_type: z.enum(['bool', 'number', 'date', 'text', 'choice']), is_knockout: z.boolean(), pass_rule: PassRule.nullable(),
      }),
    )
    .max(MAX_QUESTIONS),
}).superRefine((r, ctx) => {
  const dup = (codes: string[]) => codes.find((c, i) => codes.indexOf(c) !== i);
  const l = dup(r.lines.map((x) => x.code));
  if (l) ctx.addIssue({ code: 'custom', message: `Two lines share the code ${l}.` });
  const q = dup(r.questions.map((x) => x.code));
  if (q) ctx.addIssue({ code: 'custom', message: `Two questions share the code ${q}.` });
  if (JSON.stringify(r).length > MAX_STATE_BYTES) ctx.addIssue({ code: 'custom', message: 'The RFx is too large to save.' });
});

export type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  steps?: { tool: string; label: string; summary: string; error: boolean }[];
  cost_inr?: number;
};

export type DraftRow = {
  id: string;
  browser_id: string;
  rfx: DraftRfx;
  messages: ChatMessage[];
  status: 'draft' | 'issued';
  issued_at: string | null;
  updated_at: string;
};

export type DraftView = { id: string; rfx: DraftRfx; messages: ChatMessage[]; status: 'draft' | 'issued'; issued_at: string | null; updated_at: string; validation: Validation };

type Row = { id: string; browser_id: string; state: DraftRfx; messages: ChatMessage[]; status: 'draft' | 'issued'; issued_at: Date | null; updated_at: Date };

const toRow = (r: Row): DraftRow => ({
  id: r.id, browser_id: r.browser_id, rfx: r.state, messages: r.messages, status: r.status, issued_at: r.issued_at?.toISOString() ?? null, updated_at: r.updated_at.toISOString(),
});

export const viewOf = (d: DraftRow): DraftView => ({ id: d.id, rfx: d.rfx, messages: d.messages, status: d.status, issued_at: d.issued_at, updated_at: d.updated_at, validation: validateRfx(d.rfx) });

/** The newest draft of this browser, or null. */
export async function latestDraft(pool: pg.Pool, browserId: string): Promise<DraftRow | null> {
  const r = await pool.query<Row>('select * from rfx_drafts where browser_id = $1 order by updated_at desc limit 1', [browserId]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

/** A draft by id, only if it belongs to this browser. */
export async function getDraft(pool: pg.Pool, browserId: string, id: string): Promise<DraftRow | null> {
  const r = await pool.query<Row>('select * from rfx_drafts where id = $1 and browser_id = $2', [id, browserId]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

export class DraftLimitError extends Error {}

export async function createDraft(pool: pg.Pool, browserId: string): Promise<DraftRow> {
  const total = Number((await pool.query<{ n: string }>('select count(*) as n from rfx_drafts')).rows[0]?.n ?? 0);
  if (total >= MAX_DRAFTS_TOTAL) throw new DraftLimitError('The demo is holding many drafts right now. Use Reset demo, then try again.');
  // Keep a browser to a handful of drafts: drop its oldest beyond the limit.
  await pool.query(
    `delete from rfx_drafts where id in (select id from rfx_drafts where browser_id = $1 order by updated_at desc offset $2)`,
    [browserId, MAX_DRAFTS_PER_BROWSER - 1],
  );
  const r = await pool.query<Row>('insert into rfx_drafts (browser_id, state) values ($1, $2::jsonb) returning *', [browserId, JSON.stringify(emptyRfx())]);
  return toRow(r.rows[0] as Row);
}

export async function saveState(pool: pg.Pool, id: string, rfx: DraftRfx, messages?: ChatMessage[]): Promise<void> {
  if (messages) {
    await pool.query(`update rfx_drafts set state = $2::jsonb, messages = $3::jsonb, updated_at = now() where id = $1 and status = 'draft'`, [id, JSON.stringify(rfx), JSON.stringify(messages.slice(-MAX_MESSAGES))]);
  } else {
    await pool.query(`update rfx_drafts set state = $2::jsonb, updated_at = now() where id = $1 and status = 'draft'`, [id, JSON.stringify(rfx)]);
  }
}
