// POST /api/decision  creates the decision pack for a scenario: the PDF memo, the xlsx appendix and the
// draft approval note. Everything is computed on the server from the stored data, never from numbers the
// browser sends. Files come back in the JSON (base64), well under Vercel's response limit.
//
// body: the scenario (see PackRequestSchema) plus
//   note_mode   "model" (default) writes the note with ONE model call; "template" uses fixed rules and no model
//   regenerate  true skips the stored reply for identical data and calls the model again
// A failed number check returns the note and a warning but no files, so a memo never carries a note that
// did not pass. The buyer then picks Regenerate or Use template.
import { z } from 'zod';
import { AwardError } from '../../../engine/award.js';
import { loadAnalystData } from '../analyst/data.js';
import { db } from '../db.js';
import { buildAppendix } from '../decision/appendix.js';
import { blocksText, memoBlocks, missingFromMemo, renderMemo } from '../decision/memo.js';
import { resolveNote } from '../decision/note.js';
import { buildPack, noteModeSchema, PackRequestSchema, requiredMemoStrings } from '../decision/pack.js';
import { env } from '../env.js';
import { admitModelCall } from '../guard.js';
import { ApiError, log, route } from '../http.js';
import { realClient } from '../llm/client.js';
import { budgetSessionId } from '../llm/session.js';
import { pgStore } from '../llm/store.js';

const Body = PackRequestSchema.extend({ note_mode: noteModeSchema.default('model'), regenerate: z.boolean().default(false) });

/** Vercel caps a function response at about 4.5 MB. The pack is far smaller; this is a backstop. */
const MAX_RESPONSE_BYTES = 3_500_000;

export default route(['POST'], async (req) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'bad_request', parsed.error.issues[0]?.message ?? 'Send the scenario as JSON.');
  const { note_mode, regenerate, ...scenarioReq } = parsed.data;
  if (scenarioReq.strategy === 'single_vendor' && !scenarioReq.vendor) throw new ApiError(400, 'bad_request', 'Pick a vendor for a single vendor award.');
  if (scenarioReq.strategy === 'split_cap' && scenarioReq.max_share == null) throw new ApiError(400, 'bad_request', 'Set the largest share one vendor may hold for a split award.');

  const pool = db();
  const data = await loadAnalystData(pool);
  let pack;
  try {
    pack = buildPack(data, scenarioReq);
  } catch (e) {
    if (e instanceof AwardError) throw new ApiError(400, 'scenario_not_possible', e.message);
    throw e;
  }

  // The note: one model call at most, and only when asked for and admitted. Otherwise the labelled template.
  const note = await resolveNote(pack, {
    mode: note_mode,
    regenerate,
    admit: async () => {
      const gate = await admitModelCall(pool, req, 'decision');
      return gate.ok ? { ok: true } : { ok: false, message: gate.message };
    },
    deps: { call: { client: { complete: (r) => realClient().complete(r) }, store: pgStore(pool), dailyCapInr: env().DAILY_SPEND_CAP_INR, log: (l) => console.log(l) }, model: env().MODEL_ANALYST, budgetSession: budgetSessionId(), route: 'api:decision' },
  });

  const summary = {
    scenario_text: pack.scenario_text,
    readiness: { label: pack.readiness.label, summary: pack.readiness.summary, blockers: pack.readiness.blockers.length, open_items: pack.readiness.open_items.length },
    goods_total_inr: pack.result.totals.goods_total_inr,
    landed_total_inr: pack.result.totals.landed_total_inr,
    landed_complete: pack.result.totals.landed_complete,
    savings_vs_ly_inr: pack.result.totals.savings_vs_ly_inr,
    lines_awarded: pack.result.totals.lines_awarded,
    lines_total: pack.result.totals.lines_total,
  };
  const noteOut = { text: note.text, source: note.source, label: note.label, check: note.check, fallback: note.fallback, model: note.model, cost_inr: note.cost_inr, cache_hit: note.cache_hit };

  // A model note that failed its check is shown with a warning and no files. The buyer chooses what happens next.
  if (note.source === 'model' && !note.check.ok) {
    log('warn', 'decision_note_check_failed', { reasons: note.check.reasons.map((r) => r.slice(0, 120)) });
    return { ok: true, needs_choice: true, summary, note: noteOut, files: null };
  }

  // FR-8.2: refuse to produce a memo that hides an assumption or an unresolved item.
  const blocks = memoBlocks(pack, note);
  const missing = missingFromMemo(blocks, requiredMemoStrings(pack));
  if (missing.length > 0) {
    log('error', 'decision_memo_incomplete', { missing: missing.length, first: missing[0]?.slice(0, 80), text_chars: blocksText(blocks).length });
    throw new ApiError(500, 'memo_incomplete', 'The memo was not produced because it would leave out an assumption or an open item. Nothing was downloaded. Try again, and tell the builder if it repeats.');
  }
  const now = new Date(pack.generated_at);
  const pdf = await renderMemo(blocks, {
    title: `Award decision memo, ${pack.rfx.title}`, subject: pack.scenario_text, header: `${pack.rfx.title}. ${pack.generated_on}`,
    footer: `Draft for approval. INR excluding GST. ${pack.readiness.label}. Scenario: ${pack.slug}.`, now,
  });
  const xlsx = await buildAppendix(pack, note);
  if (pdf.byteLength + xlsx.byteLength > MAX_RESPONSE_BYTES) throw new ApiError(413, 'too_large', 'The pack is larger than a download can carry here. Narrow the scenario and try again.');
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  return {
    ok: true,
    needs_choice: false,
    summary,
    note: noteOut,
    files: {
      memo: { filename: `QuoteDesk_Decision_Memo_${pack.slug}.pdf`, mime: 'application/pdf', bytes: pdf.byteLength, base64: b64(pdf) },
      appendix: { filename: `QuoteDesk_Decision_Appendix_${pack.slug}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: xlsx.byteLength, base64: b64(xlsx) },
    },
  };
});
