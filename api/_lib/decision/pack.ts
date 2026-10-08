// The decision pack's data. Built from the same comparison payload and award engine as the Decision
// page and the analyst, so a memo can never disagree with the screen. No model is involved here.
//
// FR-8.2 is enforced in two places. `requiredMemoStrings` lists everything the memo must print
// (every assumption used, every unresolved item), and the route refuses to return a memo whose
// text is missing one. The strings are the exact paragraphs the memo prints.
import { z } from 'zod';
import { DEFAULT_SCENARIO, simulateAward, type AwardResult, type Scenario } from '../../../engine/award.js';
import type { CellStatus } from '../../../engine/certainty.js';
import { STATUS_LABEL, toCellStatus } from '../../../engine/certainty.js';
import { runSensitivity, type Sensitivity } from '../../../engine/decision.js';
import { assumptionText, flagText } from '../../../engine/explain.js';
import { formatIndian, formatInrCompact } from '../../../engine/format.js';
import type { ScenarioReadiness } from '../../../engine/readiness.js';
import type { Assumptions } from '../../../engine/types.js';
import type { AnswerCell, Attachment } from '../../../src/lib/api-types.js';
import { awardInputFromCompare, globalAssumptionsOf, safeMessage } from '../../../src/lib/awardInput.js';
import type { AnalystData } from '../analyst/data.js';
import { describeScenario } from '../analyst/tools.js';

// ---------------------------------------------------------------- request

export const PackRequestSchema = z.object({
  strategy: z.enum(['single_vendor', 'cheapest_per_line', 'split_cap', 'cheapest_per_section']),
  /** Cleared vendors only unless true. True also admits vendors whose knockouts are undecided (Pending). Failed vendors are never admitted. */
  include_pending: z.boolean().default(false),
  apply_discounts: z.boolean().default(false),
  /** Confirmed only, or Confirmed and Assumed. */
  price_basis: z.enum(['confirmed', 'confirmed_assumed']).default('confirmed_assumed'),
  /** Vendor key such as "V1", for the single vendor strategy. */
  vendor: z.string().max(10).nullish(),
  /** Largest share any vendor may hold (0.6 means 60 percent), for the split cap strategy. */
  max_share: z.number().gt(0).lte(1).nullish(),
  /** The buyer's own words on why. Printed in the memo, never sent to a model. */
  buyer_note: z.string().trim().max(600).optional(),
});
export type PackRequest = z.infer<typeof PackRequestSchema>;

export const noteModeSchema = z.enum(['model', 'template']);
export type NoteMode = z.infer<typeof noteModeSchema>;

export function scenarioFromRequest(r: PackRequest): Scenario {
  return {
    strategy: r.strategy,
    filters: {
      eligibility: r.include_pending ? 'cleared_and_pending' : 'cleared',
      exclude_vendors: [],
      include_vendors: null,
      apply_discounts: r.apply_discounts,
      price_basis: r.price_basis,
    },
    constraints: { vendor: r.strategy === 'single_vendor' ? (r.vendor ?? null) : null, max_share: r.strategy === 'split_cap' ? (r.max_share ?? null) : null },
  };
}

export const STRATEGY_NAME: Record<Scenario['strategy'], string> = {
  single_vendor: 'Single vendor',
  cheapest_per_line: 'Cheapest per line',
  split_cap: 'Split with a share cap',
  cheapest_per_section: 'Cheapest per section',
};

const STRATEGY_RULE: Record<Scenario['strategy'], string> = {
  single_vendor: 'Every line goes to one named vendor.',
  cheapest_per_line: 'Each line goes to the lowest priced eligible vendor.',
  split_cap: 'Each line goes to the lowest priced eligible vendor, then lines move until no vendor holds more than the share cap. The search is greedy and not proven to be the cheapest split.',
  cheapest_per_section: 'Each section goes to the one eligible vendor who quoted every line in it and is cheapest overall. A section nobody fully quoted is awarded line by line.',
};

/** A file name part, for example cheapest-per-line_cleared-only_with-discounts. */
export function scenarioSlug(s: Scenario): string {
  const parts = [
    s.strategy.replaceAll('_', '-') + (s.strategy === 'single_vendor' && s.constraints.vendor ? `-${s.constraints.vendor.toLowerCase()}` : '') + (s.strategy === 'split_cap' && s.constraints.max_share ? `-${Math.round(s.constraints.max_share * 100)}` : ''),
    s.filters.eligibility === 'cleared' ? 'cleared-only' : 'incl-pending',
    s.filters.price_basis === 'confirmed' ? 'confirmed-prices' : null,
    s.filters.apply_discounts ? 'with-discounts' : null,
  ];
  return parts.filter(Boolean).join('_');
}

// ---------------------------------------------------------------- formats

/** Rupee amount with Indian grouping and no symbol that a standard PDF font cannot draw. */
export const rs = (v: number, d = 2): string => `Rs ${formatIndian(v, d)}`;
/** Rupee amount in lakh or crore for headlines. */
export const rsCompact = (v: number): string => formatInrCompact(v).replace('₹', 'Rs ');

function istDateLabel(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

// ---------------------------------------------------------------- types

export type TextItem = { text: string };
export type AssumptionLine = TextItem & { key: string; label: string; value: string; set_by: 'system' | 'buyer' };
export type AppliedAssumption = TextItem & { vendor_key: string; key: string; lines: string[]; annual_value_inr: number };
export type UnconfirmedCell = TextItem & { vendor_key: string; line_code: string; status: CellStatus; awarded: boolean; annual_value_inr: number };
export type RiskItem = TextItem & { vendor_key: string | null; kind: string; severity: 'info' | 'warn' | 'block'; value_at_stake_inr: number | null };
export type FlagItem = TextItem & { vendor_key: string; flag: string; lines: string[] };
export type CertificateItem = TextItem & {
  vendor_key: string; filename: string; standard: string | null; number: string | null; legal_name: string | null; expiry: string | null;
  state: 'valid' | 'expires_soon' | 'expired' | 'no_expiry'; flags: string[]; in_award: boolean;
};
export type ExcludedVendor = TextItem & { vendor_key: string; name: string; questionnaire: string | null; lines_cheaper: number; saving_if_taken_inr: number };
export type NextStep = TextItem & { vendor_key: string | null; kind: string; blocking: boolean };

export type QuestionnaireMatrix = {
  vendors: { key: string; name: string; result: string }[];
  questions: { code: string; text: string; is_knockout: boolean; rule_text: string | null; cells: Record<string, { summary: string; status: string; outcome: string | null; reason: string | null }> }[];
};

export type PackData = {
  generated_at: string;
  generated_on: string;
  rfx: { title: string; buyer_org: string; ref: string | null };
  scenario: Scenario;
  scenario_text: string;
  slug: string;
  assumptions: Assumptions;
  rationale: string[];
  buyer_note: string | null;
  result: AwardResult;
  readiness: ScenarioReadiness;
  /** Notes from the award engine, for example a share cap that could not be met. */
  warnings: string[];
  descriptions: Record<string, string>;
  vendor_info: { key: string; name: string; location: string | null; payment_terms_days: number | null; freight: string; coverage: string; stated_total_inr: number | null }[];
  sensitivity: Sensitivity;
  questionnaire: QuestionnaireMatrix;
  risk: {
    global_assumptions: AssumptionLine[];
    applied_assumptions: AppliedAssumption[];
    unconfirmed_cells: UnconfirmedCell[];
    unresolved: RiskItem[];
    flags: FlagItem[];
    certificates: CertificateItem[];
    excluded_vendors: ExcludedVendor[];
    coverage_gaps: TextItem[];
  };
  next_steps: NextStep[];
};

// ---------------------------------------------------------------- pieces

const ASSUMPTION_LABEL: Record<string, string> = {
  usd_inr: 'Priced in USD, no rate stated by the vendor',
  gst_pct: 'Quoted including GST',
  pack_size: 'Pack size taken from the vendor note',
  last_year_inheritance: 'Same as last year, no price stated',
  tax_basis_assumed_excl: 'GST basis not stated',
  photo_read: 'Read from a photo, not yet checked by a person',
  unspecified: 'Assumed, reason not recorded',
};

/** What to do about an assumption the award relies on, worded as an action. */
function assumptionStep(key: string, vendor: string, n: number): string {
  const lines = `${n} ${n === 1 ? 'line' : 'lines'}`;
  switch (key) {
    case 'usd_inr': return `Ask ${vendor} for its USD to INR rate in writing, or agree one, for its ${lines} priced in US dollars.`;
    case 'last_year_inheritance': return `Ask ${vendor} to confirm in writing that last year's price holds for its ${lines} priced as the same as last year.`;
    case 'pack_size': return `Ask ${vendor} to confirm in writing what one pack holds for its ${lines} quoted per pack.`;
    case 'photo_read': return `Check the photo crop for ${vendor}'s ${lines} and accept each price, or ask the vendor to confirm in writing.`;
    case 'tax_basis_assumed_excl': return `Ask ${vendor} to confirm that its prices exclude GST (${lines}).`;
    case 'gst_pct': return `Ask ${vendor} to confirm the GST rate behind its ${lines} quoted including GST.`;
    default: return `Confirm with ${vendor} in writing: ${(ASSUMPTION_LABEL[key] ?? key.replaceAll('_', ' ')).toLowerCase()} (${lines}).`;
  }
}

const KIND_NEXT_STEP: Record<string, string> = {
  freight_amount_unknown: 'Get the freight amount in writing, or agree who pays it, before the PO. Until then the landed total is a floor.',
  freight_terms_unknown: 'Confirm whether freight is included or extra.',
  total_mismatch: 'Ask the vendor which is right, the stated total or the sum of its lines, and get a corrected quote.',
  knockout_failed: 'This vendor failed a knockout question. Do not award to it without a documented exception.',
  knockout_pending: 'Get the missing knockout answer from the vendor and re-run the questionnaire check.',
  certificate_expired: 'Ask for a renewed certificate before any award.',
  attachment_name_mismatch: 'Check which legal entity will invoice and whether the certificate belongs to it.',
  suspicious_content: 'Read the flagged vendor document. Instruction-like text in it was ignored, and the vendor should be asked about it.',
  low_visibility_text: 'Read the flagged vendor document. Hidden or near invisible text in it was ignored, and the vendor should be asked about it.',
  line_needs_review: 'Check the cell against the source in the review queue and accept, edit or mark it not quoted.',
  conflict: 'Two sources disagree. Choose which one is right in the review queue.',
  extraction_failed: 'Re run the extraction for the failed document, or read it by hand.',
};

function vendorLabel(key: string, name: string | undefined): string {
  return name ? `${key} ${name}` : key;
}

function sentenceCase(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function certState(expiry: string | null, now: Date): CertificateItem['state'] {
  if (!expiry) return 'no_expiry';
  const e = new Date(`${expiry}T00:00:00+05:30`);
  if (Number.isNaN(e.getTime())) return 'no_expiry';
  const days = (e.getTime() - now.getTime()) / 86_400_000;
  return days < 0 ? 'expired' : days <= 90 ? 'expires_soon' : 'valid';
}

function answerSummary(a: AnswerCell | null): { summary: string; status: string; outcome: string | null; reason: string | null } {
  if (!a) return { summary: '', status: 'unanswered', outcome: null, reason: null };
  const raw = (a.raw ?? '').replace(/\s+/g, ' ').trim();
  return { summary: raw.length > 140 ? `${raw.slice(0, 140)}...` : raw, status: a.status, outcome: a.outcome?.outcome ?? null, reason: a.outcome?.reason ?? null };
}

/** The discount and the allocation depend on each other; say how it settled, in memo words. */
function fixedPointText(r: AwardResult): string {
  const fp = r.fixed_point;
  const ok = fp.tried.filter((t) => t.converged);
  const distinct = ok.length > 1 && JSON.stringify(ok[0]?.applied) !== JSON.stringify(ok[1]?.applied);
  if (distinct) return `Two consistent answers exist, ${rs(ok[0]!.total_goods_inr, 0)} and ${rs(ok[1]!.total_goods_inr, 0)}. The cheaper one is used.`;
  return fp.note;
}

// ---------------------------------------------------------------- builder

export function buildPack(data: AnalystData, req: PackRequest, now: Date = new Date()): PackData {
  const c = data.compare;
  const a = globalAssumptionsOf(c);
  const scenario = scenarioFromRequest(req);
  const makeInput = (x: Assumptions) => awardInputFromCompare(c, x, data.items);
  const result = simulateAward(makeInput(a), scenario);
  const sensitivity = runSensitivity(makeInput, a, scenario, result);
  const readiness = result.readiness;
  const vName = new Map(c.vendors.map((v) => [v.key, v.name]));
  const vById = new Map(c.vendors.map((v) => [v.id, v]));
  const lineByCode = new Map(c.lines.map((l) => [l.code, l]));
  const lineById = new Map(c.lines.map((l) => [l.id, l]));
  const included = new Set(readiness.included_vendors);
  const awardedKeys = new Set(result.by_vendor.map((v) => v.vendor_key));
  const derivedCells = awardInputFromCompare(c, a, data.items).cells;

  // Rationale: plain sentences built from the scenario and the result.
  const left = result.vendors_considered.filter((v) => !v.eligible);
  const whyLeft = (v: (typeof left)[number]): string => (v.questionnaire === 'Failed' ? 'failed a knockout' : v.questionnaire === 'Pending' ? 'a knockout is undecided' : v.reason.replace(/\.$/, ''));
  const rationale: string[] = [
    `${STRATEGY_NAME[scenario.strategy]}. ${STRATEGY_RULE[scenario.strategy]}`,
    `${result.eligibility_label}${left.length ? ` Left out: ${left.map((v) => `${v.vendor_key} (${whyLeft(v)})`).join('; ')}.` : ''}`,
    scenario.filters.price_basis === 'confirmed' ? 'Only Confirmed prices are used. An Assumed price never decides a line.' : 'Confirmed and Assumed prices are used. Needs review and Conflict prices never decide a line.',
    scenario.filters.apply_discounts
      ? `Conditional discounts are applied only where the vendor's allocation, as one PO, meets its threshold. ${fixedPointText(result)}`
      : 'Conditional discounts are not applied. They are listed in the sensitivity section.',
    `The result awards ${result.totals.lines_awarded} of ${result.totals.lines_total} lines to ${result.concentration.vendor_count} ${result.concentration.vendor_count === 1 ? 'vendor' : 'vendors'} at ${rsCompact(result.totals.goods_total_inr)} excluding GST${result.totals.landed_complete ? '' : ' before freight that is still unknown'}.`,
    ...result.excluded_cheaper.map(
      (e) => `${e.vendor_key} is cheaper on ${e.lines_cheaper} ${e.lines_cheaper === 1 ? 'line' : 'lines'}, worth up to ${rsCompact(e.saving_if_taken_inr)} if taken, and is left out (${whyLeft(left.find((l) => l.vendor_key === e.vendor_key) ?? ({ questionnaire: null, reason: e.reason } as never))}). This is an upper bound that ignores that vendor's freight, discounts and risk.`,
    ),
  ];

  // Global assumptions in force.
  const globalAssumptions: AssumptionLine[] = c.assumptions.map((x) => {
    const value = x.key === 'usd_inr' ? `INR ${x.value} per USD` : x.key === 'gst_pct' ? `${x.value} percent` : String(x.value);
    return { key: x.key, label: x.label, value, set_by: x.set_by, text: `${x.label}: ${value}. Set by ${x.set_by === 'buyer' ? 'the buyer' : 'the system default'}.${x.note ? ` ${x.note}` : ''}` };
  });

  // Assumptions used: grouped per vendor and assumption, with every awarded line named.
  const awardedRows = result.allocation.filter((r) => r.vendor_key);
  const groups = new Map<string, { vendor_key: string; key: string; lines: string[]; value: number }>();
  for (const r of awardedRows) {
    if (!r.vendor_key || !r.status) continue;
    const st = toCellStatus(r.status);
    if (st !== 'assumed') continue;
    const cell = c.cells.find((x) => x.quote_line_id === r.quote_line_id);
    const keys = cell?.assumption_keys?.length ? cell.assumption_keys : [cell?.source_type === 'image' && !cell.buyer_verified ? 'photo_read' : 'unspecified'];
    for (const k of keys) {
      const g = groups.get(`${r.vendor_key}|${k}`) ?? { vendor_key: r.vendor_key, key: k, lines: [], value: 0 };
      g.lines.push(r.line_code);
      g.value += r.annual_value_inr ?? 0;
      groups.set(`${r.vendor_key}|${k}`, g);
    }
  }
  const applied: AppliedAssumption[] = [...groups.values()]
    .sort((x, y) => x.vendor_key.localeCompare(y.vendor_key) || y.value - x.value)
    .map((g) => {
      const long = g.key === 'photo_read' ? 'Photo values are never confirmed automatically. A person should check the crop and accept it.' : g.key === 'unspecified' ? 'The price is Assumed. See the evidence drawer for the cell.' : assumptionText(g.key, a);
      return {
        vendor_key: g.vendor_key, key: g.key, lines: g.lines, annual_value_inr: g.value,
        text: `${vendorLabel(g.vendor_key, vName.get(g.vendor_key))}, ${ASSUMPTION_LABEL[g.key] ?? g.key.replaceAll('_', ' ')}: ${g.lines.length} awarded ${g.lines.length === 1 ? 'line' : 'lines'} (${g.lines.join(', ')}), ${rs(g.value, 0)} a year. ${long}`,
      };
    });

  // Cells that are not settled: Needs review and Conflict for every included vendor, awarded or not.
  const unconfirmed: UnconfirmedCell[] = [];
  const awardedSet = new Set(awardedRows.map((r) => `${r.vendor_key}|${r.line_code}`));
  for (const cell of derivedCells) {
    const v = vById.get(cell.vendor_id);
    const l = lineById.get(cell.line_id);
    if (!v || !l || !included.has(v.key) || cell.price == null) continue;
    const st = toCellStatus(cell.status);
    if (st !== 'needs_review' && st !== 'conflict') continue;
    const value = cell.price * l.annual_qty;
    const awarded = awardedSet.has(`${v.key}|${l.code}`);
    unconfirmed.push({
      vendor_key: v.key, line_code: l.code, status: st, awarded, annual_value_inr: value,
      text: `${v.key} ${l.code}: ${STATUS_LABEL[st]}, ${rs(value, 0)} a year at annual quantity. ${awarded ? 'The award relies on this price.' : 'The award does not use this price, but it would change the result if taken as read.'}`,
    });
  }
  unconfirmed.sort((x, y) => y.annual_value_inr - x.annual_value_inr);

  // Every open review item for a vendor that is eligible in this scenario, with the readiness lines on top.
  const unresolved: RiskItem[] = [];
  const seen = new Set<string>();
  const push = (r: RiskItem) => {
    const k = `${r.vendor_key}|${r.kind}|${r.text}`;
    if (seen.has(k)) return;
    seen.add(k);
    unresolved.push(r);
  };
  for (const b of readiness.blockers) push({ vendor_key: b.vendor_key, kind: b.kind, severity: 'block', value_at_stake_inr: null, text: `${b.vendor_key}: ${b.message}` });
  for (const o of readiness.open_items) push({ vendor_key: o.vendor_key, kind: o.kind, severity: 'warn', value_at_stake_inr: null, text: `${o.vendor_key ? `${o.vendor_key}: ` : ''}${o.message}` });
  for (const i of data.items) {
    const v = vById.get(i.vendor_id);
    if (!v || !included.has(v.key)) continue;
    push({ vendor_key: v.key, kind: i.kind, severity: i.severity, value_at_stake_inr: i.value_at_stake_inr, text: `${v.key}: ${safeMessage(i.kind, i.message)}${i.line_code ? ` (${i.line_code})` : ''}` });
  }

  // Flags on the cells the award relies on.
  const flagGroups = new Map<string, { vendor_key: string; flag: string; lines: string[] }>();
  for (const r of awardedRows) {
    if (!r.vendor_key) continue;
    const cell = c.cells.find((x) => x.quote_line_id === r.quote_line_id);
    for (const f of cell?.flags ?? []) {
      const g = flagGroups.get(`${r.vendor_key}|${f}`) ?? { vendor_key: r.vendor_key, flag: f, lines: [] };
      g.lines.push(r.line_code);
      flagGroups.set(`${r.vendor_key}|${f}`, g);
    }
  }
  const flags: FlagItem[] = [...flagGroups.values()].map((g) => ({
    vendor_key: g.vendor_key, flag: g.flag, lines: g.lines,
    text: `${g.vendor_key}, ${g.lines.length} awarded ${g.lines.length === 1 ? 'line' : 'lines'} (${g.lines.join(', ')}): ${flagText(g.flag)}`,
  }));

  // Certificates and attachment flags, for every vendor, with whether they are in the award.
  const certs: CertificateItem[] = [];
  for (const att of c.attachments as Attachment[]) {
    const v = vById.get(att.vendor_id);
    if (!v || (att.kind !== 'certificate' && !att.facts?.expiry_date)) continue;
    const f = att.facts ?? {};
    const state = certState(f.expiry_date ?? null, now);
    const what = f.standard ?? att.filename;
    const when = f.expiry_date ? `expires ${f.expiry_date}` : 'no expiry date read';
    const stateText = state === 'expired' ? 'EXPIRED' : state === 'expires_soon' ? 'expires within 90 days' : state === 'valid' ? 'valid' : 'expiry not read';
    certs.push({
      vendor_key: v.key, filename: att.filename, standard: f.standard ?? null, number: f.certificate_number ?? null, legal_name: f.legal_name ?? null, expiry: f.expiry_date ?? null,
      state, flags: att.flags, in_award: awardedKeys.has(v.key),
      text: `${v.key} ${what}${f.certificate_number ? ` no. ${f.certificate_number}` : ''}: ${when} (${stateText})${f.legal_name ? `, legal name ${f.legal_name}` : ''}${att.flags.length ? `. Flags: ${att.flags.map((x) => x.replaceAll('_', ' ')).join(', ')}` : ''}. ${awardedKeys.has(v.key) ? 'Vendor is in this award.' : 'Vendor is not in this award.'}`,
    });
  }

  const excluded: ExcludedVendor[] = left.map((l) => {
    const ec = result.excluded_cheaper.find((e) => e.vendor_key === l.vendor_key);
    return {
      vendor_key: l.vendor_key, name: l.vendor_name, questionnaire: l.questionnaire, lines_cheaper: ec?.lines_cheaper ?? 0, saving_if_taken_inr: ec?.saving_if_taken_inr ?? 0,
      text: `${vendorLabel(l.vendor_key, l.vendor_name)} is not in this scenario. ${l.reason}${ec ? ` It is cheaper on ${ec.lines_cheaper} ${ec.lines_cheaper === 1 ? 'line' : 'lines'}, up to ${rs(ec.saving_if_taken_inr, 0)} a year, which is not available under these filters.` : ''}`,
    };
  });

  const gaps: TextItem[] = result.coverage_gaps.map((g) => ({
    text: `${g.line_code} (${lineByCode.get(g.line_code)?.description ?? g.section}) is not covered: ${g.reason}${g.quoted_by_ineligible.length ? ` Quoted only by vendors left out: ${g.quoted_by_ineligible.map((q) => `${q.vendor_key} at ${rs(q.price)}`).join(', ')}.` : ''}`,
  }));

  // Questionnaire matrix.
  const questionnaire: QuestionnaireMatrix = {
    vendors: c.vendors.map((v) => ({ key: v.key, name: v.name, result: v.questionnaire ?? 'Not read' })),
    questions: c.questions.map((q) => ({
      code: q.code, text: q.text, is_knockout: q.is_knockout, rule_text: q.rule_text,
      cells: Object.fromEntries(c.vendors.map((v) => [v.key, answerSummary(q.answers[v.id] ?? null)])),
    })),
  };

  // Next steps: one line per unresolved item, with what to do about it.
  const next: NextStep[] = unresolved
    // Aggregate lines are replaced by one specific step per assumption and per gap, below.
    .filter((u) => u.severity !== 'info' && u.kind !== 'assumed_cells' && u.kind !== 'coverage_gaps')
    .map((u) => ({
      vendor_key: u.vendor_key, kind: u.kind, blocking: u.severity === 'block',
      text: `${KIND_NEXT_STEP[u.kind] ?? sentenceCase(u.text.replace(/^V\d: /, ''))}${u.vendor_key ? ` (${u.vendor_key})` : ''}`,
    }));
  if (unconfirmed.some((u) => u.awarded)) next.push({ vendor_key: null, kind: 'line_needs_review', blocking: true, text: KIND_NEXT_STEP.line_needs_review as string });
  for (const g of applied) {
    next.push({ vendor_key: g.vendor_key, kind: `assumed_${g.key}`, blocking: false, text: assumptionStep(g.key, g.vendor_key, g.lines.length) });
  }
  for (const g of result.coverage_gaps) next.push({ vendor_key: null, kind: 'coverage_gap', blocking: false, text: `Decide how to buy ${g.line_code}, which no eligible vendor quoted.` });
  const seenStep = new Set<string>();
  const nextSteps = next.filter((n) => (seenStep.has(n.text) ? false : (seenStep.add(n.text), true)));

  const info = c.vendors.map((v) => ({
    key: v.key, name: v.name, location: v.location, payment_terms_days: v.payment_terms_days,
    freight: v.freight_terms === 'included' ? 'Included' : v.freight_terms === 'extra' ? (v.freight_amount_inr == null ? 'Extra, no amount stated' : `Extra, ${rs(v.freight_amount_inr, 0)}`) : 'Not stated',
    coverage: `${v.coverage.quoted} of ${v.coverage.total} lines`, stated_total_inr: v.stated_total_inr,
  }));

  return {
    generated_at: now.toISOString(),
    generated_on: istDateLabel(now),
    rfx: { title: c.rfx.title, buyer_org: c.rfx.buyer_org, ref: c.rfx.ref },
    scenario,
    scenario_text: describeScenario(scenario, {}),
    slug: scenarioSlug(scenario),
    assumptions: a,
    rationale,
    buyer_note: req.buyer_note ? req.buyer_note : null,
    result,
    readiness,
    warnings: result.warnings,
    descriptions: Object.fromEntries(c.lines.map((l) => [l.code, l.description])),
    vendor_info: info,
    sensitivity,
    questionnaire,
    risk: { global_assumptions: globalAssumptions, applied_assumptions: applied, unconfirmed_cells: unconfirmed, unresolved, flags, certificates: certs, excluded_vendors: excluded, coverage_gaps: gaps },
    next_steps: nextSteps,
  };
}

/** Every paragraph the memo must print (FR-8.2). The memo prints these exact strings. */
export function requiredMemoStrings(p: PackData): string[] {
  return [
    ...p.risk.global_assumptions.map((x) => x.text),
    ...p.risk.applied_assumptions.map((x) => x.text),
    ...p.risk.unconfirmed_cells.map((x) => x.text),
    ...p.risk.unresolved.map((x) => x.text),
    ...p.risk.flags.map((x) => x.text),
    ...p.risk.certificates.map((x) => x.text),
    ...p.risk.excluded_vendors.map((x) => x.text),
    ...p.risk.coverage_gaps.map((x) => x.text),
    ...p.warnings,
    ...p.next_steps.map((x) => x.text),
  ];
}

export { DEFAULT_SCENARIO };
