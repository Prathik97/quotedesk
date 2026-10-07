import { cells, cheapest, inr, lakh, crore, pool } from './common.js';

const all = await cells();
const cleared = ['V1', 'V2', 'V3'];
const disc = (c: { vendor: string; conds: string[] }) => c.vendor === 'V2' && c.conds.some((x) => /4\s*(%|percent)/i.test(x) && /discount/i.test(x));
const carrying = all.filter(disc);
console.log(`V2 cells carrying the 4 percent condition: ${carrying.length} (${carrying.map((c) => c.sort).sort((a, b) => a - b).join(',')})`);
const base = cheapest(all, cleared);
const scaled = cheapest(all, cleared, ['confirmed', 'assumed'], (c) => (disc(c as never) ? 0.96 : 1));
const v2won = Object.entries(scaled.winners).filter(([, w]) => w.vendor === 'V2');
const listPo = v2won.reduce((s, [line]) => { const c = all.find((x) => x.vendor === 'V2' && x.line === line)!; return s + (c.price as number) * c.qty; }, 0);
console.log(`Baseline total ${inr(base.total)} saving ${lakh(base.saving)}; V2 wins ${Object.values(base.winners).filter((w) => w.vendor === 'V2').length} lines`);
console.log(`With discount (V2 at 0.96 on carrying lines): total ${inr(scaled.total)} (${crore(scaled.total)}), saving ${inr(scaled.saving)} (${lakh(scaled.saving)}, ${(scaled.saving / scaled.ly * 100).toFixed(2)} percent)`);
console.log(`V2 wins ${v2won.length} lines: ${v2won.map(([l]) => l).join(', ')}; PO at list ${inr(listPo)}; threshold met (above 25,00,000): ${listPo > 2500000}; 4 percent of that PO ${inr(listPo * 0.04)}`);
console.log('Winner change on lines 1 to 14:');
for (const c of all.filter((x) => x.vendor === 'V1' && x.sort <= 14)) {
  const b = base.winners[c.line]!;
  const s = scaled.winners[c.line]!;
  if (b.vendor !== s.vendor) console.log(`  ${c.line}: ${b.vendor} ${b.price.toFixed(4)} -> ${s.vendor} ${s.price.toFixed(4)} (list ${all.find((x) => x.vendor === s.vendor && x.line === c.line)!.price!.toFixed(4)})`);
}
// What if V2 took all of lines 1 to 14 as one PO?
const all14 = all.filter((c) => c.vendor === 'V2' && c.sort <= 14).reduce((s, c) => s + (c.price as number) * c.qty, 0);
console.log(`V2 whole of lines 1 to 14 at list: ${inr(all14)}; discount would be ${inr(all14 * 0.04)}`);
await pool.end();
