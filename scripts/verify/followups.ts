import { cells, cheapest, inr, lakh, crore, pool } from './common.js';

const all = await cells();
for (const [label, vs] of [['follow-up 1: cleared minus V3 (V1, V2)', ['V1', 'V2']], ['follow-up 2: cleared minus V1 (V2, V3)', ['V2', 'V3']]] as const) {
  const r = cheapest(all, [...vs]);
  const by: Record<string, { n: number; v: number }> = {};
  for (const w of Object.values(r.winners)) { by[w.vendor] ??= { n: 0, v: 0 }; by[w.vendor]!.n++; by[w.vendor]!.v += w.value; }
  console.log(`${label}: total ${inr(r.total)} (${crore(r.total)}), saving ${inr(r.saving)} (${lakh(r.saving)}, ${(r.saving / r.ly * 100).toFixed(2)}%)`);
  for (const [v, x] of Object.entries(by)) console.log(`   ${v}: ${x.n} lines, ${inr(x.v)}, share ${(x.v / r.total * 100).toFixed(2)}%`);
  for (const ex of ['V3', 'V1', 'V4', 'V5'].filter((e) => !vs.includes(e as never))) {
    let n = 0, s = 0;
    for (const [line, w] of Object.entries(r.winners)) { const c = all.find((x) => x.vendor === ex && x.line === line); if (c?.price != null && ['confirmed', 'assumed'].includes(c.status) && c.price < w.price - 1e-9) { n++; s += (w.price - c.price) * c.qty; } }
    console.log(`   ${ex} cheaper on ${n} lines, up to ${lakh(s)}`);
  }
}
const v2 = all.filter((c) => c.vendor === 'V2' && c.conds.some((x) => /4\s*(%|percent)/i.test(x)));
const r2 = cheapest(all, ['V2', 'V3']);
const v2lines = Object.entries(r2.winners).filter(([, w]) => w.vendor === 'V2').map(([l]) => l);
console.log('V2 lines won:', v2lines.join(', '), 'potential discount on carrying lines won:', inr(v2lines.filter((l) => v2.some((c) => c.line === l)).reduce((s, l) => { const c = all.find((x) => x.vendor === 'V2' && x.line === l)!; return s + (c.price as number) * c.qty * 0.04; }, 0)));
await pool.end();
