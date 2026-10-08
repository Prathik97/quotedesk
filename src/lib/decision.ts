// Client side logic for the Decision page and the top strip. It runs the same award engine and the same
// sensitivity code as the server, over the comparison data already in the browser, so the page answers at
// once and agrees with the memo. No model is involved.
import { useMemo } from 'react';
import { AwardError, DEFAULT_SCENARIO, simulateAward, type AwardResult, type Scenario } from '../../engine/award';
import { runSensitivity, type Sensitivity } from '../../engine/decision';
import type { Assumptions } from '../../engine/types';
import type { CompareResponse } from './api-types';
import { awardInputFromCompare, globalAssumptionsOf } from './awardInput';

export type Controls = {
  strategy: Scenario['strategy'];
  vendor: string | null;
  /** Largest share one vendor may hold, in whole percent. */
  max_share_pct: number;
  include_pending: boolean;
  apply_discounts: boolean;
  price_basis: 'confirmed' | 'confirmed_assumed';
};

export const DEFAULT_CONTROLS: Controls = { strategy: 'cheapest_per_line', vendor: null, max_share_pct: 60, include_pending: false, apply_discounts: false, price_basis: 'confirmed_assumed' };

export function controlsToScenario(c: Controls): Scenario {
  return {
    strategy: c.strategy,
    filters: { eligibility: c.include_pending ? 'cleared_and_pending' : 'cleared', exclude_vendors: [], include_vendors: null, apply_discounts: c.apply_discounts, price_basis: c.price_basis },
    constraints: { vendor: c.strategy === 'single_vendor' ? c.vendor : null, max_share: c.strategy === 'split_cap' ? c.max_share_pct / 100 : null },
  };
}

export type Run = { result: AwardResult; sensitivity: Sensitivity; assumptions: Assumptions };
export type RunOutcome = { run: Run | null; error: string | null };

export function runScenario(data: CompareResponse, scenario: Scenario): RunOutcome {
  const a = globalAssumptionsOf(data);
  const make = (x: Assumptions) => awardInputFromCompare(data, x, data.open_items);
  try {
    const result = simulateAward(make(a), scenario);
    return { run: { result, sensitivity: runSensitivity(make, a, scenario, result), assumptions: a }, error: null };
  } catch (e) {
    if (e instanceof AwardError) return { run: null, error: e.message };
    throw e;
  }
}

export function useScenarioRun(data: CompareResponse | null, scenario: Scenario): RunOutcome {
  const key = JSON.stringify(scenario);
  // The comparison data changes identity on every recompute, so a fresh run follows an FX edit or a correction.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (data ? runScenario(data, scenario) : { run: null, error: null }), [data, key]);
}

/** The readiness the top strip shows: the default scenario, the same one the Decision page opens with. */
export function useDefaultReadiness(data: CompareResponse | null): AwardResult['readiness'] | null {
  return useScenarioRun(data, DEFAULT_SCENARIO).run?.result.readiness ?? null;
}

export const STRATEGY_LABEL: Record<Scenario['strategy'], string> = {
  single_vendor: 'Single vendor',
  cheapest_per_line: 'Cheapest per line',
  split_cap: 'Split with a share cap',
  cheapest_per_section: 'Cheapest per section',
};

export const STRATEGY_HELP: Record<Scenario['strategy'], string> = {
  single_vendor: 'Every line goes to one vendor you pick.',
  cheapest_per_line: 'Each line goes to the lowest priced eligible vendor.',
  split_cap: 'Cheapest per line, then lines move until no vendor holds more than the cap. A greedy search, not proven cheapest.',
  cheapest_per_section: 'Each section goes to the one vendor who quoted all of it and is cheapest overall.',
};

// ---------------------------------------------------------------- the decision pack API

export type NoteCheck = { ok: boolean; words: number; reasons: string[]; unmatched: string[]; checked: number };
export type PackFile = { filename: string; mime: string; bytes: number; base64: string };
export type PackResponse = {
  ok: true;
  needs_choice: boolean;
  summary: { scenario_text: string; readiness: { label: string; summary: string; blockers: number; open_items: number }; goods_total_inr: number; landed_total_inr: number; landed_complete: boolean; savings_vs_ly_inr: number; lines_awarded: number; lines_total: number };
  note: { text: string; source: 'model' | 'template'; label: string; check: NoteCheck; fallback: { reason: 'cap' | 'error'; message: string } | null; model: string | null; cost_inr: number; cache_hit: boolean };
  files: { memo: PackFile; appendix: PackFile } | null;
};

export function packBody(c: Controls, note: string, mode: 'model' | 'template', regenerate: boolean) {
  return {
    strategy: c.strategy,
    include_pending: c.include_pending,
    apply_discounts: c.apply_discounts,
    price_basis: c.price_basis,
    vendor: c.strategy === 'single_vendor' ? c.vendor : null,
    max_share: c.strategy === 'split_cap' ? c.max_share_pct / 100 : null,
    ...(note.trim() ? { buyer_note: note.trim() } : {}),
    note_mode: mode,
    regenerate,
  };
}

export function downloadFile(f: PackFile): void {
  const bin = atob(f.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = f.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
