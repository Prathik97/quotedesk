// GET /api/rfx: the saved RFx, read only. Labelled "Issued RFx (saved)" in the app.
import { describeRule, type PassRule } from '../../../engine/questionnaire.js';
import type { RfxResponse } from '../../../src/lib/api-types.js';
import { storedRun } from '../compare/data.js';
import { db } from '../db.js';
import { ApiError, route } from '../http.js';
import { STORED_RUN_USAGE_SQL } from '../compare/stored-run.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export default route(['GET'], async (): Promise<RfxResponse> => {
  const r = (
    await db().query<{ d: Json }>(`
      with r as (select * from rfx order by is_saved_demo desc, created_at limit 1)
      select jsonb_build_object(
        'rfx', (select to_jsonb(r) from r),
        'lines', (select coalesce(jsonb_agg(to_jsonb(l) order by l.sort), '[]'::jsonb) from rfx_lines l, r where l.rfx_id = r.id),
        'questions', (select coalesce(jsonb_agg(to_jsonb(q) order by q.sort), '[]'::jsonb) from questionnaire_questions q, r where q.rfx_id = r.id),
        'usage', ${STORED_RUN_USAGE_SQL}
      ) as d`)
  ).rows[0]?.d;
  if (!r?.rfx) throw new ApiError(404, 'not_found', 'No RFx is loaded. Run npm run seed:db.');
  const lines = (r.lines as Json[]).map((l) => ({
    id: l.id, code: l.code, section: l.section, description: l.description, spec: l.spec ?? null, uom: l.uom, annual_qty: Number(l.annual_qty),
    ly_rate: l.last_year_rate_inr == null ? null : Number(l.last_year_rate_inr), is_one_time: l.is_one_time, sort: l.sort,
  }));
  const x = r.rfx as Json;
  return {
    stored: storedRun(r.usage),
    rfx: {
      id: x.id, ref: x.ref ?? null, title: x.title, category: x.category, buyer_org: x.buyer_org, status: x.status, is_saved_demo: x.is_saved_demo,
      delivery_location: x.delivery_location ?? null, payment_terms_requested_days: x.payment_terms_requested_days ?? null, validity_days: x.validity_days ?? null,
      gst_basis_requested: x.gst_basis_requested ?? null, currency: x.currency,
    },
    lines,
    questions: (r.questions as Json[]).map((q) => ({ code: q.code, text: q.text, answer_type: q.answer_type, is_knockout: q.is_knockout, rule_text: describeRule((q.pass_rule ?? null) as PassRule | null) })),
    ly_total_inr: lines.reduce((s, l) => s + (l.ly_rate ?? 0) * l.annual_qty, 0),
  };
});
