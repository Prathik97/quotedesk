// Shared vocabulary for the engine. No I/O.

export type BaseUom = 'piece' | 'kg' | 'sq m' | 'roll' | 'set' | 'plate' | 'pallet';

export type LineStatus = 'confirmed' | 'assumed' | 'needs_review' | 'conflict' | 'missing' | 'rejected';

export type ReadConfidence = 'high' | 'medium' | 'low';

export type SourceType = 'xlsx' | 'pdf' | 'docx' | 'image' | 'email';

export type Evidence = {
  source_type: SourceType;
  document_id?: string;
  locator: string;
  quote: string | null;
  region?: { x: number; y: number; w: number; h: number } | null;
  page?: number | null;
  read_confidence: ReadConfidence;
};

/** One arithmetic step, kept so the UI can show "42,000 per tonne / 1000 = 42.00 per kg". */
export type ConversionStep = {
  op: 'multiply' | 'divide';
  factor: number;
  reason: string;
  assumption_key?: string;
};

export type Assumptions = {
  usd_inr: number;
  gst_pct: number;
};

/** A unit definition the vendor wrote themselves, for example "1 box = 100 pcs". */
export type UnitDefinition = {
  term: string;
  means_quantity: number | null;
  means_unit: string | null;
  quote: string | null;
};
