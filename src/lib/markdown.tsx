// A small, safe markdown renderer for the committed eval reports: headings, paragraphs, tables,
// bullet and numbered lists, **bold** and `code`. It builds React elements only, never HTML strings.
import type { ReactNode } from 'react';

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('**') ? <strong key={`${keyBase}-${i++}`}>{inline(tok.slice(2, -2), `${keyBase}-${i}`)}</strong> : <code key={`${keyBase}-${i++}`} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isSeparator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = (h[1] ?? '#').length;
      const cls = level === 1 ? 'mt-2 text-xl font-semibold tracking-tight' : level === 2 ? 'mt-6 border-b border-border pb-1 text-base font-semibold' : 'mt-4 text-sm font-semibold';
      const text = inline(h[2] ?? '', `h${k}`);
      blocks.push(level === 1 ? <h2 key={k++} className={cls}>{text}</h2> : level === 2 ? <h3 key={k++} className={cls}>{text}</h3> : <h4 key={k++} className={cls}>{text}</h4>);
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && isSeparator(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) rows.push(cells(lines[i++] ?? ''));
      blocks.push(
        <div key={k++} className="mt-2 overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-muted">
              <tr>{head.map((c, j) => <th key={j} scope="col" className="border-b border-border px-2 py-1.5 font-medium">{inline(c, `th${k}-${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-border last:border-0">
                  {r.map((c, j) => <td key={j} className="px-2 py-1.5 align-top">{inline(c, `td${k}-${ri}-${j}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+\.\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i] ?? '')) items.push((lines[i++] ?? '').replace(re, ''));
      const li = items.map((t, j) => <li key={j}>{inline(t, `li${k}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={k++} className="mt-2 list-decimal space-y-1.5 pl-5 text-sm">{li}</ol> : <ul key={k++} className="mt-2 list-disc space-y-1.5 pl-5 text-sm">{li}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() && !/^(#{1,3}\s|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i] ?? '')) para.push(lines[i++] ?? '');
    if (para.length === 0) {
      para.push(lines[i++] ?? '');
    }
    blocks.push(<p key={k++} className="mt-2 text-sm leading-relaxed">{inline(para.join(' '), `p${k}`)}</p>);
  }
  return <div>{blocks}</div>;
}
