// The RFx page: two modes. "Draft with the co-pilot" is live and belongs to this browser. "Issued RFx (saved)"
// is the seeded FY27 RFx that the stored vendor replies answer, loaded only when the buyer asks for it.
import { useState } from 'react';
import { Copilot } from '@/components/copilot/Copilot';
import { PageTitle } from '@/components/ui';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import { IssuedRfx } from '@/pages/IssuedRfx';

type Mode = 'draft' | 'saved';

export function Rfx() {
  const { setPage } = useApp();
  const [mode, setMode] = useState<Mode>('draft');
  return (
    <div>
      <PageTitle
        title="RFx"
        sub={mode === 'draft' ? 'Draft a new RFx by talking to the co-pilot, then issue it. Dispatch is simulated: no email leaves the system.' : 'The saved FY27 RFx. Read only.'}
      />
      <div role="tablist" aria-label="RFx mode" className="mb-4 flex gap-1 border-b border-border">
        {(
          [
            ['draft', 'Draft with the co-pilot'],
            ['saved', 'Issued RFx (saved)'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id} type="button" role="tab" id={`rfx-tab-${id}`} aria-selected={mode === id} aria-controls={`rfx-panel-${id}`}
            onClick={() => setMode(id)}
            className={cn('-mb-px border-b-2 px-3 py-1.5 text-sm font-medium', mode === id ? 'border-accent text-accent' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="rfx-panel-draft" aria-labelledby="rfx-tab-draft" hidden={mode !== 'draft'}>
        <Copilot onOpenOutbox={() => setPage('outbox')} />
      </div>
      <div role="tabpanel" id="rfx-panel-saved" aria-labelledby="rfx-tab-saved" hidden={mode !== 'saved'}>
        {mode === 'saved' ? <IssuedRfx /> : null}
      </div>
    </div>
  );
}
