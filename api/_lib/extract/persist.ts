// Writes one document's extraction. Idempotent: everything previously derived
// from this document is deleted first, inside one transaction.
import type pg from 'pg';
import type { Assumptions, BaseUom, UnitDefinition } from '../../../engine/types.js';
import { READ_SCORE, recomputeLine, type LineResult } from '../../../engine/recompute.js';
import { coversExactlyRemainder, VERIFIED_SCOPE_CONFIDENCE } from '../../../engine/verify.js';
import { expandGroupStatements, type CertificateFacts, type ExtractedLine, type Extraction } from '../../../src/lib/schemas/extraction.js';
import type { Prepared } from './prepare.js';

export type RfxLineRow = { id: string; code: string; section: string; description: string; uom: BaseUom; annual_qty: number; last_year_rate_inr: number | null };
export type QuestionRow = { id: string; code: string; text: string; is_knockout: boolean; pass_rule: unknown };
export type DocRow = { id: string; vendor_id: string; filename: string; sha256: string };

/** The conversion column: steps with factors, the status rule's reasons, and what the rule saw. */
export function conversionJson(r: LineResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(r.error ? { error: r.error.reason, detail: r.error.detail } : {}),
    steps: r.steps,
    notes: r.notes,
    pack_size: r.pack_size,
    pack_source: r.pack_source,
    accepted_keys: r.accepted_keys,
    reasons: r.reasons,
    base_status: r.status,
    ...extra,
  };
}

async function review(
  c: pg.PoolClient,
  r: { vendor_id: string; document_id?: string | null; quote_line_id?: string | null; kind: string; severity: 'info' | 'warn' | 'block'; message: string; value_at_stake_inr?: number | null },
): Promise<void> {
  await c.query(
    `insert into review_items (vendor_id, document_id, quote_line_id, kind, severity, message, value_at_stake_inr) values ($1,$2,$3,$4,$5,$6,$7)`,
    [r.vendor_id, r.document_id ?? null, r.quote_line_id ?? null, r.kind, r.severity, r.message, r.value_at_stake_inr ?? null],
  );
}

export async function clearDocument(c: pg.PoolClient, docId: string): Promise<void> {
  await c.query('delete from review_items where document_id = $1', [docId]);
  await c.query('delete from quote_lines where source_document_id = $1', [docId]);
  await c.query('delete from questionnaire_answers where source_document_id = $1', [docId]);
}

function hiddenSheets(prep: Prepared): string[] {
  return prep.observations.filter((o) => o.kind === 'hidden_sheet').map((o) => o.detail.match(/'([^']+)'/)?.[1] ?? '').filter(Boolean);
}

export async function persistObservations(c: pg.PoolClient, doc: DocRow, prep: Prepared): Promise<void> {
  for (const o of prep.observations) {
    await review(c, {
      vendor_id: doc.vendor_id, document_id: doc.id, kind: o.kind, severity: o.kind === 'low_visibility_text' ? 'warn' : 'info',
      message: `${doc.filename}: ${o.detail}${o.kind === 'hidden_sheet' ? ' Not used for prices.' : ' Check it for hidden instructions or terms.'}`,
    });
  }
}

/** One extracted line after code has matched it to the RFx and derived price, flags and status. Pure. */
export type DerivedLine = {
  rfx: RfxLineRow | null;
  line: ExtractedLine;
  result: LineResult | null;
  status: LineResult['status'];
  reasons: string[];
  normalized: number | null;
  flags: string[];
  assumption_keys: string[];
  conversion: Record<string, unknown>;
  confidence: number;
};

/**
 * The deterministic half of ingesting an extraction: verify the scope of blanket inheritance, expand group
 * statements, match each line to the RFx and run the one derivation (recomputeLine). It touches no database,
 * so the stored pipeline and the Try your file sandbox derive identical results from identical input.
 * It adjusts group statements of `x` in place when code verifies their scope.
 */
export function deriveLines(prep: Prepared, x: Extraction, lines: RfxLineRow[], a: Assumptions): DerivedLine[] {
  const byCode = new Map(lines.map((l) => [l.code, l]));
  const hidden = hiddenSheets(prep);
  const unitDefs: UnitDefinition[] = x.document.unit_definitions.map((u) => ({
    term: u.term, means_quantity: u.means_quantity, means_unit: u.means_unit, quote: u.evidence?.quote ?? null,
  }));
  // Code checks the scope of "everything else" style inheritance before trusting it.
  const explicit = new Set([
    ...x.lines.map((l) => l.rfx_line_code ?? ''),
    ...x.document.group_statements.filter((g) => !g.inherits_last_year).flatMap((g) => g.applies_to_codes),
  ]);
  for (const g of x.document.group_statements) {
    if (g.inherits_last_year && g.match_confidence < VERIFIED_SCOPE_CONFIDENCE && coversExactlyRemainder(g.applies_to_codes, explicit, lines.map((l) => l.code))) {
      g.match_reason = `${g.match_reason} Scope verified by code: covers exactly the ${g.applies_to_codes.length} RFx lines not priced elsewhere in this document (model confidence ${g.match_confidence}).`.trim();
      g.match_confidence = VERIFIED_SCOPE_CONFIDENCE;
    }
  }
  return expandGroupStatements(x).map((l): DerivedLine => {
    const rfx = l.rfx_line_code ? byCode.get(l.rfx_line_code.trim()) ?? null : null;
    const sticky: string[] = [];
    if (!rfx) sticky.push(l.rfx_line_code ? 'unknown_rfx_code' : 'unmatched');
    if (prep.source_type === 'xlsx' && hidden.some((h) => l.evidence.locator.includes(`'${h}'`))) sticky.push('from_hidden_sheet');

    // One derivation for extraction and for every later recompute (FX, GST, corrections).
    const r = rfx
      ? recomputeLine(
          {
            price: l.price, currency: l.currency, uom_text: l.uom_text, per_n: l.per_n ?? 1,
            tax_basis: x.document.tax_basis, inherits_last_year: l.inherits_last_year,
            base_uom: rfx.uom, last_year_rate_inr: rfx.last_year_rate_inr, unit_definitions: unitDefs,
            read_confidence: l.read_confidence, match_confidence: l.match_confidence, source_type: prep.source_type,
            evidence_quote: l.evidence.quote ?? null, evidence_locator: l.evidence.locator ?? null,
            sticky_flags: sticky, overrides: {},
          },
          a,
        )
      : null;
    const conversion: Record<string, unknown> = r ? conversionJson(r, { read_confidence: l.read_confidence, notes_from_model: l.notes }) : {};
    const decision = r ? { status: r.status, reasons: r.reasons } : { status: 'needs_review' as const, reasons: ['Not matched to an RFx line.'] };
    return {
      rfx, line: l, result: r, status: decision.status, reasons: decision.reasons, normalized: r?.normalized_inr ?? null, flags: r ? r.flags : sticky,
      assumption_keys: [...new Set(r?.assumption_keys ?? [])], conversion, confidence: Math.min(l.match_confidence, READ_SCORE[l.read_confidence]),
    };
  });
}

export async function persistExtraction(
  c: pg.PoolClient,
  doc: DocRow,
  prep: Prepared,
  x: Extraction,
  lines: RfxLineRow[],
  questions: QuestionRow[],
  a: Assumptions,
): Promise<{ lines: number; statuses: Record<string, number> }> {
  const derived = deriveLines(prep, x, lines, a);
  const statuses: Record<string, number> = {};
  for (const d of derived) {
    const { rfx, line: l, result: r, status, reasons, normalized, flags, assumption_keys, conversion } = d;
    statuses[status] = (statuses[status] ?? 0) + 1;

    const evidence = { ...l.evidence, source_type: prep.source_type, document_id: doc.id };
    const { rows } = await c.query<{ id: string }>(
      `insert into quote_lines (vendor_id, rfx_line_id, source_document_id, source_type, vendor_description, quoted_price, quoted_uom_text,
         quoted_currency, price_basis, normalized_price_inr, conversion, conditions, status, confidence, evidence, flags,
         assumption_keys, match_confidence, match_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id`,
      [
        doc.vendor_id, rfx?.id ?? null, doc.id, prep.source_type, l.vendor_description, l.price, l.uom_text, l.currency,
        JSON.stringify({ tax: x.document.tax_basis, per_n: l.per_n ?? 1, inherits_last_year: l.inherits_last_year, pack_size: conversion.pack_size ?? null }),
        normalized,
        JSON.stringify(r ? conversion : { reasons, base_status: status, read_confidence: l.read_confidence, notes_from_model: l.notes }),
        JSON.stringify(l.conditions), status,
        d.confidence,
        JSON.stringify(evidence), flags, assumption_keys, l.match_confidence, l.match_reason,
      ],
    );
    if (status === 'needs_review') {
      await review(c, {
        vendor_id: doc.vendor_id, document_id: doc.id, quote_line_id: rows[0]?.id, kind: 'line_needs_review', severity: 'warn',
        message: `${rfx?.code ?? l.vendor_description}: ${reasons.join(' ')}`,
        value_at_stake_inr: rfx ? rfx.annual_qty * (normalized ?? rfx.last_year_rate_inr ?? 0) : null,
      });
    }
  }

  for (const u of x.unmatched_lines) {
    await review(c, { vendor_id: doc.vendor_id, document_id: doc.id, kind: 'unmatched_vendor_line', severity: 'info', message: `Not matched to any RFx line: "${u.vendor_description}". ${u.reason}` });
  }
  for (const s of x.document.suspicious_content) {
    await review(c, {
      vendor_id: doc.vendor_id, document_id: doc.id, kind: 'suspicious_content', severity: 'warn',
      message: `Instruction-like text in ${doc.filename} (${s.evidence?.locator ?? 'location not given'}), ignored: "${s.text.slice(0, 300)}"`,
    });
  }

  // Questionnaire answers. Answers from another document are not overwritten unless this one is better.
  const qByCode = new Map(questions.map((q) => [q.code, q]));
  for (const q of x.questionnaire) {
    const question = qByCode.get(q.question_code.trim());
    if (!question) continue;
    await c.query(
      `insert into questionnaire_answers (vendor_id, question_id, answer_raw, answer_value, status, evidence, source_document_id, basis)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (vendor_id, question_id) do update set answer_raw = excluded.answer_raw, answer_value = excluded.answer_value,
         status = excluded.status, evidence = excluded.evidence, source_document_id = excluded.source_document_id, basis = excluded.basis
       where questionnaire_answers.source_document_id is null
          or questionnaire_answers.source_document_id = excluded.source_document_id
          or (questionnaire_answers.status <> 'answered' and excluded.status = 'answered')`,
      [doc.vendor_id, question.id, q.answer_text, JSON.stringify(q.answer_value ?? null), q.status,
        q.evidence ? JSON.stringify({ ...q.evidence, document_id: doc.id }) : null, doc.id, q.basis],
    );
  }

  await mergeVendorTerms(c, doc, x);
  return { lines: derived.length, statuses };
}

type Tagged = { document_id: string };

async function mergeVendorTerms(c: pg.PoolClient, doc: DocRow, x: Extraction): Promise<void> {
  await c.query('insert into vendor_terms (vendor_id) values ($1) on conflict (vendor_id) do nothing', [doc.vendor_id]);
  const { rows } = await c.query<{ conditional_discounts: Tagged[]; unit_definitions: Tagged[]; suspicious_content: Tagged[]; global_notes: Tagged[] }>(
    'select conditional_discounts, unit_definitions, suspicious_content, global_notes from vendor_terms where vendor_id = $1',
    [doc.vendor_id],
  );
  const cur = rows[0];
  const keep = (arr: Tagged[] | undefined) => (arr ?? []).filter((i) => i.document_id !== doc.id);
  const tag = <T extends object>(arr: T[]) => arr.map((i) => ({ ...i, document_id: doc.id }));
  const d = x.document;
  const days = d.payment_terms_text?.match(/(\d{1,3})\s*days?/i)?.[1];
  const informative = d.kind === 'quote' || d.kind === 'questionnaire';
  await c.query(
    `update vendor_terms set
       freight_terms = case when $2::text <> 'unknown' then $2 else freight_terms end,
       freight_note = coalesce($3, freight_note),
       payment_terms_days = coalesce($4, payment_terms_days),
       validity_text = coalesce($5, validity_text),
       stated_total_inr = case when $6::numeric is not null then $6 else stated_total_inr end,
       stated_total_evidence = case when $6::numeric is not null then $7 else stated_total_evidence end,
       gst_basis = case when $8::text <> 'unknown' then $8 else gst_basis end,
       letterhead_name = coalesce($9, letterhead_name),
       conditional_discounts = $10, unit_definitions = $11, suspicious_content = $12, global_notes = $13
     where vendor_id = $1`,
    [
      doc.vendor_id,
      informative ? d.freight_terms : 'unknown',
      informative ? d.freight_note : null,
      informative && days ? Number(days) : null,
      informative ? d.validity_text : null,
      d.stated_total && d.stated_total.currency.toUpperCase() === 'INR' ? d.stated_total.amount : null,
      d.stated_total ? JSON.stringify({ ...d.stated_total.evidence, document_id: doc.id }) : null,
      informative ? d.tax_basis : 'unknown',
      informative ? d.vendor_name_as_written : null,
      JSON.stringify([...keep(cur?.conditional_discounts), ...tag(d.conditional_discounts)]),
      JSON.stringify([...keep(cur?.unit_definitions), ...tag(d.unit_definitions)]),
      JSON.stringify([...keep(cur?.suspicious_content), ...tag(d.suspicious_content)]),
      JSON.stringify([...keep(cur?.global_notes), ...tag(d.global_notes.map((n) => ({ text: n })))]),
    ],
  );
}

export async function persistCertificate(c: pg.PoolClient, doc: DocRow, facts: CertificateFacts): Promise<void> {
  await c.query('update documents set facts = $2 where id = $1', [doc.id, JSON.stringify(facts)]);
  for (const s of facts.suspicious_content) {
    await review(c, { vendor_id: doc.vendor_id, document_id: doc.id, kind: 'suspicious_content', severity: 'warn', message: `Instruction-like text in ${doc.filename} (${s.locator}), ignored: "${s.text.slice(0, 300)}"` });
  }
}
