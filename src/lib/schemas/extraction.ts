// Zod contract for model output (REQUIREMENTS 5.1 and 5.2). Shared by the API and the UI.
// Lenient where harmless (numeric strings with grouping, missing optional arrays),
// strict where it matters (types of prices, enums, confidence ranges).
import { z } from 'zod';

const num = z.preprocess((v) => {
  if (typeof v === 'string') {
    const s = v.replace(/,/g, '').trim();
    return s === '' ? null : Number(s);
  }
  return v;
}, z.number().finite());

const conf01 = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().min(0).max(1));
const readConf = z.enum(['high', 'medium', 'low']);

// Tax fields are an aid, never a reason to reject a reply: anything unreadable becomes "not given".
const taxBasisField = z.preprocess((v) => {
  if (typeof v !== 'string') return null;
  const t = v.toLowerCase();
  return /incl/.test(t) ? 'incl' : /excl|extra/.test(t) ? 'excl' : null;
}, z.enum(['incl', 'excl']).nullable());
const taxRateField = z.preprocess((v) => {
  const n = typeof v === 'string' ? Number(v.replace('%', '').trim()) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 40 ? n : null;
}, z.number().nullable());
const textOrNull = z.preprocess((v) => (typeof v === 'string' && v.trim() ? v : null), z.string().nullable());

/** One tax statement the vendor made for the whole document, in the vendor's own words. */
export const TaxStatementSchema = z.object({
  quote: textOrNull,
  basis: taxBasisField.default(null),
  rate_pct: taxRateField.default(null),
  scope: z.preprocess((v) => (typeof v === 'string' ? v : ''), z.string()).default(''),
  is_correction: z.preprocess((v) => v === true, z.boolean()).default(false),
});
export type ModelTaxStatement = z.infer<typeof TaxStatementSchema>;

export const EvidenceSchema = z.object({
  source_type: z.enum(['xlsx', 'pdf', 'docx', 'image', 'email']),
  locator: z.string().min(1),
  quote: z.string().nullable().default(null),
  page: num.nullable().optional().default(null),
  region: z
    .object({ x: num, y: num, w: num, h: num })
    .nullable()
    .optional()
    .default(null),
  read_confidence: readConf.default('medium'),
});
export type ModelEvidence = z.infer<typeof EvidenceSchema>;

const evidenceOrNull = EvidenceSchema.nullable().optional().default(null);

export const ExtractedLineSchema = z.object({
  rfx_line_code: z.string().nullable().default(null),
  match_confidence: conf01,
  match_reason: z.string().default(''),
  vendor_description: z.string().default(''),
  price: num.nullable().default(null),
  currency: z.string().default('INR'),
  uom_text: z.string().nullable().default(null),
  per_n: z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().positive()).nullable().optional().default(1),
  inherits_last_year: z.boolean().default(false),
  conditions: z.array(z.string()).default([]),
  evidence: EvidenceSchema,
  // Optional: when omitted, the evidence's own read confidence applies (same reading).
  read_confidence: readConf.optional(),
  notes: z.string().nullable().optional().default(''),
  // What the model resolved about tax for this line after applying the vendor's corrections. Code verifies it.
  tax_basis: taxBasisField.optional(),
  tax_rate_pct: taxRateField.optional(),
  tax_source_quote: textOrNull.optional(),
}).transform((l) => ({ ...l, read_confidence: l.read_confidence ?? l.evidence.read_confidence }));
export type ExtractedLine = z.infer<typeof ExtractedLineSchema>;

/** One statement covering several RFx lines (a family price, or "same as last year" for a group). */
export const GroupStatementSchema = z.object({
  applies_to_codes: z.array(z.string()).min(1),
  price: num.nullable().default(null),
  currency: z.string().default('INR'),
  uom_text: z.string().nullable().default(null),
  per_n: z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().positive()).nullable().optional().default(1),
  inherits_last_year: z.boolean().default(false),
  match_confidence: conf01,
  match_reason: z.string().default(''),
  evidence: EvidenceSchema,
  read_confidence: readConf.optional(),
}).transform((g) => ({ ...g, read_confidence: g.read_confidence ?? g.evidence.read_confidence }));

export const ExtractionSchema = z.object({
  document: z.object({
    kind: z.enum(['quote', 'questionnaire', 'certificate', 'profile', 'other']),
    vendor_name_as_written: z.string().nullable().default(null),
    currency_default: z.string().default('INR'),
    tax_basis: z.enum(['excl_gst', 'incl_gst', 'unknown']).default('unknown'),
    validity_text: z.string().nullable().default(null),
    freight_terms: z.enum(['included', 'extra', 'unknown']).default('unknown'),
    freight_note: z.string().nullable().default(null),
    payment_terms_text: z.string().nullable().default(null),
    stated_total: z
      .object({ amount: num, currency: z.string().default('INR'), evidence: evidenceOrNull })
      .nullable()
      .default(null),
    unit_definitions: z
      .array(z.object({ term: z.string(), means_quantity: num, means_unit: z.string(), evidence: evidenceOrNull }))
      .default([]),
    conditional_discounts: z
      .array(
        z.object({
          text: z.string(),
          percent: num.nullable().default(null),
          condition: z.string().default(''),
          applies_to: z.string().default(''),
          evidence: evidenceOrNull,
        }),
      )
      .default([]),
    global_notes: z.array(z.string()).default([]),
    suspicious_content: z.array(z.object({ text: z.string(), evidence: evidenceOrNull })).default([]),
    group_statements: z.array(GroupStatementSchema).default([]),
    tax_statements: z
      .preprocess((v) => (Array.isArray(v) ? v.filter((x) => TaxStatementSchema.safeParse(x).success && typeof x?.quote === 'string' && x.quote.trim() !== '') : []), z.array(TaxStatementSchema))
      .default([]),
  }),
  lines: z.array(ExtractedLineSchema).default([]),
  unmatched_lines: z.array(z.object({ vendor_description: z.string(), reason: z.string().default('') })).default([]),
  questionnaire: z
    .array(
      z.object({
        question_code: z.string(),
        answer_text: z.string().default(''),
        answer_value: z.unknown().optional(),
        status: z.enum(['answered', 'partial', 'unanswered']).default('answered'),
        basis: z.enum(['explicit', 'inferred']).default('explicit'),
        evidence: evidenceOrNull,
      }),
    )
    .default([]),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/** Group statements become ordinary lines, one per covered code, sharing the statement's evidence. */
export function expandGroupStatements(x: Extraction): ExtractedLine[] {
  const explicit = new Set(x.lines.map((l) => l.rfx_line_code).filter(Boolean));
  const out: ExtractedLine[] = [...x.lines];
  for (const g of x.document.group_statements) {
    for (const code of g.applies_to_codes) {
      if (explicit.has(code)) continue; // a specific price for this line wins over the blanket statement
      out.push({
        rfx_line_code: code, match_confidence: g.match_confidence, match_reason: g.match_reason,
        vendor_description: g.evidence.quote ?? '', price: g.price, currency: g.currency, uom_text: g.uom_text,
        per_n: g.per_n, inherits_last_year: g.inherits_last_year, conditions: [], evidence: g.evidence,
        read_confidence: g.read_confidence, notes: 'From a statement covering several lines.',
      });
    }
  }
  return out;
}

export const ClassificationSchema = z.object({
  kind: z.enum(['quote', 'questionnaire', 'certificate', 'profile', 'other']),
  confidence: conf01,
  reason: z.string().default(''),
});
export type Classification = z.infer<typeof ClassificationSchema>;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .default(null);

export const CertificateSchema = z.object({
  doc_type: z.enum(['iso_9001', 'gst_registration', 'fsc', 'test_report', 'company_profile', 'other']),
  legal_name: z.string().nullable().default(null),
  trade_name: z.string().nullable().default(null),
  certificate_number: z.string().nullable().default(null),
  standard: z.string().nullable().default(null),
  issuer: z.string().nullable().default(null),
  issue_date: isoDate,
  expiry_date: isoDate,
  evidence: z.array(z.object({ field: z.string(), locator: z.string(), quote: z.string() })).default([]),
  suspicious_content: z.array(z.object({ text: z.string(), locator: z.string().default('') })).default([]),
  read_confidence: readConf.default('medium'),
});
export type CertificateFacts = z.infer<typeof CertificateSchema>;

/**
 * Strict JSON grammar, but a key repeated in one object is merged instead of
 * silently replaced (JSON.parse keeps only the last): objects merge, arrays
 * concatenate, and for anything else the first value is kept.
 */
export function parseJsonMerging(text: string): unknown {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i] ?? '')) i++;
  };
  const fail = (msg: string): never => {
    throw new Error(`${msg} at position ${i}`);
  };
  const merge = (a: unknown, b: unknown): unknown => {
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = k in out ? merge(out[k], v) : v;
      return out;
    }
    return a;
  };
  const value = (): unknown => {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Expected a key');
        const key = str();
        ws();
        if (text[i] !== ':') fail('Expected ":"');
        i++;
        const v = value();
        obj[key] = Object.prototype.hasOwnProperty.call(obj, key) ? merge(obj[key], v) : v;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        fail('Expected "," or "}"');
      }
    }
    if (ch === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        fail('Expected "," or "]"');
      }
    }
    if (ch === '"') return str();
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) return fail('Unexpected token');
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail('Unterminated string');
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const v = value();
  ws();
  if (i !== text.length) fail('Trailing content');
  return v;
}

/** Pulls the JSON object out of a reply that may carry stray text or fences. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return parseJsonMerging(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return parseJsonMerging(t.slice(start, end + 1));
    throw new Error('Reply is not JSON.');
  }
}

export function zodErrors(e: z.ZodError): string {
  return e.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}
