// Read only page of the saved RFx. Labelled "Issued RFx (saved)".
import { useEffect, useState } from 'react';
import { formatInrCompact, formatIndian, formatQty } from '../../engine/format';
import { api } from '@/lib/api';
import type { RfxResponse } from '@/lib/api-types';
import { Chip, ErrorBox, Loading, PageTitle } from '@/components/ui';

export function IssuedRfx() {
  const [r, setR] = useState<RfxResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<RfxResponse>('rfx').then(setR).catch((e: Error) => setErr(e.message));
  }, []);
  if (err) return <ErrorBox message={err} />;
  if (!r) return <Loading what="the saved RFx" />;
  const sections: { name: string; lines: RfxResponse['lines'] }[] = [];
  for (const l of r.lines) {
    const g = sections[sections.length - 1];
    if (g && g.name === l.section) g.lines.push(l);
    else sections.push({ name: l.section, lines: [l] });
  }
  const x = r.rfx;
  return (
    <div className="space-y-5">
      <PageTitle
        title="Issued RFx (saved)"
        sub="Read only. This is the saved RFx the vendor replies were generated against. Drafting a new one arrives with the co-pilot."
        right={<Chip tone="accent">Saved, read only</Chip>}
      />
      <section aria-label="RFx summary" className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-base font-semibold">{x.title}</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
          <Item k="Buyer" v={x.buyer_org} />
          <Item k="Reference" v={x.ref ?? 'Not set'} />
          <Item k="Status" v={x.status === 'issued' ? 'Issued' : 'Draft'} />
          <Item k="Delivery" v={x.delivery_location ?? 'Not set'} />
          <Item k="Payment terms requested" v={x.payment_terms_requested_days != null ? `${x.payment_terms_requested_days} days` : 'Not set'} />
          <Item k="Quote validity" v={x.validity_days != null ? `${x.validity_days} days` : 'Not set'} />
          <Item k="Prices" v={x.gst_basis_requested === 'excl_gst' ? `${x.currency}, excluding GST` : `${x.currency}, ${x.gst_basis_requested ?? 'basis not set'}`} />
          <Item k="Spend at last year's rates" v={`${formatInrCompact(r.ly_total_inr)} (${formatIndian(r.ly_total_inr, 0)})`} />
        </dl>
      </section>

      <section aria-label="Line items" className="rounded-lg border border-border bg-card">
        <h2 className="border-b border-border px-4 py-2 text-sm font-semibold">{r.lines.length} line items</h2>
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="w-[12%] px-4 py-1.5 font-medium">Code</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Description</th>
              <th scope="col" className="w-[8%] px-2 py-1.5 font-medium">Unit</th>
              <th scope="col" className="w-[14%] px-2 py-1.5 text-right font-medium">Annual quantity</th>
              <th scope="col" className="w-[14%] px-4 py-1.5 text-right font-medium">Last year rate</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => (
              <SectionBody key={s.name} name={s.name} lines={s.lines} />
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Questionnaire" className="rounded-lg border border-border bg-card">
        <h2 className="border-b border-border px-4 py-2 text-sm font-semibold">Questionnaire, {r.questions.length} questions, {r.questions.filter((q) => q.is_knockout).length} knockouts</h2>
        <ul className="divide-y divide-border">
          {r.questions.map((q) => (
            <li key={q.code} className="flex items-start gap-3 px-4 py-2 text-sm">
              <span className="w-8 shrink-0 font-semibold tabular">{q.code}</span>
              <span className="flex-1">{q.text}</span>
              {q.is_knockout ? <Chip tone="warn">Knockout: {q.rule_text}</Chip> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SectionBody({ name, lines }: { name: string; lines: RfxResponse['lines'] }) {
  return (
    <>
      <tr className="bg-slate-50">
        <th scope="rowgroup" colSpan={5} className="border-t border-border px-4 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-2">
          {name}
        </th>
      </tr>
      {lines.map((l) => (
        <tr key={l.id} className="border-t border-border text-sm">
          <td className="px-4 py-1.5 font-semibold tabular text-ink-2">{l.code}</td>
          <td className="px-2 py-1.5">{l.description}</td>
          <td className="px-2 py-1.5">{l.uom}</td>
          <td className="px-2 py-1.5 text-right tabular">{formatQty(l.annual_qty)}</td>
          <td className="px-4 py-1.5 text-right tabular">{l.ly_rate != null ? formatIndian(l.ly_rate, 2) : 'Not available'}</td>
        </tr>
      ))}
    </>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
