// App state: the comparison data, the instant client side recompute, view toggles,
// the open evidence drawer and a small toast. All numbers come from the server's
// stored results; nothing here calls a model.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CellStatus } from '../../engine/certainty';
import type { LineOverrides } from '../../engine/recompute';
import type { Assumptions } from '../../engine/types';
import { api, ApiFailure } from './api';
import type { ActionResponse, AssumptionUpdateResponse, CompareResponse, ReviewAction } from './api-types';
import { deriveAll, diffCells, type CellChange, type Patches } from './derive';

export type Page = 'rfx' | 'inbox' | 'comparison' | 'analyst' | 'decision';
export type Tab = 'grid' | 'review' | 'questionnaire' | 'attachments' | 'assumptions' | 'source';
export type Toggles = { onlyCleared: boolean; includeDiscounts: boolean; annualValue: boolean; onlyAttention: boolean };
export type Selection =
  | { kind: 'cell'; vendor_id: string; rfx_line_id: string; quote_line_id: string | null }
  | { kind: 'answer'; vendor_id: string; question_id: string };
export type SourceTarget = { vendor_id: string; document_id?: string | null; quote_line_id?: string | null };
export type Change = { id: number; title: string; changes: CellChange[]; local_ms: number; server_ms: number | null; pending: boolean; blocked_note?: string };
export type Toast = { id: number; kind: 'info' | 'success' | 'error'; text: string };

type Ctx = {
  data: CompareResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  version: number;
  page: Page;
  setPage: (p: Page) => void;
  tab: Tab;
  setTab: (t: Tab) => void;
  toggles: Toggles;
  setToggle: (k: keyof Toggles, v: boolean) => void;
  statusFilter: CellStatus | null;
  setStatusFilter: (s: CellStatus | null) => void;
  selection: Selection | null;
  openCell: (vendor_id: string, rfx_line_id: string, quote_line_id: string | null) => void;
  openAnswer: (vendor_id: string, question_id: string) => void;
  closeDrawer: () => void;
  sourceTarget: SourceTarget | null;
  openSource: (t: SourceTarget) => void;
  setAssumption: (key: 'usd_inr' | 'gst_pct', value: number | null) => Promise<void>;
  act: (a: ReviewAction) => Promise<boolean>;
  change: Change | null;
  clearChange: () => void;
  toast: Toast | null;
  notify: (kind: Toast['kind'], text: string) => void;
  busy: number;
  flashIds: Set<string>;
};

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp must be used inside AppProvider');
  return c;
}

let seq = 1;

export function AppProvider({ children }: { children: ReactNode }) {
  const [server, setServer] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [page, setPage] = useState<Page>('comparison');
  const [tab, setTab] = useState<Tab>('grid');
  const [toggles, setToggles] = useState<Toggles>({ onlyCleared: false, includeDiscounts: false, annualValue: false, onlyAttention: false });
  const [statusFilter, setStatusFilter] = useState<CellStatus | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sourceTarget, setSourceTarget] = useState<SourceTarget | null>(null);
  const [localA, setLocalA] = useState<Partial<Assumptions>>({});
  const [patches, setPatches] = useState<Patches>({});
  const [change, setChange] = useState<Change | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(0);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((kind: Toast['kind'], text: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: seq++, kind, text });
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 9000 : 5000);
  }, []);

  const reload = useCallback(async () => {
    try {
      const d = await api<CompareResponse>('compare');
      setServer(d);
      setError(null);
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const serverA = useMemo<Assumptions>(() => {
    const g = (k: 'usd_inr' | 'gst_pct') => Number(server?.assumptions.find((a) => a.key === k)?.value ?? (k === 'usd_inr' ? 96 : 18));
    return { usd_inr: g('usd_inr'), gst_pct: g('gst_pct') };
  }, [server]);
  const effective: Assumptions = { ...serverA, ...localA };

  const data = useMemo(() => {
    if (!server) return null;
    const d = deriveAll(server, effective, patches);
    return {
      ...d,
      assumptions: d.assumptions.map((a) =>
        a.key === 'usd_inr' && localA.usd_inr != null
          ? { ...a, value: localA.usd_inr, set_by: 'buyer' as const }
          : a.key === 'gst_pct' && localA.gst_pct != null
            ? { ...a, value: localA.gst_pct, set_by: 'buyer' as const }
            : a,
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, localA.usd_inr, localA.gst_pct, patches]);

  const flash = useCallback((changes: CellChange[], d: CompareResponse | null) => {
    if (!d) return;
    const key = new Map(d.vendors.map((v) => [v.key, v.id]));
    const line = new Map(d.lines.map((l) => [l.code, l.id]));
    setFlashIds(new Set(changes.map((c) => `${key.get(c.vendor_key)}:${line.get(c.code)}`)));
    window.setTimeout(() => setFlashIds(new Set()), 1600);
  }, []);

  const enqueue = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(fn, fn);
    chain.current = run.catch(() => undefined);
    return run;
  }, []);

  const setAssumption = useCallback(
    async (key: 'usd_inr' | 'gst_pct', value: number | null) => {
      if (!server) return;
      const before = data;
      const next = value ?? (server.assumptions.find((a) => a.key === key)?.default_value ?? effective[key]);
      const t0 = performance.now();
      const after = deriveAll(server, { ...effective, [key]: next }, patches);
      const changes = before ? diffCells(before, after) : [];
      const id = seq++;
      setLocalA((l) => ({ ...l, [key]: next }));
      const label = key === 'usd_inr' ? `USD to INR set to ${next}` : `GST set to ${next} percent`;
      setChange({ id, title: label, changes, local_ms: Math.round(performance.now() - t0), server_ms: null, pending: true });
      flash(changes, before);
      setBusy((b) => b + 1);
      try {
        const res = await enqueue(() => api<AssumptionUpdateResponse>('assumptions', { method: 'POST', body: { key, value } }));
        await reload();
        setLocalA({});
        setChange((c) => (c && c.id === id ? { ...c, server_ms: res.recompute.ms, pending: false } : c));
      } catch (e) {
        setLocalA((l) => {
          const n = { ...l };
          delete n[key];
          return n;
        });
        setChange(null);
        notify('error', `The change was not saved. ${(e as ApiFailure).message}`);
      } finally {
        setBusy((b) => b - 1);
      }
    },
    [server, data, effective, patches, enqueue, reload, flash, notify],
  );

  const act = useCallback(
    async (a: ReviewAction): Promise<boolean> => {
      if (!server || !data) return false;
      let optimistic: LineOverrides | null = null;
      let qid: string | null = null;
      if ('quote_line_id' in a) {
        qid = a.quote_line_id;
        const cell = data.cells.find((c) => c.quote_line_id === qid);
        const line = data.lines.find((l) => l.id === cell?.rfx_line_id);
        const old = (cell?.raw?.overrides ?? {}) as LineOverrides;
        if (a.action === 'accept') optimistic = { ...old, verified: true };
        else if (a.action === 'edit') optimistic = { ...old, verified: true, price: a.price, ...(a.currency ? { currency: a.currency } : {}), ...(a.uom_text ? { uom_text: a.uom_text } : {}) };
        else if (a.action === 'unit' && line) optimistic = { ...old, verified: true, pack: { quantity: a.quantity, unit: line.uom } };
        else if (a.action === 'not_quoted') optimistic = { ...old, not_quoted: true };
        else if (a.action === 'undo') optimistic = {};
      }
      const before = data;
      const t0 = performance.now();
      const id = seq++;
      if (qid && optimistic) {
        const nextPatches = { ...patches, [qid]: optimistic };
        const after = deriveAll(server, effective, nextPatches);
        const changes = diffCells(before, after);
        setPatches(nextPatches);
        setChange({ id, title: ACTION_TITLE[a.action], changes, local_ms: Math.round(performance.now() - t0), server_ms: null, pending: true });
        flash(changes, before);
      } else {
        setChange({ id, title: ACTION_TITLE[a.action], changes: [], local_ms: 0, server_ms: null, pending: true });
      }
      setBusy((b) => b + 1);
      try {
        const res = await enqueue(() => api<ActionResponse>('review', { method: 'POST', body: a }));
        await reload();
        setPatches({});
        setChange((c) => (c && c.id === id ? { ...c, server_ms: res.recompute.ms, pending: false } : c));
        return true;
      } catch (e) {
        setPatches((p) => {
          const n = { ...p };
          if (qid) delete n[qid];
          return n;
        });
        setChange(null);
        notify('error', `That was not saved. ${(e as ApiFailure).message}`);
        return false;
      } finally {
        setBusy((b) => b - 1);
      }
    },
    [server, data, effective, patches, enqueue, reload, flash, notify],
  );

  const value: Ctx = {
    data,
    loading,
    error,
    reload,
    version,
    page,
    setPage,
    tab,
    setTab,
    toggles,
    setToggle: (k, v) => setToggles((t) => ({ ...t, [k]: v })),
    statusFilter,
    setStatusFilter,
    selection,
    openCell: (vendor_id, rfx_line_id, quote_line_id) => setSelection({ kind: 'cell', vendor_id, rfx_line_id, quote_line_id }),
    openAnswer: (vendor_id, question_id) => setSelection({ kind: 'answer', vendor_id, question_id }),
    closeDrawer: () => setSelection(null),
    sourceTarget,
    openSource: (t) => {
      setSourceTarget(t);
      setSelection(null);
      setPage('comparison');
      setTab('source');
    },
    setAssumption,
    act,
    change,
    clearChange: () => setChange(null),
    toast,
    notify,
    busy,
    flashIds,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

const ACTION_TITLE: Record<ReviewAction['action'], string> = {
  accept: 'Accepted as read',
  edit: 'Value edited',
  unit: 'Unit meaning set',
  not_quoted: 'Marked as not quoted',
  dismiss: 'Item dismissed with a reason',
  undo: 'Buyer changes undone',
};
