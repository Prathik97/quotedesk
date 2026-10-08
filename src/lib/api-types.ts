// Shapes returned by /api/*. Shared by the handlers and the React app.
import type { CellStatus, CertaintyCounts, Readiness } from '../../engine/certainty';
import type { SizeCheck } from '../../engine/dimensions';
import type { DocTaxStatement, ModelTax } from '../../engine/tax';
import type { HeaderTax } from '../../engine/tax-header';
import type { ConversionTrace } from '../../engine/recompute';

export type { CellStatus, CertaintyCounts, Readiness };

export type StoredRun = {
  /** Date of the last live extraction run, for the label "Stored results from a live run on <date>". */
  date: string | null;
  label: string;
  live_calls: number;
};

export type LineDef = {
  id: string;
  code: string;
  section: string;
  description: string;
  spec: string | null;
  uom: string;
  annual_qty: number;
  ly_rate: number | null;
  is_one_time: boolean;
  sort: number;
};

export type Discount = {
  id: string;
  percent: number;
  condition: string | null;
  text: string;
  applies_to: string | null;
  document_id: string | null;
  evidence_quote: string | null;
  evidence_locator: string | null;
};

export type VendorHeader = {
  id: string;
  key: string;
  name: string;
  location: string | null;
  contact_email: string | null;
  arrival_day: number | null;
  received_at: string | null;
  coverage: { quoted: number; total: number };
  counts: Record<CellStatus, number>;
  questionnaire: 'Cleared' | 'Failed' | 'Pending' | null;
  freight_terms: 'included' | 'extra' | 'unknown';
  freight_note: string | null;
  freight_amount_inr: number | null;
  payment_terms_days: number | null;
  validity_text: string | null;
  /** Set when the vendor's validity is shorter than the RFx asks for. Display only: it opens no review item and changes no cell. */
  validity_warning?: string | null;
  /** The vendor's quote level notes (global notes) from all its documents, as extracted. */
  notes?: string[];
  stated_total_inr: number | null;
  letterhead_name: string | null;
  attachments: number;
  open_warnings: number;
  open_items: number;
  extraction: { status: 'Extracted' | 'Failed' | 'In progress'; documents: number; failed: number };
  pipeline: 'Received' | 'Classified' | 'Extracted' | 'Needs review' | 'Ready';
  discounts: Discount[];
};

/** What the engine needs to recompute a cell in the browser, so an assumption edit shows at once. */
export type CellRaw = {
  per_n: number;
  tax_basis: 'excl_gst' | 'incl_gst' | 'unknown';
  inherits_last_year: boolean;
  read_confidence: 'high' | 'medium' | 'low';
  match_confidence: number;
  evidence_quote: string | null;
  evidence_locator: string | null;
  sticky_flags: string[];
  overrides: Record<string, unknown>;
  unit_definitions: { term: string; means_quantity: number | null; means_unit: string | null; quote: string | null }[];
  /** RFx description and spec of the line, and the vendor's quote level notes from the cell's own document. The engine reads them for a stated piece length and a board grade. */
  rfx_text?: string;
  vendor_notes?: string[];
  /** Size check and duplicate match decided at extraction (engine/dimensions.ts), carried so a recompute keeps them. */
  size_check?: SizeCheck | null;
  duplicate_rfx_match?: string | null;
  /** The line's own words, its RFx line and section, and the model's checked tax resolution. The engine judges which document tax statements could apply to the line on them. */
  scope_text?: string;
  model_tax?: ModelTax | null;
  doc_tax_statements?: DocTaxStatement[];
  header_tax?: HeaderTax | null;
};

export type GridCell = {
  vendor_id: string;
  rfx_line_id: string;
  quote_line_id: string | null;
  /** Normalized INR per base unit excluding GST, before any scenario discount. Null when not quoted. */
  price: number | null;
  status: CellStatus;
  flags: string[];
  assumption_keys: string[];
  quoted_price: number | null;
  quoted_uom: string | null;
  quoted_currency: string | null;
  conditions: string[];
  source_type: string | null;
  buyer_verified: boolean;
  confidence: number | null;
  raw: CellRaw | null;
};

export type RuleOutcome = { outcome: 'pass' | 'fail' | 'pending'; reason: string; tentative?: 'pass' | 'fail' };

export type AnswerCell = {
  raw: string | null;
  value: unknown;
  status: 'answered' | 'partial' | 'unanswered' | 'conflicting';
  basis: 'explicit' | 'inferred';
  evidence: { locator?: string; quote?: string | null; page?: number | null; document_id?: string } | null;
  document_id: string | null;
  outcome: RuleOutcome | null;
};

export type QuestionRow = {
  id: string;
  code: string;
  text: string;
  answer_type: string;
  is_knockout: boolean;
  rule_text: string | null;
  answers: Record<string, AnswerCell | null>;
};

export type AttachmentFacts = {
  doc_type?: string;
  standard?: string | null;
  certificate_number?: string | null;
  legal_name?: string | null;
  trade_name?: string | null;
  issuer?: string | null;
  issue_date?: string | null;
  expiry_date?: string | null;
  read_confidence?: string;
};

export type Attachment = {
  id: string;
  vendor_id: string;
  filename: string;
  mime: string;
  kind: string | null;
  status: string;
  error: string | null;
  flags: string[];
  facts: AttachmentFacts | null;
  is_message_body: boolean;
  lines: number;
};

export type ReviewItem = {
  id: string;
  /** "cell:<quote_line_id>" for an Assumed cell listed as a confirmable item. */
  kind: string;
  tier: 'needs_review' | 'assumed' | 'vendor';
  severity: 'info' | 'warn' | 'block';
  vendor_id: string;
  vendor_key: string;
  vendor_name: string;
  quote_line_id: string | null;
  rfx_line_code: string | null;
  document_id: string | null;
  message: string;
  value_at_stake_inr: number | null;
  state: 'open' | 'resolved' | 'dismissed';
  resolution: { reason?: string; action?: string; auto?: boolean; note?: string } | null;
  is_blocker: boolean;
  /** Review actions that make sense for this item. */
  actions: ('accept' | 'edit' | 'unit' | 'not_quoted' | 'dismiss')[];
  base_uom: string | null;
  quoted_uom: string | null;
  quoted_price: number | null;
  quoted_currency: string | null;
};

export type AssumptionRow = {
  key: string;
  label: string;
  value: number | string;
  default_value: number | null;
  set_by: 'system' | 'buyer';
  note: string | null;
  editable: boolean;
  unit: string | null;
};

export type DerivedAssumption = {
  key: string;
  label: string;
  vendor_key: string;
  vendor_name: string;
  detail: string;
  lines: number;
  set_by: 'system' | 'buyer';
};

export type CompareResponse = {
  stored: StoredRun;
  rfx: { id: string; ref: string | null; title: string; buyer_org: string };
  lines: LineDef[];
  vendors: VendorHeader[];
  cells: GridCell[];
  questions: QuestionRow[];
  attachments: Attachment[];
  assumptions: AssumptionRow[];
  derived_assumptions: DerivedAssumption[];
  certainty: CertaintyCounts;
  readiness: Readiness;
  open_review: number;
  /** Every open review item, so readiness can be judged for any set of vendors. */
  open_items: { vendor_key: string | null; kind: string; severity: 'info' | 'warn' | 'block'; message: string }[];
  ly_total_inr: number;
};

export type SourceRef = {
  document_id: string;
  filename: string;
  mime: string;
  source_type: string;
  locator: string;
  quote: string | null;
  page: number | null;
  region: { x: number; y: number; w: number; h: number } | null;
  read_confidence: string | null;
  signed_url: string | null;
};

export type SourceContext =
  | { kind: 'grid'; sheet: string; hidden: boolean; target: string; rows: { row: number; cells: { addr: string; text: string; target?: boolean }[] }[] }
  | { kind: 'lines'; lines: { label: string; text: string; target?: boolean }[] }
  | { kind: 'pdf'; page: number | null }
  | { kind: 'image' }
  | { kind: 'none'; note: string };

export type EvidenceResponse = {
  stored: StoredRun;
  quote_line_id: string | null;
  vendor: { id: string; key: string; name: string };
  line: LineDef;
  status: CellStatus;
  price: number | null;
  annual_value: number | null;
  delta_pct: number | null;
  quoted: { price: number | null; currency: string | null; uom_text: string | null; per_n: number; inherits_last_year: boolean; tax_basis: string | null };
  trace: ConversionTrace | null;
  conversion_notes: string[];
  conversion_error: { reason: string; detail: string } | null;
  pack_source: 'vendor' | 'buyer' | null;
  unit_definition: { term: string; means: string; quote: string | null; region: SourceRef['region']; locator: string | null; document_id: string | null } | null;
  assumptions_used: { key: string; text: string; accepted: boolean; editable: boolean; value: number | null; unit: string | null }[];
  flags: { flag: string; text: string }[];
  explanation: string[];
  buyer_verified: boolean;
  overrides: Record<string, unknown>;
  corrections: { id: string; action: string | null; field: string; old_value: unknown; new_value: unknown; reason: string; created_at: string }[];
  review_items: { id: string; kind: string; state: string; message: string }[];
  conditions: string[];
  source: SourceRef | null;
  context: SourceContext;
  match_reason: string | null;
  match_confidence: number | null;
  vendor_description: string | null;
  base_uom: string;
};

export type ReviewAction =
  | { action: 'accept'; quote_line_id: string; reason?: string; review_item_id?: string }
  | { action: 'edit'; quote_line_id: string; price: number; currency?: string; uom_text?: string; reason?: string; review_item_id?: string }
  | { action: 'unit'; quote_line_id: string; quantity: number; reason?: string; review_item_id?: string }
  | { action: 'not_quoted'; quote_line_id: string; reason: string; review_item_id?: string }
  | { action: 'dismiss'; review_item_id: string; reason: string }
  | { action: 'undo'; quote_line_id: string; reason?: string };

export type RecomputeSummary = {
  ms: number;
  lines: number;
  changed: { quote_line_id: string; vendor_id: string; vendor_key: string; code: string; price_before: number | null; price_after: number | null; status_before: string; status_after: string }[];
  assumptions: { usd_inr: number; gst_pct: number };
};

export type ReviewResponse = {
  stored: StoredRun;
  items: ReviewItem[];
  counts: { needs_review: number; assumed: number; vendor: number; open_total: number; resolved: number };
};

export type ActionResponse = { ok: true; correction_id: string; recompute: RecomputeSummary };

export type DocumentRow = {
  id: string;
  vendor_id: string;
  filename: string;
  mime: string;
  kind: string | null;
  kind_confidence: number | null;
  status: string;
  error: string | null;
  size_bytes: number | null;
  is_message_body: boolean;
  signed_url: string | null;
  flags: string[];
  facts: AttachmentFacts | null;
  lines: number;
};

export type InboxMessage = {
  vendor_id: string;
  vendor_key: string;
  vendor_name: string;
  from: string | null;
  subject: string | null;
  arrival_day: number | null;
  received_at: string | null;
  body_text: string | null;
  pipeline: VendorHeader['pipeline'];
  documents: DocumentRow[];
};

export type InboxResponse = { stored: StoredRun; revealed: boolean; waiting: number; messages: InboxMessage[] };

export type DocumentPreview = {
  document: DocumentRow;
  preview:
    | { kind: 'xlsx'; sheets: { name: string; hidden: boolean; rows: { row: number; cells: { addr: string; text: string }[] }[]; merges: string[] }[] }
    | { kind: 'lines'; lines: { label: string; text: string }[] }
    | { kind: 'pdf' }
    | { kind: 'image' };
  extracted: { quote_line_id: string; code: string | null; vendor_description: string | null; quoted: string; price: number | null; status: CellStatus; locator: string | null; region: SourceRef['region']; page: number | null }[];
};

export type RfxResponse = {
  stored: StoredRun;
  rfx: {
    id: string;
    ref: string | null;
    title: string;
    category: string;
    buyer_org: string;
    status: string;
    is_saved_demo: boolean;
    delivery_location: string | null;
    payment_terms_requested_days: number | null;
    validity_days: number | null;
    gst_basis_requested: string | null;
    currency: string;
  };
  lines: LineDef[];
  questions: { code: string; text: string; answer_type: string; is_knockout: boolean; rule_text: string | null }[];
  ly_total_inr: number;
};

export type VendorDetail = {
  vendor: VendorHeader;
  notes: { text: string; document_id: string | null }[];
  suspicious: { text: string; locator: string | null }[];
  unit_definitions: { term: string; means: string; quote: string | null; locator: string | null }[];
  unresolved_value_inr: number;
  assumed_value_inr: number;
  confirmed_value_inr: number;
  goods_total_inr: number;
  landed_total_inr: number;
  complete: boolean;
  incomplete_reasons: string[];
  missing_value_at_ly_inr: number;
};

export type AssumptionUpdateResponse = { ok: true; key: string; old: number; value: number; set_by: 'system' | 'buyer'; recompute: RecomputeSummary };

export type { UsageSummary } from '../../api/_lib/guard';
