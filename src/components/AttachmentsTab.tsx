// Attachments tab (FR-6.8): documents per vendor with parsed key facts and flags.
import { Paperclip } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Btn, Chip, StoredLabel } from './ui';

const KIND: Record<string, string> = { quote: 'Quote', questionnaire: 'Questionnaire', certificate: 'Certificate', profile: 'Profile', other: 'Other (skipped)' };

export function AttachmentsTab() {
  const { data, openSource } = useApp();
  if (!data) return null;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Every file each vendor sent, what it was read as, and what was found in it. Flags come from deterministic checks, not from a model.</p>
        <StoredLabel stored={data.stored} />
      </div>
      {data.vendors.map((v) => {
        const docs = data.attachments.filter((a) => a.vendor_id === v.id);
        return (
          <section key={v.id} className="rounded-lg border border-border bg-card" aria-label={`${v.name} attachments`}>
            <h3 className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm font-semibold">
              <Paperclip size={14} aria-hidden /> {v.name} <span className="font-normal text-muted-foreground">({v.key}), {docs.length} {docs.length === 1 ? 'file' : 'files'}</span>
            </h3>
            <table className="w-full table-fixed border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="w-[28%] px-4 py-1.5 font-medium">File</th>
                  <th scope="col" className="w-[12%] px-2 py-1.5 font-medium">Read as</th>
                  <th scope="col" className="w-[34%] px-2 py-1.5 font-medium">Key facts</th>
                  <th scope="col" className="w-[18%] px-2 py-1.5 font-medium">Flags</th>
                  <th scope="col" className="w-[8%] px-2 py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} className="border-t border-border align-top">
                    <td className="px-4 py-2 text-xs break-words">
                      <div className="font-medium">{d.filename}</div>
                      <div className="text-muted-foreground">{d.status}{d.error ? `: ${d.error}` : ''}</div>
                    </td>
                    <td className="px-2 py-2 text-xs">{d.kind ? KIND[d.kind] ?? d.kind : 'Not read'}{d.lines > 0 ? <div className="text-muted-foreground tabular">{d.lines} lines</div> : null}</td>
                    <td className="px-2 py-2 text-xs">
                      {d.facts ? (
                        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                          {d.facts.standard ? (<><dt className="text-muted-foreground">Standard</dt><dd>{d.facts.standard}</dd></>) : null}
                          {d.facts.certificate_number ? (<><dt className="text-muted-foreground">Number</dt><dd className="tabular">{d.facts.certificate_number}</dd></>) : null}
                          {d.facts.legal_name ? (<><dt className="text-muted-foreground">Legal name</dt><dd>{d.facts.legal_name}</dd></>) : null}
                          {d.facts.trade_name ? (<><dt className="text-muted-foreground">Trade name</dt><dd>{d.facts.trade_name}</dd></>) : null}
                          {d.facts.issue_date ? (<><dt className="text-muted-foreground">Issued</dt><dd className="tabular">{d.facts.issue_date}</dd></>) : null}
                          {d.facts.expiry_date ? (<><dt className="text-muted-foreground">Expires</dt><dd className="tabular">{d.facts.expiry_date}</dd></>) : null}
                        </dl>
                      ) : d.kind === 'quote' || d.kind === 'questionnaire' ? (
                        <span className="text-muted-foreground">Prices and answers are in the grid and the questionnaire tab.</span>
                      ) : (
                        <span className="text-muted-foreground">No facts extracted.</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        {d.flags.includes('expired') ? <Chip tone="bad">Expired</Chip> : null}
                        {d.flags.includes('name_mismatch') ? <Chip tone="warn">Legal name differs from the quote</Chip> : null}
                        {d.flags.length === 0 ? <span className="text-xs text-muted-foreground">None</span> : null}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Btn small onClick={() => openSource({ vendor_id: v.id, document_id: d.id })}>
                        View
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
