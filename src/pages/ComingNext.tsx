import { Hourglass } from 'lucide-react';
import { PageTitle } from '@/components/ui';

export function ComingNext({ title, what }: { title: string; what: string }) {
  return (
    <div>
      <PageTitle title={title} sub="Coming next" />
      <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
        <Hourglass className="mx-auto text-muted-foreground" size={22} aria-hidden />
        <p className="mt-3 text-sm font-medium">This stage is coming next.</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{what}</p>
      </div>
    </div>
  );
}
