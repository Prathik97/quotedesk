// GET /api/evidence?quote_line_id=X  or  ?vendor_id=X&rfx_line_id=Y (for a Not quoted cell)
// Everything the evidence drawer shows: source, raw value, conversions with factors,
// assumptions, flags, corrections and a plain language reason for the status.
import { z } from 'zod';
import { toCellStatus } from '../engine/certainty.js';
import { choosePackDefinition, parseUnit, unitMarker } from '../engine/convert.js';
import { assumptionText, explainConfidence, flagText } from '../engine/explain.js';
import { traceConversion } from '../engine/recompute.js';
import type { BaseUom, ReadConfidence, SourceType, UnitDefinition } from '../engine/types.js';
import type { EvidenceResponse, LineDef, SourceContext, SourceRef } from '../src/lib/api-types.js';
import { defaults } from './_lib/compare/assumptions.js';
import { storedRun } from './_lib/compare/data.js';
import { evidenceContext } from './_lib/compare/source.js';
import { signedUrl } from './_lib/compare/storage.js';
import { db } from './_lib/db.js';
import { ApiError, route } from './_lib/http.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const Query = z.object({ quote_line_id: z.string().uuid().optional(), vendor_id: z.string().uuid().optional(), rfx_line_id: z.string().uuid().optional() });

const SQL = `
with ql as (
  select q.* from quote_lines q
  where ($1::uuid is not null and q.id = $1)
     or ($1::uuid is null and q.vendor_id = $2 and q.rfx_line_id = $3)
  order by (q.status <> 'rejected') desc, q.created_at desc limit 1),
ids as (select coalesce((select vendor_id from ql), $2::uuid) as vendor_id, coalesce((select rfx_line_id from ql), $3::uuid) as rfx_line_id)
select jsonb_build_object(
  'q', (select to_jsonb(ql) from ql),
  'vendor', (select to_jsonb(v) from vendors v, ids where v.id = ids.vendor_id),
  'line', (select to_jsonb(l) from rfx_lines l, ids where l.id = ids.rfx_line_id),
  'terms', (select to_jsonb(t) from vendor_terms t, ids where t.vendor_id = ids.vendor_id),
  'doc', (select jsonb_build_object('id', d.id, 'filename', d.filename, 'mime', d.mime, 'storage_path', d.storage_path, 'from', v.contact_email, 'subject', m.subject, 'received', m.received_at, 'body', m.body_text)
          from documents d join vendors v on v.id = d.vendor_id left join vendor_messages m on m.id = d.message_id where d.id = (select source_document_id from ql)),
  'corrections', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc), '[]'::jsonb) from corrections c where c.quote_line_id = (select id from ql)),
  'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'state', i.state, 'message', i.message)), '[]'::jsonb) from review_items i where i.quote_line_id = (select id from ql)),
  'assumptions', (select coalesce(jsonb_agg(jsonb_build_object('key', a.key, 'value', a.value)), '[]'::jsonb) from assumptions a where a.scope = 'global'),
  'usage', (select jsonb_build_object('mx', max(created_at), 'n', count(*)) from usage_log where not cache_hit and stage = 'extract')
) as d`;

export default route(['GET'], async (req) => {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success || (!parsed.data.quote_line_id && !(parsed.data.vendor_id && parsed.data.rfx_line_id))) {
    throw new ApiError(400, 'bad_request', 'Pass quote_line_id, or vendor_id and rfx_line_id.');
  }
  const { quote_line_id = null, vendor_id = null, rfx_line_id = null } = parsed.data;
  const raw = (await db().query<{ d: Json }>(SQL, [quote_line_id, vendor_id, rfx_line_id])).rows[0]?.d;
  if (!raw?.vendor || !raw.line) throw new ApiError(404, 'not_found', 'That cell does not exist. Reload the page.');

  const q = raw.q as Json | null;
  const l = raw.line as Json;
  const v = raw.vendor as Json;
  const terms = (raw.terms ?? {}) as Json;
  const d0 = defaults();
  const g = (k: 'usd_inr' | 'gst_pct') => Number((raw.assumptions as Json[]).find((a) => a.key === k)?.value ?? d0[k]);
  const a = { usd_inr: g('usd_inr'), gst_pct: g('gst_pct') };
  const line: LineDef = { id: l.id, code: l.code, section: l.section, description: l.description, spec: l.spec ?? null, uom: l.uom, annual_qty: Number(l.annual_qty), ly_rate: l.last_year_rate_inr == null ? null : Number(l.last_year_rate_inr), is_one_time: l.is_one_time, sort: l.sort };
  const stored = storedRun(raw.usage);

  const rejected = q?.status === 'rejected';
  const status = !q || rejected ? 'missing' : toCellStatus(q.status);
  if (!q || rejected) {
    const base: EvidenceResponse = {
      stored, quote_line_id: q?.id ?? null, vendor: { id: v.id, key: v.vendor_key, name: v.name }, line, status: 'missing', price: null, annual_value: null, delta_pct: null,
      quoted: { price: null, currency: null, uom_text: null, per_n: 1, inherits_last_year: false, tax_basis: null },
      trace: null, conversion_notes: [], conversion_error: null, pack_source: null, unit_definition: null, assumptions_used: [], flags: [],
      explanation: rejected
        ? ['The buyer marked this line as not quoted. The original reading is kept and can be restored with Undo.']
        : explainConfidence({ status: 'missing', source_type: null, read_confidence: null, match_confidence: null, assumption_keys: [], accepted_keys: [], flags: [], buyer_verified: false, pack_source: null, rule_reasons: [] }, a),
      buyer_verified: false, overrides: (q?.overrides ?? {}) as Record<string, unknown>,
      corrections: ((raw.corrections ?? []) as Json[]).map(mapCorrection), review_items: (raw.items ?? []) as EvidenceResponse['review_items'],
      conditions: [], source: null, context: { kind: 'none', note: 'There is no source for a line the vendor did not quote.' }, match_reason: null, match_confidence: null, vendor_description: q?.vendor_description ?? null, base_uom: l.uom,
    };
    return base;
  }

  const ev = (q.evidence ?? {}) as Json;
  const conv = (q.conversion ?? {}) as Json;
  const basis = (q.price_basis ?? {}) as Json;
  const o = (q.overrides ?? {}) as Json;
  const inherits = basis.inherits_last_year === true && o.price == null;
  const perN = Number(o.per_n ?? basis.per_n ?? 1);
  const startPrice = inherits ? line.ly_rate : Number(o.price ?? q.quoted_price);
  const normalized = q.normalized_price_inr == null ? null : Number(q.normalized_price_inr);
  const trace = startPrice != null && Number.isFinite(startPrice) ? traceConversion(startPrice, (conv.steps ?? []) as never, normalized) : null;

  // Which vendor footnote defined the pack, with its crop region
  let unitDefinition: EvidenceResponse['unit_definition'] = null;
  const unit = parseUnit(o.uom_text ?? q.quoted_uom_text, perN);
  if (unit.kind === 'pack' && conv.pack_source !== 'buyer') {
    const defsRaw = ((terms.unit_definitions ?? []) as Json[]).filter((x) => !x.document_id || x.document_id === q.source_document_id);
    const defs: UnitDefinition[] = defsRaw.map((x) => ({ term: x.term, means_quantity: x.means_quantity ?? null, means_unit: x.means_unit ?? null, quote: x.evidence?.quote ?? null }));
    const chosen = choosePackDefinition(unit.term, unitMarker(o.uom_text ?? q.quoted_uom_text), defs, l.uom as BaseUom);
    if (!('error' in chosen)) {
      const src = defsRaw.find((x) => x.term === chosen.term);
      unitDefinition = {
        term: chosen.term,
        means: `${chosen.means_quantity} ${chosen.means_unit ?? ''}`.trim(),
        quote: chosen.quote,
        region: src?.evidence?.region ?? null,
        locator: src?.evidence?.locator ?? null,
        document_id: src?.document_id ?? null,
      };
    }
  }

  const doc = raw.doc as Json | null;
  const sourceType = (q.source_type ?? ev.source_type ?? 'xlsx') as SourceType;
  const url = doc ? await signedUrl(doc.storage_path) : null;
  const source: SourceRef | null = doc
    ? {
        document_id: doc.id, filename: doc.filename, mime: doc.mime, source_type: sourceType, locator: ev.locator ?? '', quote: ev.quote ?? null,
        page: ev.page ?? null, region: ev.region ?? null, read_confidence: ev.read_confidence ?? null, signed_url: url,
      }
    : null;
  const context: SourceContext = doc
    ? await evidenceContext({ id: doc.id, filename: doc.filename, mime: doc.mime, storage_path: doc.storage_path, message: { from: doc.from ?? null, subject: doc.subject ?? null, received: doc.received ?? null, body: doc.body ?? null } }, ev.locator ?? '', sourceType, ev.page ?? null)
    : { kind: 'none', note: 'No source document is stored for this value.' };

  const keys = (q.assumption_keys ?? []) as string[];
  const accepted = (conv.accepted_keys ?? []) as string[];
  const flags = ((q.flags ?? []) as string[]).map((f) => ({ flag: f, text: flagText(f) }));
  const verified = o.verified === true;
  const explanation = explainConfidence(
    {
      status: status as never, source_type: sourceType, read_confidence: (conv.read_confidence ?? ev.read_confidence ?? null) as ReadConfidence | null,
      match_confidence: q.match_confidence == null ? null : Number(q.match_confidence), assumption_keys: keys, accepted_keys: accepted,
      flags: q.flags ?? [], buyer_verified: verified, pack_source: conv.pack_source ?? null, rule_reasons: (conv.reasons ?? []) as string[],
    },
    a,
  );

  const out: EvidenceResponse = {
    stored,
    quote_line_id: q.id,
    vendor: { id: v.id, key: v.vendor_key, name: v.name },
    line,
    status,
    price: normalized,
    annual_value: normalized == null ? null : normalized * line.annual_qty,
    delta_pct: normalized != null && line.ly_rate ? (normalized / line.ly_rate - 1) * 100 : null,
    quoted: { price: q.quoted_price == null ? null : Number(q.quoted_price), currency: q.quoted_currency ?? null, uom_text: q.quoted_uom_text ?? null, per_n: perN, inherits_last_year: basis.inherits_last_year === true, tax_basis: basis.tax ?? null },
    trace,
    conversion_notes: (conv.notes ?? []) as string[],
    conversion_error: conv.error ? { reason: conv.error, detail: conv.detail ?? '' } : null,
    pack_source: conv.pack_source ?? null,
    unit_definition: unitDefinition,
    assumptions_used: keys.map((k) => ({
      key: k,
      text: k === 'pack_size' && conv.pack_source === 'buyer' ? 'Unit meaning set by the buyer.' : assumptionText(k, a),
      accepted: accepted.includes(k),
      editable: k === 'usd_inr' || k === 'gst_pct',
      value: k === 'usd_inr' ? a.usd_inr : k === 'gst_pct' ? a.gst_pct : null,
      unit: k === 'usd_inr' ? 'INR per USD' : k === 'gst_pct' ? 'percent' : null,
    })),
    flags,
    explanation,
    buyer_verified: verified,
    overrides: o,
    corrections: ((raw.corrections ?? []) as Json[]).map(mapCorrection),
    review_items: (raw.items ?? []) as EvidenceResponse['review_items'],
    conditions: Array.isArray(q.conditions) ? q.conditions : [],
    source,
    context,
    match_reason: q.match_reason ?? null,
    match_confidence: q.match_confidence == null ? null : Number(q.match_confidence),
    vendor_description: q.vendor_description ?? null,
    base_uom: l.uom,
  };
  return out;
});

function mapCorrection(c: Json): EvidenceResponse['corrections'][number] {
  return { id: c.id, action: c.action ?? null, field: c.field, old_value: c.old_value, new_value: c.new_value, reason: c.reason, created_at: c.created_at };
}
