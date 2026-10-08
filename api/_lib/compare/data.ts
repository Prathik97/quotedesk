// Read models for the comparison workspace. One round trip loads everything the
// grid, vendor headers, questionnaire, attachments and certainty strip need.
import type pg from 'pg';
import { BLOCKER_KINDS, certaintyCounts, readiness, toCellStatus, type CellStatus, type OpenItem } from '../../../engine/certainty.js';
import { assumptionText } from '../../../engine/explain.js';
import { describeRule, evaluateVendor, type KnockoutQuestion, type PassRule, type StoredAnswer } from '../../../engine/questionnaire.js';
import type {
  AnswerCell,
  AssumptionRow,
  Attachment,
  CompareResponse,
  DerivedAssumption,
  Discount,
  GridCell,
  LineDef,
  QuestionRow,
  StoredRun,
  VendorHeader,
} from '../../../src/lib/api-types.js';
import { shortValidityWarning } from '../../../engine/terms.js';
import { defaults } from './assumptions.js';
import { STORED_RUN_USAGE_SQL } from './stored-run.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SQL = `
with r as (select * from rfx order by is_saved_demo desc, created_at limit 1)
select jsonb_build_object(
  'rfx', (select to_jsonb(r) from r),
  'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'code', l.code, 'section', l.section, 'description', l.description, 'spec', l.spec,
      'uom', l.uom, 'annual_qty', l.annual_qty, 'ly_rate', l.last_year_rate_inr, 'is_one_time', l.is_one_time, 'sort', l.sort) order by l.sort), '[]'::jsonb)
      from rfx_lines l, r where l.rfx_id = r.id),
  'vendors', (select coalesce(jsonb_agg(jsonb_build_object('v', to_jsonb(v), 's', to_jsonb(s), 't', to_jsonb(t),
      'm', (select to_jsonb(m) from (select arrival_day, received_at, subject from vendor_messages m where m.vendor_id = v.id order by arrival_day limit 1) m)
      ) order by v.vendor_key), '[]'::jsonb)
      from vendors v join r on v.rfx_id = r.id left join vendor_summary_view s on s.vendor_id = v.id left join vendor_terms t on t.vendor_id = v.id),
  'cells', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from comparison_view c, r where c.rfx_id = r.id),
  'questions', (select coalesce(jsonb_agg(to_jsonb(q) order by q.sort), '[]'::jsonb) from questionnaire_questions q, r where q.rfx_id = r.id),
  'answers', (select coalesce(jsonb_agg(jsonb_build_object('vendor_id', a.vendor_id, 'question_id', a.question_id, 'raw', a.answer_raw, 'value', a.answer_value,
      'status', a.status, 'basis', a.basis, 'evidence', a.evidence, 'document_id', a.source_document_id)), '[]'::jsonb) from questionnaire_answers a),
  'docs', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'vendor_id', d.vendor_id, 'filename', d.filename, 'mime', d.mime, 'kind', d.kind,
      'status', d.status, 'error', d.error, 'flags', d.flags, 'facts', d.facts, 'storage_path', d.storage_path,
      'lines', (select count(*) from quote_lines ql where ql.source_document_id = d.id)) order by d.created_at), '[]'::jsonb) from documents d),
  'items', (select coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'severity', i.severity, 'message', i.message, 'vendor_id', i.vendor_id)), '[]'::jsonb)
      from review_items i where i.state = 'open'),
  'assumptions', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from assumptions a where a.scope = 'global'),
  'usage', ${STORED_RUN_USAGE_SQL},
  'raw', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'per_n', q.price_basis->'per_n', 'tax', q.price_basis->>'tax', 'inherits', q.price_basis->'inherits_last_year',
      'read', q.conversion->>'read_confidence', 'evread', q.evidence->>'read_confidence', 'match', q.match_confidence, 'quote', q.evidence->>'quote', 'locator', q.evidence->>'locator',
      'doc', q.source_document_id, 'flags', q.flags, 'overrides', q.overrides, 'size_check', q.conversion->'size_check', 'dup', q.conversion->>'duplicate_rfx_match', 'tax_inputs', q.conversion->'tax_inputs', 'vdesc', q.vendor_description)), '[]'::jsonb) from quote_lines q where q.rfx_line_id is not null),
  'pack_overrides', (select coalesce(jsonb_agg(jsonb_build_object('vendor_id', q.vendor_id)), '[]'::jsonb) from quote_lines q where q.overrides ? 'pack')
) as d`;

export function storedRun(usage: { mx: string | null; n: number | string } | null): StoredRun {
  const mx = usage?.mx ? new Date(usage.mx) : null;
  const date = mx ? mx.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : null;
  return {
    date,
    label: date ? `Stored results from a live run on ${date}` : 'Stored results',
    live_calls: Number(usage?.n ?? 0),
  };
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Where a vendor's reply is in the pipeline, from its documents and open items. */
export function pipelineOf(docs: { status: string }[], items: { kind: string; severity: string }[]): VendorHeader['pipeline'] {
  if (docs.length === 0) return 'Received';
  if (docs.some((d) => d.status === 'received' || d.status === 'classified')) return docs.every((d) => d.status === 'received') ? 'Received' : 'Classified';
  const blocked = items.some((i) => BLOCKER_KINDS.includes(i.kind) || i.severity === 'block');
  return docs.some((d) => d.status === 'failed') || blocked ? 'Needs review' : 'Ready';
}

export async function loadCompare(pool: pg.Pool): Promise<CompareResponse> {
  const raw = (await pool.query<{ d: Json }>(SQL)).rows[0]?.d;
  if (!raw || !raw.rfx) throw new Error('No RFx is loaded. Run npm run seed:db.');
  const d = defaults();
  const lines: LineDef[] = (raw.lines as Json[]).map((l) => ({ ...(l as LineDef), annual_qty: Number(l.annual_qty), ly_rate: num(l.ly_rate) }));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const docs = raw.docs as Json[];
  const items = raw.items as Json[];

  const rawById = new Map((raw.raw as Json[]).map((r) => [r.id as string, r]));
  const termsByVendor = new Map((raw.vendors as Json[]).map((x) => [x.v.id as string, (x.t ?? {}) as Json]));
  const cells: GridCell[] = (raw.cells as Json[]).map((c) => {
    const rw = c.quote_line_id ? rawById.get(c.quote_line_id) : undefined;
    const defs = ((termsByVendor.get(c.vendor_id)?.unit_definitions ?? []) as Json[]).filter((x) => !x.document_id || x.document_id === rw?.doc);
    return {
    raw: rw
      ? {
          per_n: Number(rw.per_n ?? 1),
          tax_basis: rw.tax ?? 'unknown',
          inherits_last_year: rw.inherits === true,
          read_confidence: rw.read ?? rw.evread ?? 'medium',
          match_confidence: Number(rw.match ?? 0),
          evidence_quote: rw.quote ?? null,
          evidence_locator: rw.locator ?? null,
          sticky_flags: ((rw.flags ?? []) as string[]).filter((f) => ['from_hidden_sheet', 'unmatched', 'unknown_rfx_code'].includes(f)),
          overrides: rw.overrides ?? {},
          unit_definitions: defs.map((x) => ({ term: x.term, means_quantity: x.means_quantity ?? null, means_unit: x.means_unit ?? null, quote: x.evidence?.quote ?? null })),
          rfx_text: [lineById.get(c.rfx_line_id)?.description, lineById.get(c.rfx_line_id)?.spec].filter(Boolean).join(' ; '),
          size_check: rw.size_check ?? null,
          duplicate_rfx_match: rw.dup ?? null,
          scope_text: [rw.vdesc, rw.quote, [lineById.get(c.rfx_line_id)?.description, lineById.get(c.rfx_line_id)?.spec].filter(Boolean).join(' ; '), lineById.get(c.rfx_line_id)?.section].filter((v) => v != null).join(' ; '),
          model_tax: rw.tax_inputs?.model_tax ?? null,
          doc_tax_statements: rw.tax_inputs?.doc_tax_statements ?? [],
          vendor_notes: ((termsByVendor.get(c.vendor_id)?.global_notes ?? []) as Json[]).filter((x) => !x.document_id || x.document_id === rw?.doc).map((x) => String(x.text)),
        }
      : null,
    vendor_id: c.vendor_id,
    rfx_line_id: c.rfx_line_id,
    quote_line_id: c.quote_line_id ?? null,
    price: num(c.normalized_price_inr),
    status: toCellStatus(c.status),
    flags: c.flags ?? [],
    assumption_keys: c.assumption_keys ?? [],
    quoted_price: num(c.quoted_price),
    quoted_uom: c.quoted_uom_text ?? null,
    quoted_currency: c.quoted_currency ?? null,
    conditions: Array.isArray(c.conditions) ? c.conditions : [],
    source_type: c.source_type ?? null,
    buyer_verified: c.buyer_verified === true,
    confidence: num(c.confidence),
    };
  });

  // Questions and answers
  const questions = raw.questions as Json[];
  const knockQs: KnockoutQuestion[] = questions.map((q) => ({ code: q.code, is_knockout: q.is_knockout, pass_rule: (q.pass_rule ?? null) as PassRule | null }));
  const codeById = new Map(questions.map((q) => [q.id, q.code as string]));
  const answersByVendor = new Map<string, Json[]>();
  for (const a of raw.answers as Json[]) answersByVendor.set(a.vendor_id, [...(answersByVendor.get(a.vendor_id) ?? []), a]);

  const vendors: VendorHeader[] = [];
  const verdicts = new Map<string, ReturnType<typeof evaluateVendor>>();
  for (const row of raw.vendors as Json[]) {
    const v = row.v as Json;
    const s = (row.s ?? {}) as Json;
    const t = (row.t ?? {}) as Json;
    const m = (row.m ?? {}) as Json;
    const vendorDocs = docs.filter((x) => x.vendor_id === v.id);
    const submitted = m.received_at ? String(m.received_at).slice(0, 10) : null;
    const stored: StoredAnswer[] = (answersByVendor.get(v.id) ?? []).map((a) => ({ code: codeById.get(a.question_id) ?? '', status: a.status, answer_value: a.value, basis: a.basis }));
    const verdict = evaluateVendor(knockQs, stored, submitted, vendorDocs.map((x) => x.facts ?? {}).filter((f) => f && Object.keys(f).length > 0));
    verdicts.set(v.id, verdict);
    const myItems = items.filter((i) => i.vendor_id === v.id);
    const failed = vendorDocs.filter((x) => x.status === 'failed').length;
    const inProgress = vendorDocs.some((x) => x.status === 'received' || x.status === 'classified');
    const discounts: Discount[] = ((t.conditional_discounts ?? []) as Json[]).map((x, i) => ({
      id: `${v.vendor_key}-d${i + 1}`,
      percent: Number(x.percent),
      condition: x.condition ?? null,
      text: x.text ?? '',
      applies_to: x.applies_to ?? null,
      document_id: x.document_id ?? null,
      evidence_quote: x.evidence?.quote ?? null,
      evidence_locator: x.evidence?.locator ?? null,
    }));
    vendors.push({
      id: v.id,
      key: v.vendor_key,
      name: v.name,
      location: v.location ?? null,
      contact_email: v.contact_email ?? null,
      arrival_day: m.arrival_day ?? null,
      received_at: m.received_at ?? null,
      coverage: { quoted: Number(s.lines_quoted ?? 0), total: Number(s.lines_total ?? lines.length) },
      counts: { confirmed: Number(s.confirmed ?? 0), assumed: Number(s.assumed ?? 0), needs_review: Number(s.needs_review ?? 0), conflict: Number(s.conflict ?? 0), missing: Number(s.missing ?? 0) },
      questionnaire: verdict.result,
      freight_terms: t.freight_terms ?? 'unknown',
      freight_note: t.freight_note ?? null,
      freight_amount_inr: num(t.freight_amount_inr),
      payment_terms_days: t.payment_terms_days ?? null,
      validity_text: t.validity_text ?? null,
      validity_warning: shortValidityWarning(t.validity_text ?? null, num((raw.rfx as Json).validity_days)),
      notes: [...new Set(((t.global_notes ?? []) as Json[]).map((n) => String(n.text)))],
      stated_total_inr: num(t.stated_total_inr),
      letterhead_name: t.letterhead_name ?? null,
      attachments: Number(s.attachment_count ?? vendorDocs.length),
      open_warnings: myItems.filter((i) => i.severity === 'warn').length,
      open_items: myItems.length,
      extraction: { status: failed > 0 ? 'Failed' : inProgress ? 'In progress' : 'Extracted', documents: vendorDocs.length, failed },
      pipeline: pipelineOf(vendorDocs as { status: string }[], myItems as { kind: string; severity: string }[]),
      discounts,
    });
  }

  const vendorById = new Map(vendors.map((v) => [v.id, v]));

  const qRows: QuestionRow[] = questions.map((q) => {
    const answers: Record<string, AnswerCell | null> = {};
    for (const v of vendors) {
      const a = (answersByVendor.get(v.id) ?? []).find((x) => x.question_id === q.id);
      const ko = verdicts.get(v.id)?.knockouts[q.code];
      answers[v.id] = a
        ? { raw: a.raw ?? null, value: a.value, status: a.status, basis: a.basis, evidence: a.evidence ?? null, document_id: a.document_id ?? null, outcome: ko ?? null }
        : ko
          ? { raw: null, value: null, status: 'unanswered', basis: 'explicit', evidence: null, document_id: null, outcome: ko }
          : null;
    }
    return { id: q.id, code: q.code, text: q.text, answer_type: q.answer_type, is_knockout: q.is_knockout, rule_text: describeRule((q.pass_rule ?? null) as PassRule | null), answers };
  });

  const attachments: Attachment[] = docs.map((x) => ({
    id: x.id,
    vendor_id: x.vendor_id,
    filename: x.filename,
    mime: x.mime,
    kind: x.kind ?? null,
    status: x.status,
    error: x.error ?? null,
    flags: x.flags ?? [],
    facts: x.facts ?? null,
    is_message_body: String(x.storage_path).startsWith('message:'),
    lines: Number(x.lines ?? 0),
  }));

  // Assumptions: the two global numbers, then what is derived from the documents.
  const rows = raw.assumptions as Json[];
  const row = (key: 'usd_inr' | 'gst_pct', label: string, unit: string): AssumptionRow => {
    const r = rows.find((x) => x.key === key);
    return { key, label, value: Number(r?.value ?? d[key]), default_value: d[key], set_by: r?.set_by === 'buyer' ? 'buyer' : 'system', note: r?.note ?? null, editable: true, unit };
  };
  const assumptions: AssumptionRow[] = [row('usd_inr', 'USD to INR rate', 'INR per USD'), row('gst_pct', 'GST percentage', 'percent')];

  const derived: DerivedAssumption[] = [];
  const buyerPackVendors = new Set((raw.pack_overrides as Json[]).map((x) => x.vendor_id));
  for (const v of vendors) {
    const mine = cells.filter((c) => c.vendor_id === v.id && c.quote_line_id);
    const count = (k: string) => mine.filter((c) => c.assumption_keys.includes(k)).length;
    const t = ((raw.vendors as Json[]).find((x) => x.v.id === v.id)?.t ?? {}) as Json;
    const defs = (t.unit_definitions ?? []) as Json[];
    const push = (key: string, label: string, detail: string, n: number, set_by: 'system' | 'buyer' = 'system') => {
      if (n > 0) derived.push({ key, label, vendor_key: v.key, vendor_name: v.name, detail, lines: n, set_by });
    };
    push('usd_inr', 'Quoted in USD', 'Converted at the global USD to INR rate. The vendor states no rate.', count('usd_inr'));
    push('gst_pct', 'Quoted including GST', assumptionText('gst_pct', { usd_inr: d.usd_inr, gst_pct: d.gst_pct }), count('gst_pct'));
    push('last_year_inheritance', 'Same as last year', 'The vendor gave no number, so the last year contract rate is used.', count('last_year_inheritance'));
    push('tax_basis_assumed_excl', 'GST basis not stated', 'Read as excluding GST, as the RFx asked.', count('tax_basis_assumed_excl'));
    push('tax_basis_conflict', 'Conflicting tax statements', 'The vendor document says GST is extra and included in different places. Lines the vendor\'s own words settle are converted at the rate the vendor stated; lines they do not settle are shown as Not derived. Held at Assumed at most.', count('tax_basis_conflict'));
    if (count('pack_size') > 0 || buyerPackVendors.has(v.id)) {
      const text = defs.map((x) => `${x.term} = ${x.means_quantity} ${x.means_unit ?? ''}`.trim()).join('; ');
      push('pack_size', 'Pack size from the vendor note', text ? `Vendor note: ${text}.` : 'Pack size from the vendor note.', count('pack_size'));
    }
    const photo = mine.filter((c) => c.source_type === 'image' && !c.buyer_verified).length;
    push('photo_read', 'Read from a photo', 'Photo values are never confirmed automatically. Check the crop, then accept.', photo);
  }

  const counts = certaintyCounts(cells.map((c) => c.status));
  const open: OpenItem[] = items.map((i) => ({ kind: i.kind, severity: i.severity, message: i.message, vendor: vendorById.get(i.vendor_id)?.name ?? null }));
  const ready = readiness(counts, open);
  const ly = lines.reduce((s, l) => s + (l.ly_rate ?? 0) * l.annual_qty, 0);
  void lineById;
  const rfx = raw.rfx as Json;
  return {
    stored: storedRun(raw.usage),
    rfx: { id: rfx.id, ref: rfx.ref ?? null, title: rfx.title, buyer_org: rfx.buyer_org },
    lines,
    vendors,
    cells,
    questions: qRows,
    attachments,
    assumptions,
    derived_assumptions: derived,
    certainty: counts,
    readiness: ready,
    open_review: items.length,
    open_items: items.map((i) => ({ vendor_key: vendorById.get(i.vendor_id)?.key ?? null, kind: i.kind, severity: i.severity, message: i.message })),
    ly_total_inr: ly,
  };
}

export type { CellStatus };
