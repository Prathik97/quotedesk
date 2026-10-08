// Deterministic recompute of stored quote lines from their raw extracted fields,
// the current assumptions and the buyer's overrides. No model call is made here.
// Used by FX and GST edits, every review action, and POST /api/normalize.
import type pg from 'pg';
import type { SizeCheck } from '../../../engine/dimensions.js';
import { recomputeLine, STICKY_FLAGS, type LineOverrides, type StoredLine } from '../../../engine/recompute.js';
import type { Assumptions, BaseUom, ReadConfidence, SourceType, UnitDefinition } from '../../../engine/types.js';
import { conversionJson } from '../extract/persist.js';
import { reconcilePrices } from '../extract/reconcile.js';
import { loadAssumptions } from './assumptions.js';

type Row = {
  id: string;
  vendor_id: string;
  source_document_id: string | null;
  price: number | null;
  uom_text: string | null;
  currency: string | null;
  price_basis: { tax?: StoredLine['tax_basis']; per_n?: number; inherits_last_year?: boolean };
  conversion: { read_confidence?: ReadConfidence; notes_from_model?: string; size_check?: SizeCheck; duplicate_rfx_match?: string } | null;
  flags: string[];
  source_type: SourceType | null;
  evidence: { quote?: string | null; locator?: string | null; read_confidence?: ReadConfidence } | null;
  match_confidence: number | null;
  overrides: LineOverrides;
  uom: BaseUom;
  ly: number | null;
  code: string;
  annual_qty: number;
  old_price: number | null;
  old_status: string;
  vendor_key: string;
  unit_definitions: { term: string; means_quantity: number | null; means_unit: string | null; document_id?: string; evidence?: { quote?: string | null } | null }[] | null;
  conditions: string[] | null;
  rfx_text: string;
  global_notes: { text: string; document_id?: string }[] | null;
};

export type RecomputeSummary = {
  ms: number;
  lines: number;
  changed: { quote_line_id: string; vendor_id: string; vendor_key: string; code: string; price_before: number | null; price_after: number | null; status_before: string; status_after: string }[];
  assumptions: Assumptions;
};

async function loadRows(pool: pg.Pool, vendorIds?: string[]): Promise<Row[]> {
  const r = await pool.query<Row>(
    `select q.id, q.vendor_id, q.source_document_id, q.quoted_price::float8 as price, q.quoted_uom_text as uom_text, q.quoted_currency as currency,
            q.price_basis, q.conversion, q.flags, q.source_type, q.evidence, q.match_confidence::float8 as match_confidence, q.overrides,
            l.uom, l.last_year_rate_inr::float8 as ly, t.unit_definitions, t.global_notes, q.conditions, concat_ws(' ; ', l.description, l.spec) as rfx_text, l.code, l.annual_qty::float8 as annual_qty,
            q.normalized_price_inr::float8 as old_price, coalesce(q.conversion->>'base_status', q.status) as old_status, v.vendor_key
     from quote_lines q join rfx_lines l on l.id = q.rfx_line_id join vendors v on v.id = q.vendor_id left join vendor_terms t on t.vendor_id = q.vendor_id
     where ($1::uuid[] is null or q.vendor_id = any($1))`,
    [vendorIds ?? null],
  );
  return r.rows;
}

function toStored(row: Row): StoredLine {
  // Only the definitions that came from this line's own document are used, as at extraction.
  const defs: UnitDefinition[] = (row.unit_definitions ?? [])
    .filter((d) => !d.document_id || d.document_id === row.source_document_id)
    .map((d) => ({ term: d.term, means_quantity: d.means_quantity, means_unit: d.means_unit, quote: d.evidence?.quote ?? null }));
  return {
    price: row.price,
    currency: row.currency,
    uom_text: row.uom_text,
    per_n: row.price_basis?.per_n ?? 1,
    tax_basis: row.price_basis?.tax ?? 'unknown',
    inherits_last_year: row.price_basis?.inherits_last_year === true,
    base_uom: row.uom,
    last_year_rate_inr: row.ly,
    unit_definitions: defs,
    read_confidence: row.conversion?.read_confidence ?? row.evidence?.read_confidence ?? 'medium',
    match_confidence: row.match_confidence ?? 0,
    source_type: row.source_type ?? 'xlsx',
    evidence_quote: row.evidence?.quote ?? null,
    evidence_locator: row.evidence?.locator ?? null,
    sticky_flags: row.flags.filter((f) => STICKY_FLAGS.includes(f)),
    overrides: row.overrides ?? {},
    conditions: row.conditions ?? [],
    annual_qty: row.annual_qty,
    rfx_text: row.rfx_text,
    vendor_notes: (row.global_notes ?? []).filter((n) => !n.document_id || n.document_id === row.source_document_id).map((n) => n.text),
    size_check: row.conversion?.size_check ?? null,
    duplicate_rfx_match: row.conversion?.duplicate_rfx_match ?? null,
  };
}

/**
 * Keeps one open "needs review" item per line that needs review, and resolves the
 * item when the line no longer does. Dismissed items are left alone.
 */
async function syncLineReviewItems(c: pg.PoolClient, vendorIds: string[]): Promise<void> {
  if (vendorIds.length === 0) return;
  const items = (
    await c.query<{ id: string; quote_line_id: string; state: string }>(
      `select id, quote_line_id, state from review_items where vendor_id = any($1) and kind = 'line_needs_review'`,
      [vendorIds],
    )
  ).rows;
  const lines = (
    await c.query<{ id: string; vendor_id: string; source_document_id: string | null; code: string; status: string; reasons: string[] | null; value: number }>(
      `select q.id, q.vendor_id, q.source_document_id, l.code, q.status,
              array(select jsonb_array_elements_text(coalesce(q.conversion->'reasons', '[]'::jsonb))) as reasons,
              (l.annual_qty * coalesce(q.normalized_price_inr, l.last_year_rate_inr, 0))::float8 as value
       from quote_lines q join rfx_lines l on l.id = q.rfx_line_id where q.vendor_id = any($1) and q.status <> 'rejected'`,
      [vendorIds],
    )
  ).rows;
  const byLine = new Map<string, { id: string; state: string }[]>();
  for (const i of items) byLine.set(i.quote_line_id, [...(byLine.get(i.quote_line_id) ?? []), i]);
  const updates: { id: string; message: string; value: number }[] = [];
  const inserts: { vendor_id: string; quote_line_id: string; document_id: string | null; message: string; value: number }[] = [];
  const resolve: string[] = [];
  for (const l of lines) {
    const mine = byLine.get(l.id) ?? [];
    const message = `${l.code}: ${(l.reasons ?? []).join(' ')}`;
    if (l.status === 'needs_review') {
      const open = mine.find((i) => i.state === 'open');
      if (open) updates.push({ id: open.id, message, value: l.value });
      else if (mine.length === 0) inserts.push({ vendor_id: l.vendor_id, quote_line_id: l.id, document_id: l.source_document_id, message, value: l.value });
    } else {
      for (const i of mine.filter((m) => m.state === 'open')) resolve.push(i.id);
    }
  }
  if (updates.length) {
    await c.query(
      `update review_items r set message = d.message, value_at_stake_inr = d.value
       from jsonb_to_recordset($1::jsonb) as d(id uuid, message text, value numeric) where r.id = d.id`,
      [JSON.stringify(updates)],
    );
  }
  if (inserts.length) {
    await c.query(
      `insert into review_items (vendor_id, quote_line_id, document_id, kind, severity, message, value_at_stake_inr)
       select d.vendor_id, d.quote_line_id, d.document_id, 'line_needs_review', 'warn', d.message, d.value
       from jsonb_to_recordset($1::jsonb) as d(vendor_id uuid, quote_line_id uuid, document_id uuid, message text, value numeric)`,
      [JSON.stringify(inserts)],
    );
  }
  if (resolve.length) {
    await c.query(
      `update review_items set state = 'resolved', resolution = coalesce(resolution, '{"auto": true, "note": "No longer needs review after recompute."}'::jsonb) where id = any($1)`,
      [resolve],
    );
  }
}

/**
 * Recompute every quote line (or one vendor's) from raw fields, then redo the
 * checks that depend on price. Everything runs in one transaction. Returns what
 * changed so the UI can show the effect.
 */
export async function recompute(pool: pg.Pool, opts: { vendorIds?: string[]; /** Derive and report what would move, write nothing. */ dryRun?: boolean } = {}): Promise<RecomputeSummary> {
  const t0 = Date.now();
  const [a, rows] = await Promise.all([loadAssumptions(pool), loadRows(pool, opts.vendorIds)]);

  const changed: RecomputeSummary['changed'] = [];
  const payload = rows.map((row) => {
    if (row.overrides?.not_quoted) return { id: row.id, rejected: true };
    const r = recomputeLine(toStored(row), a);
    const moved = (row.old_price ?? null) !== r.normalized_inr && Math.abs((row.old_price ?? 0) - (r.normalized_inr ?? 0)) > 1e-9;
    if (moved || row.old_status !== r.status) {
      changed.push({ quote_line_id: row.id, vendor_id: row.vendor_id, vendor_key: row.vendor_key, code: row.code, price_before: row.old_price, price_after: r.normalized_inr, status_before: row.old_status, status_after: r.status });
    }
    return {
      id: row.id,
      rejected: false,
      n: r.normalized_inr,
      s: r.status,
      conf: r.confidence,
      f: r.flags,
      k: r.assumption_keys,
      c: conversionJson(r, {
        read_confidence: row.conversion?.read_confidence ?? row.evidence?.read_confidence ?? 'medium',
        notes_from_model: row.conversion?.notes_from_model ?? '',
        ...(row.conversion?.size_check ? { size_check: row.conversion.size_check } : {}),
        ...(row.conversion?.duplicate_rfx_match ? { duplicate_rfx_match: row.conversion.duplicate_rfx_match } : {}),
      }),
      p: r.pack_size,
    };
  });

  if (opts.dryRun) return { ms: Date.now() - t0, lines: rows.length, changed, assumptions: a };

  const vendors = [...new Set(rows.map((r) => r.vendor_id))];
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(
      `update quote_lines q set
         status = case when d.rejected then 'rejected' else d.s end,
         normalized_price_inr = case when d.rejected then q.normalized_price_inr else d.n end,
         confidence = case when d.rejected then q.confidence else d.conf end,
         flags = case when d.rejected then q.flags else array(select jsonb_array_elements_text(d.f)) end,
         assumption_keys = case when d.rejected then q.assumption_keys else array(select jsonb_array_elements_text(d.k)) end,
         conversion = case when d.rejected then q.conversion else d.c end,
         price_basis = case when d.rejected then q.price_basis else jsonb_set(q.price_basis, '{pack_size}', coalesce(to_jsonb(d.p), 'null'::jsonb)) end
       from jsonb_to_recordset($1::jsonb) as d(id uuid, rejected boolean, n numeric, s text, conf numeric, f jsonb, k jsonb, c jsonb, p numeric)
       where q.id = d.id`,
      [JSON.stringify(payload)],
    );
    await syncLineReviewItems(c, vendors);
    await reconcilePrices(c, vendors);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
  return { ms: Date.now() - t0, lines: rows.length, changed, assumptions: a };
}
