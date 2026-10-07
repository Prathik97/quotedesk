import { formatInrCompact } from '../../engine/format';
import { AssumptionsPanel } from '@/components/AssumptionsPanel';
import { AttachmentsTab } from '@/components/AttachmentsTab';
import { ChangeBanner } from '@/components/ChangeBanner';
import { Grid } from '@/components/Grid';
import { QuestionnaireTab } from '@/components/QuestionnaireTab';
import { ReviewQueue } from '@/components/ReviewQueue';
import { SourceView } from '@/components/SourceView';
import { ErrorBox, Loading, PageTitle } from '@/components/ui';
import { useApp, type Tab } from '@/lib/store';
import { cn } from '@/lib/utils';

export function Comparison() {
  const { data, loading, error, reload, tab, setTab } = useApp();
  if (error && !data) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading || !data) return <Loading what="the comparison" />;
  const tabs: { id: Tab; label: string; n?: number }[] = [
    { id: 'grid', label: 'Grid' },
    { id: 'review', label: 'Review queue', n: data.open_review },
    { id: 'questionnaire', label: 'Questionnaire' },
    { id: 'attachments', label: 'Attachments' },
    { id: 'assumptions', label: 'Assumptions' },
    { id: 'source', label: 'Source view' },
  ];
  return (
    <div>
      <PageTitle title="Comparison" sub={`${data.rfx.title}. ${data.lines.length} lines, ${data.vendors.length} vendors, ${formatInrCompact(data.ly_total_inr)} a year at last year's rates. Unit prices are INR per base unit, excluding GST.`} />
      <div role="tablist" aria-label="Comparison views" className="mb-3 flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', tab === t.id ? 'border-accent font-semibold text-accent' : 'border-transparent text-ink-2 hover:text-foreground')}
          >
            {t.label}
            {t.n != null ? <span className="ml-1 text-xs tabular text-muted-foreground">({t.n})</span> : null}
          </button>
        ))}
      </div>
      <ChangeBanner />
      {tab === 'grid' ? <Grid /> : null}
      {tab === 'review' ? <ReviewQueue /> : null}
      {tab === 'questionnaire' ? <QuestionnaireTab /> : null}
      {tab === 'attachments' ? <AttachmentsTab /> : null}
      {tab === 'assumptions' ? <AssumptionsPanel /> : null}
      {tab === 'source' ? <SourceView /> : null}
    </div>
  );
}
