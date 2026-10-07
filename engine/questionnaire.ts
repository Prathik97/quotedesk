// Knockout evaluation. "Cleared" = passes all knockouts; "Failed" = fails any;
// "Pending" = no failure but at least one knockout cannot be decided yet.

export type PassRule =
  | { op: 'eq'; value: boolean | number | string }
  | { op: 'lte'; value: number }
  | { op: 'gte'; value: number }
  | { op: 'valid_on_date'; field: string; date: 'submission' };

export type KnockoutQuestion = { code: string; is_knockout: boolean; pass_rule: PassRule | null };

export type AnswerForRule = {
  status: 'answered' | 'partial' | 'unanswered' | 'conflicting';
  value: unknown;
  /** 'inferred' when the reader derived the value from an indirect statement. */
  basis?: 'explicit' | 'inferred';
};

export type KnockoutOutcome = 'pass' | 'fail' | 'pending';

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  return null;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v && typeof v === 'object' && 'has' in v && typeof (v as { has: unknown }).has === 'boolean') return (v as { has: boolean }).has;
  return null;
}

/**
 * @param expiryFallback expiry date from an attached certificate, used when
 *   the answer itself does not state one (for example "copy attached").
 */
export type RuleResult = { outcome: KnockoutOutcome; reason: string; tentative?: 'pass' | 'fail' };

/**
 * An inferred answer never decides a knockout: excluding (or clearing) a vendor
 * on a reading the vendor did not state is a silent guess. The tentative reading
 * is kept so the buyer sees both interpretations.
 */
export function evaluateRule(
  rule: PassRule,
  answer: AnswerForRule | undefined,
  submissionDate: string,
  expiryFallback?: string | null,
): RuleResult {
  const r = evaluateStated(rule, answer, submissionDate, expiryFallback);
  if (answer?.basis === 'inferred' && r.outcome !== 'pending') {
    return {
      outcome: 'pending',
      tentative: r.outcome,
      reason: `The answer is inferred from an indirect statement and reads as a ${r.outcome} (${r.reason}) Confirm with the vendor before deciding.`,
    };
  }
  return r;
}

function evaluateStated(
  rule: PassRule,
  answer: AnswerForRule | undefined,
  submissionDate: string,
  expiryFallback?: string | null,
): RuleResult {
  if (!answer || answer.status === 'unanswered') return { outcome: 'pending', reason: 'Not answered.' };
  if (answer.status === 'conflicting') return { outcome: 'pending', reason: 'Answers conflict across documents.' };
  switch (rule.op) {
    case 'eq': {
      const v = typeof rule.value === 'boolean' ? asBool(answer.value) : answer.value;
      if (v == null) return { outcome: 'pending', reason: 'Answer does not give a clear value.' };
      return v === rule.value ? { outcome: 'pass', reason: 'Meets the rule.' } : { outcome: 'fail', reason: `Answer is ${String(v)}, rule needs ${String(rule.value)}.` };
    }
    case 'lte':
    case 'gte': {
      const n = asNumber(answer.value);
      if (n == null) return { outcome: 'pending', reason: 'No number given.' };
      const ok = rule.op === 'lte' ? n <= rule.value : n >= rule.value;
      return ok ? { outcome: 'pass', reason: `${n} meets ${rule.op === 'lte' ? 'at most' : 'at least'} ${rule.value}.` } : { outcome: 'fail', reason: `${n} breaks ${rule.op === 'lte' ? 'at most' : 'at least'} ${rule.value}.` };
    }
    case 'valid_on_date': {
      const has = asBool(answer.value);
      if (has === false) return { outcome: 'fail', reason: 'Vendor says no certificate.' };
      const obj = answer.value && typeof answer.value === 'object' ? (answer.value as Record<string, unknown>) : {};
      const expiry = (typeof obj[rule.field] === 'string' ? (obj[rule.field] as string) : null) ?? expiryFallback ?? null;
      if (!expiry) return { outcome: 'pending', reason: 'No expiry date in the answer or an attached certificate.' };
      return expiry >= submissionDate
        ? { outcome: 'pass', reason: `Valid until ${expiry}, submitted ${submissionDate}.` }
        : { outcome: 'fail', reason: `Expired on ${expiry}, before the submission date ${submissionDate}.` };
    }
  }
}

export type QuestionnaireResult = {
  result: 'Cleared' | 'Failed' | 'Pending';
  knockouts: Record<string, RuleResult>;
};

export function evaluateKnockouts(
  questions: KnockoutQuestion[],
  answers: Record<string, AnswerForRule>,
  submissionDate: string,
  certExpiry?: string | null,
): QuestionnaireResult {
  const knockouts: QuestionnaireResult['knockouts'] = {};
  for (const q of questions) {
    if (!q.is_knockout || !q.pass_rule) continue;
    knockouts[q.code] = evaluateRule(q.pass_rule, answers[q.code], submissionDate, certExpiry);
  }
  const outcomes = Object.values(knockouts).map((k) => k.outcome);
  const result = outcomes.includes('fail') ? 'Failed' : outcomes.includes('pending') ? 'Pending' : 'Cleared';
  return { result, knockouts };
}
