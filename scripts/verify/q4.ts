import { cells, cheapest, inr, lakh, crore, pool } from './common.js';

const all = await cells();
const show = (label: string, vendors: string[]) => {
  const r = cheapest(all, vendors);
  const by: Record<string, { n: number; v: number; assumed: number; av: number }> = {};
  for (const w of Object.values(r.winners)) {
    by[w.vendor] ??= { n: 0, v: 0, assumed: 0, av: 0 };
    by[w.vendor]!.n++;
    by[w.vendor]!.v += w.value;
    if (w.status === 'assumed') {
      by[w.vendor]!.assumed++;
      by[w.vendor]!.av += w.value;
    }
  }
  console.log(`${label}: total ${inr(r.total)} (${crore(r.total)}), saving ${inr(r.saving)} (${lakh(r.saving)}, ${(r.saving / r.ly * 100).toFixed(2)} percent)`);
  for (const [v, x] of Object.entries(by)) console.log(`   ${v}: ${x.n} lines, ${inr(x.v)} (${lakh(x.v)}), share ${(x.v / r.total * 100).toFixed(2)} percent, assumed ${x.assumed} cells worth ${inr(x.av)} (${lakh(x.av)})`);
  return r;
};
const a = show('cleared only V1 V2 V3', ['V1', 'V2', 'V3']);
const b = show('cleared + V5 pending', ['V1', 'V2', 'V3', 'V5']);
const c = show('all vendors', ['V1', 'V2', 'V3', 'V4', 'V5']);
console.log(`Cost of excluding V4 and V5 (all minus cleared): ${lakh(a.total - c.total)}; cleared+V5 minus cleared: ${lakh(a.total - b.total)}`);
const d = show('V1 V2 V3 V4 (no V5)', ['V1', 'V2', 'V3', 'V4']);
console.log(`Cost of excluding V4 alone from that set: ${lakh(a.total - d.total)}`);
const t = await pool.query(`select v.vendor_key, t.freight_terms, t.freight_note from vendors v join vendor_terms t on t.vendor_id=v.id where v.vendor_key in ('V1','V3','V4','V5') order by 1`);
console.log(t.rows.map((r) => `${r.vendor_key}: ${r.freight_terms} / ${r.freight_note}`).join('\n'));
await pool.end();
