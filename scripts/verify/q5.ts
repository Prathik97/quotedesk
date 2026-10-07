import { cells, cheapest, inr, lakh, crore, pool } from './common.js';

const all = await cells();
const stored = 96;
for (const fx of [96, 92, 85]) {
  const scale = (c: { keys: string[] }) => (c.keys.includes('usd_inr') ? fx / stored : 1);
  const cleared = cheapest(all, ['V1', 'V2', 'V3'], ['confirmed', 'assumed'], scale);
  let n = 0;
  let save = 0;
  for (const [line, w] of Object.entries(cleared.winners)) {
    const c = all.find((x) => x.vendor === 'V5' && x.line === line);
    if (c?.price != null) {
      const p = c.price * scale(c);
      if (p < w.price - 1e-9) {
        n++;
        save += (w.price - p) * c.qty;
      }
    }
  }
  const withV5 = cheapest(all, ['V1', 'V2', 'V3', 'V5'], ['confirmed', 'assumed'], scale);
  console.log(`USD ${fx}: cleared total ${inr(cleared.total)} (${crore(cleared.total)}), saving ${lakh(cleared.saving)} | V5 cheaper on ${n} lines, up to ${inr(save)} | with V5 pending total ${inr(withV5.total)}`);
}
const usdCells = all.filter((c) => c.keys.includes('usd_inr'));
console.log('USD priced cells:', usdCells.map((c) => `${c.vendor} ${c.line}`).join(', '));
await pool.end();
