// Independent check of the decision memo. It generates memos (template note, no model call), reads the
// numbers printed in the PDF, and compares them with a recomputation from the base tables using plain SQL
// and plain JavaScript. It shares no award code with engine/award.ts or the memo builder, and it does not
// read truth.json.
//   npm run verify:decision        (Node 22)
import { PDFArray, PDFDocument, decodePDFRawStream, type PDFRawStream } from 'pdf-lib';
import { cells, pool, questionnaire, type Cell } from './common.js';

const { loadAnalystData } = await import('../../api/_lib/analyst/data.js');
const { buildPack } = await import('../../api/_lib/decision/pack.js');
const { memoBlocks, renderMemo } = await import('../../api/_lib/decision/memo.js');
const { templateResult } = await import('../../api/_lib/decision/note.js');
const { db } = await import('../../api/_lib/db.js');

const f = (n: number, d = 0) => Number(n.toFixed(d)).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const runs: string[] = [];
  for (const page of doc.getPages()) {
    const c = page.node.Contents();
    const streams = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
    for (const st of streams) {
      const text = Buffer.from(decodePDFRawStream(st as PDFRawStream).decode()).toString('latin1');
      for (const m of text.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) runs.push(Buffer.from(m[1] as string, 'hex').toString('latin1'));
    }
  }
  return runs.join(' ').replace(/\s+/g, ' ');
}

let pass = 0;
let fail = 0;
function check(name: string, text: string, needle: string | RegExp) {
  const ok = typeof needle === 'string' ? text.includes(needle) : needle.test(text);
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}: not found in the memo: ${needle}`);
  }
}

// ---- independent recomputation helpers (plain JS)
const all: Cell[] = await cells();
const q = await questionnaire();
const lines = [...new Set(all.map((c) => c.line))];
const carries = (conds: string[], pct: number) => conds.some((c) => new RegExp(`(^|[^\\d.])${pct}\\s*(%|percent|per cent)`, 'i').test(c) && /discount|rebate|off\b/i.test(c));

/** Cheapest per line over vendors, with an optional 4 percent discount on V2's discount lines and a USD scale. */
function award(vendors: string[], opts: { fx?: number; v2disc?: boolean } = {}) {
  const fx = opts.fx ?? 96;
  const adj = (c: Cell) => (c.price as number) * (c.keys.includes('usd_inr') ? fx / 96 : 1) * (opts.v2disc && c.vendor === 'V2' && carries(c.conds, 4) ? 0.96 : 1);
  let total = 0, ly = 0;
  const win: Record<string, { v: string; p: number; list: number; value: number; saving: number; status: string }> = {};
  for (const l of lines) {
    const offers = all.filter((c) => c.line === l && vendors.includes(c.vendor) && c.price != null && ['confirmed', 'assumed'].includes(c.status)).map((c) => ({ c, p: adj(c) }));
    offers.sort((a, b) => a.p - b.p);
    const w = offers[0];
    if (!w) continue;
    const value = w.p * w.c.qty;
    win[l] = { v: w.c.vendor, p: w.p, list: ((w.c.price as number) * (w.c.keys.includes('usd_inr') ? fx / 96 : 1)), value, saving: w.c.ly * w.c.qty - value, status: w.c.status };
    total += value;
    ly += w.c.ly * w.c.qty;
  }
  const byV: Record<string, number> = {};
  for (const w of Object.values(win)) byV[w.v] = (byV[w.v] ?? 0) + w.value;
  return { win, total, ly, saving: ly - total, byV, lines: Object.keys(win).length };
}
/** Discount equilibrium: V2's 4 percent applies only if V2's allocation at list price is above Rs 25 lakh. Both starts, cheaper consistent one. */
function awardWithDiscount(vendors: string[], fx = 96) {
  const poAt = (r: ReturnType<typeof award>) => Object.values(r.win).filter((w) => w.v === 'V2').reduce((s, w) => s + w.list * (all.find((c) => c.vendor === 'V2' && c.price != null && Math.abs((c.price as number) * (c.keys.includes('usd_inr') ? fx / 96 : 1) - w.list) < 1e-9)?.qty ?? 0), 0);
  const none = award(vendors, { fx });
  const on = award(vendors, { fx, v2disc: true });
  const okNone = !vendors.includes('V2') || poAt(none) <= 2_500_000;
  const okOn = vendors.includes('V2') && poAt(on) > 2_500_000;
  const consistent = [okNone ? none : null, okOn ? on : null].filter(Boolean) as ReturnType<typeof award>[];
  return consistent.sort((a, b) => a.total - b.total)[0] ?? none;
}

const data = await loadAnalystData(db());
const stamp = new Date();
async function memoFor(req: Parameters<typeof buildPack>[1]) {
  const pack = buildPack(data, req, stamp);
  const bytes = await renderMemo(memoBlocks(pack, templateResult(pack)), { title: 't', subject: 's', header: 'h', footer: 'f', now: stamp });
  return { pack, text: await pdfText(bytes) };
}

const cleared = Object.entries(q).filter(([, r]) => r === 'Cleared').map(([k]) => k);
const clearedPending = Object.entries(q).filter(([, r]) => r === 'Cleared' || r === 'Pending').map(([k]) => k);

async function scenario(name: string, req: Parameters<typeof buildPack>[1], vendors: string[], opts: { discount?: boolean } = {}) {
  console.log(`\n${name}`);
  const { pack, text } = await memoFor(req);
  const a = opts.discount ? awardWithDiscount(vendors) : award(vendors);
  const top = Object.entries(a.byV).sort((x, y) => y[1] - x[1])[0] as [string, number];
  check('goods total', text, `Rs ${f(a.total, 2)}`);
  check('last year, same lines', text, `Rs ${f(a.ly, 2)}`);
  check('saving', text, `Rs ${f(a.saving, 2)}`);
  check('lines awarded', text, `${a.lines} of ${lines.length}`);
  check('largest share', text, `${top[0]} ${((top[1] / a.total) * 100).toFixed(1)} percent`);
  for (const [v, value] of Object.entries(a.byV)) check(`vendor ${v} value and share`, text, new RegExp(`${v} [A-Za-z ]+? \\d+ ${f(value, 0)} ${((value / a.total) * 100).toFixed(1)}%`));
  for (const l of lines) {
    const w = a.win[l];
    if (!w) continue;
    const desc = '.{0,120}?';
    check(`line ${l}`, text, new RegExp(`${l} ${desc} ${w.v} ${desc}${f(w.p, 2)}${opts.discount && w.p !== w.list ? '\\*' : ''} ${w.status === 'confirmed' ? 'Confirmed' : 'Assumed'} ${f(w.value, 0)} ${f(w.saving, 0)}`));
  }
  // sensitivity: USD sweep without and with the discount, and the top vendor lost
  for (const fx of [85, 96, 105]) {
    const off = award(vendors, { fx }).total;
    const on = awardWithDiscount(vendors, fx).total;
    check(`USD ${fx} totals`, text, new RegExp(`${fx}(?: \\(current\\))? ${f(off, 0)} ${f(on, 0)}`));
  }
  // Losing the top vendor re runs the same scenario, so a scenario with discounts keeps applying them where earned.
  const rest = vendors.filter((v) => v !== top[0]);
  const lost = opts.discount ? awardWithDiscount(rest) : award(rest);
  check('top vendor lost', text, `Without ${top[0]} the goods total is Rs ${f(lost.total, 0)} for ${lost.lines} of ${lines.length} lines`);
  // the engine's own totals must agree to the paisa with the independent figure
  const eng = pack.result.totals.goods_total_inr;
  if (Math.abs(eng - a.total) < 0.005) pass++;
  else {
    fail++;
    console.log(`  FAIL engine total ${eng} differs from the independent ${a.total}`);
  }
  console.log(`  goods Rs ${f(a.total, 2)}, saving Rs ${f(a.saving, 2)}, ${a.lines} lines, top ${top[0]} ${((top[1] / a.total) * 100).toFixed(1)} percent. Independent recomputation vs memo text.`);
}

await scenario('A. Cheapest per line, cleared vendors only', { strategy: 'cheapest_per_line', include_pending: false, apply_discounts: false, price_basis: 'confirmed_assumed' }, cleared);
await scenario('B. Cheapest per line, cleared vendors, conditional discounts applied', { strategy: 'cheapest_per_line', include_pending: false, apply_discounts: true, price_basis: 'confirmed_assumed' }, cleared, { discount: true });
await scenario('C. Cheapest per line, Pending vendors included (V5 USD and last year prices)', { strategy: 'cheapest_per_line', include_pending: true, apply_discounts: false, price_basis: 'confirmed_assumed' }, clearedPending);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} checks passed, ${fail} failed`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
