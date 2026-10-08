// The evaluation reports (FR-10.3), read only. They are the committed output of real runs:
// eval/EVAL_REPORT.md from `npm run eval`, and eval/ANALYST_REPORT.md from the phase 5 analyst tests.
// Nothing here is computed in the browser and nothing here calls a model.
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import analystReport from '../../eval/ANALYST_REPORT.md?raw';
import extractionReport from '../../eval/EVAL_REPORT.md?raw';
import { PageTitle } from '@/components/ui';
import { Markdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

const TABS = [
  { id: 'extraction', label: 'Extraction eval', source: extractionReport },
  { id: 'analyst', label: 'Analyst tests', source: analystReport },
] as const;

export function Eval() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('extraction');
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <div className="mx-auto max-w-4xl">
      <PageTitle title="Evaluation" sub="How well the system read the five vendor replies, scored against a hidden answer key. Read only." />
      <div role="note" className="mb-4 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
        <TriangleAlert size={16} className="mt-0.5 shrink-0 text-status-assumed" aria-hidden />
        <p>
          <strong>This is not a held out test.</strong> The prompts and rules were developed against these same documents and questions. A perfect score here shows the pipeline handles the planted cases. It does not predict accuracy on a file you bring.
        </p>
      </div>
      <div role="tablist" aria-label="Reports" className="mb-3 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`eval-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="eval-panel"
            onClick={() => setTab(t.id)}
            className={cn('-mb-px border-b-2 px-3 py-1.5 text-sm', tab === t.id ? 'border-accent font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <article id="eval-panel" role="tabpanel" aria-labelledby={`eval-tab-${current.id}`} className="pb-8">
        <Markdown source={current.source} />
      </article>
    </div>
  );
}
