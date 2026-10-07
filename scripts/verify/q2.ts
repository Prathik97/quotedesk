import { cells, cheapest, inr, lakh, crore, questionnaire, pool } from './common.js';

const all = await cells();
const q = await questionnaire();
const cleared = Object.keys(q).filter((k) => q[k] === 'Cleared');
console.log('Cleared vendors (from flags):', cleared.join(', '));
const r = cheapest(all, cleared);
const byV: Record<string, { lines: number; value: number }> = {};
for (const w of Object.values(r.winners)) {
  byV[w.vendor] ??= { lines: 0, value: 0 };
  byV[w.vendor]!.lines++;
  byV[w.vendor]!.value += w.value;
}
console.log(`Total ${inr(r.total)} (${crore(r.total)}), lines ${r.lines}, LY of those lines ${inr(r.ly)}, saving ${inr(r.saving)} (${lakh(r.saving)}), ${(r.saving / r.ly * 100).toFixed(2)} percent`);
for (const [v, x] of Object.entries(byV)) console.log(`  ${v}: ${x.lines} lines, ${inr(x.value)} (${lakh(x.value)}), share ${(x.value / r.total * 100).toFixed(2)} percent`);
for (const ex of ['V4', 'V5']) {
  let n = 0;
  let save = 0;
  for (const [line, w] of Object.entries(r.winners)) {
    const c = all.find((x) => x.vendor === ex && x.line === line);
    if (c?.price != null && ['confirmed', 'assumed'].includes(c.status) && c.price < w.price - 1e-9) {
      n++;
      save += (w.price - c.price) * c.qty;
    }
  }
  console.log(`  ${ex} cheaper on ${n} lines, saving if taken ${inr(save)} (${lakh(save)})`);
}
const v3 = all.filter((c) => c.vendor === 'V3' && c.price == null).map((c) => c.line);
console.log('V3 unquoted lines:', v3.join(', '), '; covered by winners:', v3.map((l) => r.winners[l]?.vendor).join(', '));
await pool.end();
