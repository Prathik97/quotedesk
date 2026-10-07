import { cells, inr, pool } from './common.js';

const all = await cells();
const lines = [...new Set(all.map((c) => c.line))];
const rows = lines.map((line) => {
  const ps = all.filter((c) => c.line === line && c.price != null);
  const min = Math.min(...ps.map((c) => c.price as number));
  const max = Math.max(...ps.map((c) => c.price as number));
  return { line, n: ps.length, min, max, ratio: max / min, abs: max - min, lo: ps.find((c) => c.price === min)!, hi: ps.find((c) => c.price === max)! };
});
console.log('Top 5 by ratio (max over min):');
for (const r of [...rows].sort((a, b) => b.ratio - a.ratio).slice(0, 5)) console.log(`  ${r.line}: ${inr(r.min)} (${r.lo.vendor} ${r.lo.status}) to ${inr(r.max)} (${r.hi.vendor} ${r.hi.status}), ratio ${r.ratio.toFixed(3)}, abs ${inr(r.abs)}`);
console.log('Top 3 by absolute spread:');
for (const r of [...rows].sort((a, b) => b.abs - a.abs).slice(0, 3)) console.log(`  ${r.line}: ${inr(r.min)} to ${inr(r.max)}, abs ${inr(r.abs)}, ratio ${r.ratio.toFixed(3)}`);
for (const l of ['FLM-STR-01', 'INS-TRY-01', 'INS-EDG-01']) {
  console.log(l, all.filter((c) => c.line === l).map((c) => `${c.vendor} ${c.price == null ? '-' : inr(c.price)} ${c.status}`).join(' | '));
}
const s = all.find((c) => c.vendor === 'V5' && c.line === 'FLM-STR-01')!;
console.log(`V5 FLM-STR-01 annual value ${inr((s.price as number) * s.qty)}; V4 ${inr((all.find((c) => c.vendor === 'V4' && c.line === 'FLM-STR-01')!.price as number) * s.qty)}`);
console.log('INS-TRY-01 V3 vs V1 difference:', (Math.abs((all.find((c) => c.vendor === 'V3' && c.line === 'INS-TRY-01')!.price as number) - (all.find((c) => c.vendor === 'V1' && c.line === 'INS-TRY-01')!.price as number))).toFixed(4));
await pool.end();
