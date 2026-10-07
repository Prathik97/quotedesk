// One status vocabulary for the whole product, the certainty counts that sit in the
// top strip, and the decision readiness rule (FR-9.1 to FR-9.3).
import type { LineStatus } from './types';

export type CellStatus = 'confirmed' | 'assumed' | 'needs_review' | 'conflict' | 'missing';

export const STATUS_ORDER: CellStatus[] = ['confirmed', 'assumed', 'needs_review', 'conflict', 'missing'];

/** Display names. These exact words are used everywhere. */
export const STATUS_LABEL: Record<CellStatus, string> = {
  confirmed: 'Confirmed',
  assumed: 'Assumed',
  needs_review: 'Needs review',
  conflict: 'Conflict',
  missing: 'Not quoted',
};

export const STATUS_MEANING: Record<CellStatus, string> = {
  confirmed: 'Read with high confidence, matched to the line, number found in the source, unit explicit, no assumption needed.',
  assumed: 'The value was read, but it depends on an assumption such as an FX rate, a pack size, last year inheritance, or a photo.',
  needs_review: 'Low confidence, an unclear unit, or a value that does not fit. A person should check it before it is used.',
  conflict: 'Two sources give different values for the same line.',
  missing: 'The vendor did not quote this line. Shown as Not quoted, never as zero.',
};

export function toCellStatus(s: LineStatus | 'missing' | null | undefined): CellStatus {
  if (s === 'confirmed' || s === 'assumed' || s === 'needs_review' || s === 'conflict') return s;
  return 'missing';
}

export type CertaintyCounts = Record<CellStatus, number> & { total: number };

export function certaintyCounts(statuses: (LineStatus | 'missing' | null | undefined)[]): CertaintyCounts {
  const c: CertaintyCounts = { confirmed: 0, assumed: 0, needs_review: 0, conflict: 0, missing: 0, total: 0 };
  for (const s of statuses) {
    c[toCellStatus(s)]++;
    c.total++;
  }
  return c;
}

/** "142 confirmed, 6 assumed, 2 need review". Conflict and Not quoted are appended only when present. */
export function certaintySentence(c: CertaintyCounts): string {
  const parts = [`${c.confirmed} confirmed`, `${c.assumed} assumed`, `${c.needs_review} need review`];
  if (c.conflict > 0) parts.push(`${c.conflict} in conflict`);
  if (c.missing > 0) parts.push(`${c.missing} not quoted`);
  return parts.join(', ');
}

/**
 * Review item kinds that stop an award from being called ready. They are the
 * things that can change which vendor wins or what the total is.
 */
export const BLOCKER_KINDS = [
  'line_needs_review',
  'conflict',
  'total_mismatch',
  'knockout_pending',
  'freight_amount_unknown',
  'freight_terms_unknown',
  'extraction_failed',
];

export type OpenItem = { kind: string; severity: 'info' | 'warn' | 'block'; message: string; vendor?: string | null };

export type Readiness = {
  level: 'ready' | 'ready_with_assumptions' | 'not_ready';
  label: 'Ready' | 'Ready with assumptions' | 'Not ready with blockers';
  blockers: OpenItem[];
  warnings: number;
  assumed_cells: number;
  summary: string;
};

export function readiness(counts: CertaintyCounts, openItems: OpenItem[]): Readiness {
  const blockers = openItems.filter((i) => i.severity === 'block' || BLOCKER_KINDS.includes(i.kind));
  const warnings = openItems.filter((i) => !blockers.includes(i) && i.severity !== 'info').length;
  if (blockers.length > 0) {
    return {
      level: 'not_ready',
      label: 'Not ready with blockers',
      blockers,
      warnings,
      assumed_cells: counts.assumed,
      summary: `${blockers.length} ${blockers.length === 1 ? 'blocker' : 'blockers'} to resolve or dismiss with a reason.`,
    };
  }
  if (counts.assumed > 0 || warnings > 0) {
    return {
      level: 'ready_with_assumptions',
      label: 'Ready with assumptions',
      blockers,
      warnings,
      assumed_cells: counts.assumed,
      summary: `${counts.assumed} assumed ${counts.assumed === 1 ? 'cell' : 'cells'} and ${warnings} open ${warnings === 1 ? 'warning' : 'warnings'} will be listed in the decision.`,
    };
  }
  return { level: 'ready', label: 'Ready', blockers, warnings, assumed_cells: 0, summary: 'Every cell is confirmed and nothing is open.' };
}
