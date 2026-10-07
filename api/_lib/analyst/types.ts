// Shapes shared by the analyst tools, the agent loop, the export route and the chat UI.
import type { Scenario } from '../../../engine/award.js';

export type ColumnType = 'text' | 'inr' | 'inr_unit' | 'pct' | 'int' | 'num' | 'status';

export type Table = {
  name: string;
  title: string;
  columns: { key: string; label: string; type: ColumnType }[];
  rows: Record<string, unknown>[];
};

/** What a tool produced, kept so the UI can render it and a later turn can chart or export it. */
export type StoredResult = {
  id: string;
  kind: 'query' | 'award' | 'issues' | 'evidence';
  title: string;
  /** Plain statements of how the result was produced (the SQL, the scenario) and its caveats. */
  notes: string[];
  tables: Table[];
  /** The full structured result (an AwardResult for kind "award"). */
  data?: unknown;
};

export type ChartType = 'bar' | 'line' | 'stacked_bar' | 'scatter';

export type ChartPayload = {
  type: ChartType;
  title: string;
  x_label: string | null;
  y_label: string | null;
  unit: 'inr' | 'pct' | 'count' | 'number';
  series: { name: string; points: { x: string | number; y: number }[] }[];
  sources: string[];
};

export type ExportChip = { result_id: string; format: 'xlsx' | 'csv'; filename: string; url: string; rows: number };

export type AssumptionOverrides = { usd_inr?: number; gst_pct?: number };

export type SessionState = {
  scenario: Scenario;
  assumptions: AssumptionOverrides;
};

/** One step as the user sees it while the agent works, and as the "How I got this" panel lists it. */
export type StepRecord = {
  id: string;
  tool: string;
  input: unknown;
  status: 'done' | 'error';
  summary: string;
  result_id: string | null;
  rows_used: number | null;
  sql: string | null;
  scenario: Scenario | null;
  assumptions: AssumptionOverrides | null;
  evidence_ids: string[];
};

export type ToolOutcome = {
  /** Exactly what the model is given. Numbers in the final answer are checked against this. */
  model: unknown;
  summary: string;
  error?: boolean;
  result?: StoredResult;
  chart?: ChartPayload;
  export?: ExportChip;
  rows_used?: number;
  sql?: string;
  scenario?: Scenario;
  assumptions?: AssumptionOverrides;
  evidence_ids?: string[];
};
