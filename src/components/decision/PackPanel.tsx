// The decision pack: a PDF memo, an xlsx appendix and a draft approval note for the approver (FR-8.1 to 8.3).
// One model call writes the note. If its figure check fails, the buyer sees a warning and chooses Regenerate
// or the deterministic template. If a cap is hit or the call fails, a labelled template note is used.
import { Check, Copy, Database, Download, FileSpreadsheet, FileText, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatInrCompact } from '../../../engine/format';
import { api, ApiFailure } from '@/lib/api';
import { downloadFile, packBody, type Controls, type PackResponse } from '@/lib/decision';
import { useApp } from '@/lib/store';
import { Btn, Card, Chip } from '@/components/ui';

type State = { phase: 'idle' } | { phase: 'working'; what: string } | { phase: 'done'; res: PackResponse } | { phase: 'error'; message: string };

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API blocked (for example an insecure context): fall back to a hidden selection.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function PackPanel({ controls, disabled, disabledReason }: { controls: Controls; disabled: boolean; disabledReason: string | null }) {
  const { usage, refreshUsage, notify } = useApp();
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [why, setWhy] = useState('');
  const [copied, setCopied] = useState(false);
  const key = JSON.stringify(controls);
  const first = useRef(true);

  // A pack describes one scenario. Changing the scenario clears it, so a stale memo is never on screen.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setState({ phase: 'idle' });
  }, [key]);

  const make = async (mode: 'model' | 'template', regenerate = false) => {
    setCopied(false);
    setState({ phase: 'working', what: mode === 'model' ? 'Writing the approval note with one model call, then building the memo and the workbook.' : 'Building the memo and the workbook with the template note. No model is used.' });
    try {
      const res = await api<PackResponse>('decision', { method: 'POST', body: packBody(controls, why, mode, regenerate) });
      setState({ phase: 'done', res });
      if (res.files) notify('success', 'The decision pack is ready. Download the memo and the appendix below.');
    } catch (e) {
      setState({ phase: 'error', message: (e as ApiFailure).message });
    } finally {
      void refreshUsage();
    }
  };

  const capped = !!usage?.capped;
  const working = state.phase === 'working';

  return (
    <Card className="p-4" aria-label="Decision pack">
      <h2 className="text-sm font-semibold">Decision pack</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        A PDF memo and an xlsx appendix for this scenario. The memo lists every assumption and every unresolved item, and it cannot be produced without them. All figures come from tested code.
      </p>

      <label htmlFor="pack-why" className="mt-3 block text-xs font-medium">
        Why this scenario (optional)
      </label>
      <textarea
        id="pack-why"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        maxLength={600}
        rows={2}
        placeholder="One or two sentences for the approver. Printed in the memo. Never sent to a model."
        className="mt-0.5 w-full resize-y rounded-md border border-border bg-card px-3 py-2 text-sm"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn variant="primary" disabled={disabled || working} onClick={() => void make('model')}>
          <FileText size={14} aria-hidden /> Create decision pack
        </Btn>
        <Btn disabled={disabled || working} onClick={() => void make('template')} title="Uses fixed rules for the approval note. No model call.">
          Create with the template note
        </Btn>
      </div>
      {disabled && disabledReason ? <p className="mt-2 text-xs text-status-conflict">{disabledReason}</p> : null}
      <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
        {capped ? <Database size={12} className="mt-0.5 shrink-0" aria-hidden /> : null}
        {capped
          ? 'Live model calls are paused today, so the pack will use the template note, clearly labelled.'
          : 'Creating a pack makes one live model call, only for the approval note, which costs a few rupees at most. Everything else is computed without a model.'}
      </p>

      {working ? (
        <p role="status" className="mt-3 rounded-md border border-border bg-muted px-3 py-2 text-sm">
          {state.what} This takes a few seconds.
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-status-conflict">
          {state.message}
        </p>
      ) : null}

      {state.phase === 'done' ? <Result res={state.res} copied={copied} onCopy={async () => setCopied(await copyText(state.res.note.text))} onRegenerate={() => void make('model', true)} onTemplate={() => void make('template')} /> : null}
    </Card>
  );
}

function Result({ res, copied, onCopy, onRegenerate, onTemplate }: { res: PackResponse; copied: boolean; onCopy: () => void; onRegenerate: () => void; onTemplate: () => void }) {
  const n = res.note;
  const failed = res.needs_choice;
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-3">
      <p className="text-sm">
        <span className="font-medium">{res.summary.readiness.label}.</span> {res.summary.lines_awarded} of {res.summary.lines_total} lines, goods {formatInrCompact(res.summary.goods_total_inr)} excluding GST
        {res.summary.landed_complete ? '' : ', landed total a floor'}.
      </p>

      {failed ? (
        <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-status-assumed">
            <TriangleAlert size={14} aria-hidden /> The model's draft did not pass the figure check, so no files were made
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {n.check.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">Unverified draft, not for use:</p>
          <p className="mt-0.5 rounded border border-dashed border-amber-300 bg-card px-2 py-1.5 text-sm text-muted-foreground">{n.text}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Btn small onClick={onRegenerate}>
              <RefreshCw size={12} aria-hidden /> Regenerate (one more model call)
            </Btn>
            <Btn small variant="primary" onClick={onTemplate}>
              Use the template note
            </Btn>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Draft approval note</h3>
            <div className="flex items-center gap-2">
              <Chip tone={n.source === 'model' ? 'accent' : 'neutral'}>{n.source === 'model' ? 'Written by the model' : 'Template note'}</Chip>
              <Btn small onClick={onCopy} aria-label="Copy the approval note">
                {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </Btn>
            </div>
          </div>
          <p data-testid="approval-note" className="mt-1.5 whitespace-pre-wrap rounded-md border border-border bg-muted px-3 py-2 text-sm">
            {n.text}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {n.label}
          </p>
          {n.fallback ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-status-assumed">
              <TriangleAlert size={12} aria-hidden /> {n.fallback.message} A template note is used instead.
            </p>
          ) : null}
          {n.source === 'model' ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Model call cost: Rs {n.cost_inr.toFixed(2)}
              {n.cache_hit ? ' (stored reply for identical data, no new call).' : '.'}{' '}
              <button type="button" className="underline underline-offset-2" onClick={onRegenerate}>
                Regenerate
              </button>
            </p>
          ) : null}
        </div>
      )}

      {res.files ? (
        <div className="flex flex-wrap gap-2" aria-label="Downloads">
          <Btn variant="primary" onClick={() => downloadFile(res.files!.memo)}>
            <Download size={14} aria-hidden /> Memo (PDF, {kb(res.files.memo.bytes)})
          </Btn>
          <Btn onClick={() => downloadFile(res.files!.appendix)}>
            <FileSpreadsheet size={14} aria-hidden /> Appendix (xlsx, {kb(res.files.appendix.bytes)})
          </Btn>
          <span className="self-center text-xs text-muted-foreground">{res.files.memo.filename}</span>
        </div>
      ) : null}
    </div>
  );
}
