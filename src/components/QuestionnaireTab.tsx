// Questionnaire matrix (FR-6.7): answer, status, pass or fail against the rule, and evidence.
import { CircleCheck, Clock, OctagonX } from 'lucide-react';
import type { AnswerCell } from '@/lib/api-types';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Chip, StoredLabel } from './ui';

function Outcome({ a }: { a: AnswerCell }) {
  const o = a.outcome;
  if (!o) return null;
  if (o.outcome === 'pass') return <span className="inline-flex items-center gap-1 text-xs font-medium text-status-confirmed"><CircleCheck size={13} aria-hidden /> Passes</span>;
  if (o.outcome === 'fail') return <span className="inline-flex items-center gap-1 text-xs font-medium text-status-conflict"><OctagonX size={13} aria-hidden /> Fails</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-status-assumed">
      <Clock size={13} aria-hidden /> Undecided{o.tentative ? `, reads as ${o.tentative}` : ''}
    </span>
  );
}

export function QuestionnaireTab() {
  const { data, openAnswer } = useApp();
  if (!data) return null;
  const vendors = data.vendors;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Cleared means the vendor passes all three knockout questions. Failed means at least one is failed. Pending means none is failed but at least one cannot be decided yet.
        </p>
        <StoredLabel stored={data.stored} />
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col style={{ width: 250 }} />
            {vendors.map((v) => (
              <col key={v.id} style={{ width: 160 }} />
            ))}
          </colgroup>
          <thead>
            <tr className="bg-slate-100 text-left text-xs">
              <th scope="col" className="border-b border-r border-border px-2 py-2 font-semibold">
                Question
              </th>
              {vendors.map((v) => (
                <th key={v.id} scope="col" className="border-b border-r border-border px-2 py-2 align-top">
                  <div className="font-semibold">{v.name}</div>
                  <div className="mt-1">
                    <Chip tone={v.questionnaire === 'Cleared' ? 'good' : v.questionnaire === 'Failed' ? 'bad' : 'warn'}>
                      {v.questionnaire === 'Cleared' ? <CircleCheck size={12} aria-hidden /> : v.questionnaire === 'Failed' ? <OctagonX size={12} aria-hidden /> : <Clock size={12} aria-hidden />}
                      {v.questionnaire ?? 'Not assessed'}
                    </Chip>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.questions.map((q) => (
              <tr key={q.id} className={cn(q.is_knockout && 'bg-amber-50/40')}>
                <th scope="row" className="border-b border-r border-border px-2 py-2 text-left align-top font-normal">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="font-semibold tabular">{q.code}</span>
                    {q.is_knockout ? <Chip tone="warn">Knockout</Chip> : null}
                  </div>
                  <div className="mt-0.5 text-xs leading-snug">{q.text}</div>
                  {q.rule_text ? <div className="mt-0.5 text-[11px] text-muted-foreground">Rule: {q.rule_text}</div> : null}
                </th>
                {vendors.map((v) => {
                  const a = q.answers[v.id];
                  return (
                    <td key={v.id} className="border-b border-r border-border p-0 align-top">
                      {a ? (
                        <button type="button" onClick={() => openAnswer(v.id, q.id)} className="block h-full w-full px-2 py-2 text-left hover:bg-slate-50" aria-label={`${v.name}, ${q.code}: ${a.raw ?? 'no answer'}, ${a.status}${a.outcome ? `, ${a.outcome.outcome}` : ''}. Open evidence.`}>
                          <div className="line-clamp-3 text-xs leading-snug">{a.raw ?? <span className="text-muted-foreground">No answer found</span>}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className={cn('text-[11px]', a.status === 'answered' ? 'text-ink-2' : 'font-medium text-status-assumed')}>{a.status[0]?.toUpperCase()}{a.status.slice(1)}</span>
                            {a.basis === 'inferred' ? <span className="text-[11px] text-status-assumed">Inferred</span> : null}
                          </div>
                          <Outcome a={a} />
                        </button>
                      ) : (
                        <div className="px-2 py-2 text-xs text-muted-foreground">Not answered</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-muted-foreground">
        This is one reading of "cleared the quality questionnaire". Another reading is "no knockout failed", which would also include Pending vendors. The toggle on the grid uses the strict reading: Cleared only.
      </div>
    </div>
  );
}
