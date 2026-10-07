// One chat turn: the question, working steps, streaming text, and the finished answer with its
// uncertainty callout, tables, charts, downloads, interpretation chips and "How I got this".
import { CircleAlert, CircleCheck, Download, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Btn } from '@/components/ui';
import type { Turn } from '@/lib/analyst';
import { useApp } from '@/lib/store';
import { ChartView } from './ChartView';
import { ResultTable } from './ResultTable';

/** Plain paragraphs, bullets and **bold**. Text only: nothing from the model is ever rendered as HTML. */
export function RichText({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>));
  const isBullet = (l: string) => /^\s*(?:[-*]|\d+[.)])\s+/.test(l);
  const strip = (l: string) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '');
  const out: ReactNode[] = [];
  for (const [bi, block] of text.split(/\n{2,}/).entries()) {
    // Within a block, runs of bullet lines become a list and the lines around them stay paragraphs.
    const lines = block.split('\n').filter((l) => l.trim());
    let run: string[] = [];
    let para: string[] = [];
    const flushPara = () => {
      if (para.length) out.push(<p key={`${bi}-p${out.length}`}>{para.map((l, k) => <span key={k}>{k > 0 ? <br /> : null}{inline(l)}</span>)}</p>);
      para = [];
    };
    const flushRun = () => {
      if (run.length) out.push(<ul key={`${bi}-u${out.length}`} className="list-disc space-y-1 pl-5">{run.map((l, k) => <li key={k}>{inline(strip(l))}</li>)}</ul>);
      run = [];
    };
    for (const l of lines) {
      if (isBullet(l)) {
        flushPara();
        run.push(l);
      } else {
        flushRun();
        para.push(l);
      }
    }
    flushPara();
    flushRun();
  }
  return <div className="space-y-2 text-sm leading-relaxed">{out}</div>;
}

export function AnswerView({ turn, onAsk, busy }: { turn: Turn; onAsk: (q: string) => void; busy: boolean }) {
  const { data, openCell } = useApp();
  const f = turn.final;
  const working = turn.status === 'working';
  const shownSteps = turn.steps;
  const stepsDone = shownSteps.filter((s) => s.status !== 'running').length;

  const jumpToResult = (id: string) => {
    const el = document.getElementById(`result-${id}-${turn.results.find((r) => r.id === id)?.tables[0]?.name ?? ''}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const openEvidence = (qid: string) => {
    const c = data?.cells.find((x) => x.quote_line_id === qid);
    if (c) openCell(c.vendor_id, c.rfx_line_id, qid);
  };

  return (
    <article className="space-y-3" aria-label="Analyst turn">
      <div className="ml-auto max-w-[85%] rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">{turn.question}</div>

      <div className="max-w-[96%] space-y-3 rounded-lg border border-border bg-card p-4">
        {shownSteps.length > 0 ? (
          <details open={working} className="text-xs">
            <summary className="cursor-pointer select-none font-medium text-muted-foreground">
              {working ? 'Working' : 'Working steps'} ({stepsDone} of {shownSteps.length})
            </summary>
            <ol className="mt-1.5 space-y-1">
              {shownSteps.map((s) => (
                <li key={s.id} className="flex items-start gap-1.5">
                  {s.status === 'running' ? <LoaderCircle size={13} className="mt-0.5 shrink-0 animate-spin text-muted-foreground" aria-hidden /> : s.status === 'error' ? <CircleAlert size={13} className="mt-0.5 shrink-0 text-status-conflict" aria-hidden /> : <CircleCheck size={13} className="mt-0.5 shrink-0 text-status-confirmed" aria-hidden />}
                  <span>
                    {s.label}
                    {s.summary ? <span className="text-muted-foreground">: {s.summary}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        ) : null}

        {working && turn.text ? <RichText text={turn.text.replace(/<[a-z]+>[\s\S]*$/i, '')} /> : null}
        {working && !turn.text ? (
          <p role="status" className="text-sm text-muted-foreground">
            {shownSteps.length === 0 ? 'Reading your question' : 'Working on the answer'}
          </p>
        ) : null}

        {turn.status === 'error' ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-status-conflict">
            {turn.error}
          </div>
        ) : null}

        {f ? (
          <>
            {f.warnings.length > 0 ? (
              <div role="alert" className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-status-assumed">
                {f.warnings.map((w, i) => (
                  <p key={i} className="flex gap-1.5">
                    <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
                    {w}
                  </p>
                ))}
              </div>
            ) : null}
            <RichText text={f.body} />
            {f.callout ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
                <p className="mb-0.5 flex items-center gap-1.5 text-xs font-semibold text-status-assumed">
                  <TriangleAlert size={13} aria-hidden /> What this answer relies on
                </p>
                <p>{f.callout}</p>
              </div>
            ) : null}
          </>
        ) : null}

        {turn.charts.map((c, i) => (
          <ChartView key={i} chart={c} />
        ))}
        {turn.results
          .filter((r) => r.kind !== 'evidence' || turn.results.length === 1)
          .map((r) => (
            <div key={r.id} className="space-y-2">
              {r.tables.map((t, i) => (
                <ResultTable key={t.name} table={t} resultId={r.id} defaultOpen={i === 0 && turn.results.length <= 2} />
              ))}
            </div>
          ))}

        {turn.exports.length > 0 ? (
          <div className="flex flex-wrap gap-2" aria-label="Downloads">
            {turn.exports.map((x, i) => (
              <a key={i} href={x.url} download={x.filename} className="inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-medium text-accent hover:bg-teal-100">
                <Download size={13} aria-hidden /> {x.filename} <span className="font-normal text-muted-foreground">{x.rows} rows</span>
              </a>
            ))}
          </div>
        ) : null}

        {f && f.alternatives.length > 0 ? (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Another reading of the question:</p>
            <div className="flex flex-wrap gap-2">
              {f.alternatives.map((a, i) => (
                <Btn key={i} small disabled={busy} onClick={() => onAsk(a.question)} title={a.question}>
                  {a.label}
                </Btn>
              ))}
            </div>
          </div>
        ) : null}

        {f ? (
          <details className="rounded-md border border-border text-xs">
            <summary className="cursor-pointer select-none px-3 py-2 font-medium">How I got this</summary>
            <div className="space-y-3 border-t border-border p-3">
              {f.how.reliance.map((r) => (
                <p key={r.result_id}>{r.text}</p>
              ))}
              {f.how.steps.length === 0 ? <p>No tools were called for this answer.</p> : null}
              {f.how.steps.map((s, i) => (
                <div key={i} className="space-y-1">
                  <p className="font-medium">
                    {i + 1}. {s.tool}: <span className="font-normal">{s.summary}</span>
                  </p>
                  {s.sql ? <pre className="overflow-auto rounded bg-muted p-2 text-[11px] leading-snug whitespace-pre-wrap">{s.sql}</pre> : null}
                  {s.scenario ? <p className="rounded bg-muted p-2">Scenario: {s.scenario}</p> : null}
                  <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    {s.rows_used != null ? <span>{s.rows_used} rows used</span> : null}
                    {s.result_id ? (
                      <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => jumpToResult(s.result_id as string)}>
                        Open rows (result {s.result_id})
                      </button>
                    ) : null}
                    {s.evidence_ids.map((id) => (
                      <button key={id} type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => openEvidence(id)}>
                        Open evidence
                      </button>
                    ))}
                  </p>
                </div>
              ))}
              <p className="text-muted-foreground">
                Figures checked against tool results: {f.number_check.checked} checked, {f.number_check.ok ? 'all found' : `${f.number_check.unmatched.length} not found`}.
                {' '}Cost of this answer: Rs {f.usage.cost_inr.toFixed(2)} across {f.usage.model_calls} model {f.usage.model_calls === 1 ? 'call' : 'calls'}.
              </p>
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}
