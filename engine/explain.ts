// Plain language reasons for a cell's status and flags. Deterministic text built
// from structured facts. No model is involved, so the explanation can be trusted
// to match the rule that actually decided the status.
import { STATUS_LABEL, toCellStatus } from './certainty';
import type { Assumptions, LineStatus, ReadConfidence, SourceType } from './types';

export type ExplainInput = {
  status: LineStatus | 'missing';
  source_type: SourceType | null;
  read_confidence: ReadConfidence | null;
  match_confidence: number | null;
  assumption_keys: string[];
  accepted_keys: string[];
  flags: string[];
  buyer_verified: boolean;
  pack_source: 'vendor' | 'buyer' | null;
  /** The sentences the status rule itself produced. */
  rule_reasons: string[];
};

const SOURCE_NAME: Record<SourceType, string> = {
  xlsx: 'a spreadsheet cell',
  pdf: 'a PDF',
  docx: 'a Word document',
  image: 'a photo',
  email: 'an email',
};

export function assumptionText(key: string, a: Assumptions): string {
  switch (key) {
    case 'usd_inr':
      return `The vendor quotes in US dollars and does not state a rate, so your assumed rate of USD 1 = INR ${a.usd_inr} is used.`;
    case 'gst_pct':
      return `The price was quoted including GST. It is converted to excluding GST at the assumed ${a.gst_pct} percent.`;
    case 'pack_size':
      return 'The quoted unit is a pack. The pack size is the vendor\'s own definition in a footnote or note, not a column you can check against.';
    case 'last_year_inheritance':
      return 'The vendor said the price is the same as last year and gave no number, so last year\'s contract rate is used.';
    case 'tax_basis_assumed_excl':
      return 'The document does not say whether GST is included. It is read as excluding GST, which is what the RFx asked for.';
    case 'tax_basis_model':
      return 'The model settled the tax basis of this line from the vendor\'s own words (the quote is in the document). A person has not checked it.';
    default:
      return `Assumption: ${key}.`;
  }
}

export const FLAG_TEXT: Record<string, string> = {
  evidence_mismatch: 'The number does not appear in the text quoted as its source.',
  unit_suspect: 'The converted price is more than four times, or less than a quarter of, last year\'s rate. A pack or tonne price may not have been converted.',
  unusual_vs_last_year: 'More than 35 percent away from last year\'s rate. Information only, not an error.',
  from_hidden_sheet: 'The value comes from a hidden sheet, which a normal reader would not see.',
  unmatched: 'Not matched to any RFx line.',
  unknown_rfx_code: 'The matched RFx code does not exist.',
  unit_unknown: 'The unit could not be read.',
  unit_incompatible: 'The unit does not fit the RFx unit for this line.',
  pack_size_unknown: 'Quoted per pack and the vendor does not say what a pack holds, or defines it more than one way.',
  no_price: 'No readable price.',
  no_last_year_rate: 'Said "same as last year" but no last year rate exists.',
  currency_unknown: 'The currency has no conversion rule.',
  buyer_edited: 'The buyer changed this value. The original is kept as the source.',
};

export function flagText(flag: string): string {
  return FLAG_TEXT[flag] ?? flag.replace(/_/g, ' ');
}

export function explainConfidence(i: ExplainInput, a: Assumptions): string[] {
  const out: string[] = [];
  const status = toCellStatus(i.status);
  if (status === 'missing') {
    return ['The vendor did not quote this line. It is shown as Not quoted and is never counted as zero.'];
  }
  const src = i.source_type ? SOURCE_NAME[i.source_type] : 'the document';
  const match = i.match_confidence != null ? `, matched to the RFx line with confidence ${i.match_confidence.toFixed(2)}` : '';
  if (i.buyer_verified) {
    out.push('A person has checked this value against the source and accepted it.');
  } else if (i.read_confidence) {
    out.push(`Read from ${src} with ${i.read_confidence} confidence${match}.`);
  }
  if (status === 'confirmed') {
    out.push(i.buyer_verified ? 'No assumption is needed, so it is Confirmed.' : 'The number appears in the quoted source, the unit is explicit and no assumption is needed, so it is Confirmed.');
  }
  if (status === 'assumed') {
    out.push('It is Assumed because it depends on the following.');
  }
  for (const k of i.assumption_keys) {
    const accepted = i.accepted_keys.includes(k);
    if (k === 'pack_size' && i.pack_source === 'buyer') out.push('Unit meaning: set by the buyer, so it is a decision rather than an assumption.');
    else out.push(`${assumptionText(k, a)}${accepted ? ' Accepted by the buyer.' : ''}`);
  }
  if (i.source_type === 'image' && !i.buyer_verified) {
    out.push('A photo can be misread in small print, so photo values are never confirmed automatically. Check the highlighted crop, then accept it.');
  }
  if (status === 'needs_review') {
    out.push('It needs review because:');
    out.push(...i.rule_reasons);
  }
  if (status === 'conflict') {
    out.push('Two sources give different values for this line. Neither is trusted until you choose.');
  }
  for (const f of i.flags) {
    if (f === 'buyer_edited') continue;
    if (['unusual_vs_last_year', 'evidence_mismatch', 'unit_suspect', 'from_hidden_sheet'].includes(f)) out.push(flagText(f));
  }
  return out;
}

export function statusSentence(status: LineStatus | 'missing'): string {
  return STATUS_LABEL[toCellStatus(status)];
}
