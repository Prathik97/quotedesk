import { cells, pool, inr } from './common.js';

const all = await cells();
console.log('Per vendor coverage and status counts (independent, from quote_lines):');
for (const v of ['V1', 'V2', 'V3', 'V4', 'V5']) {
  const mine = all.filter((c) => c.vendor === v);
  const n = (s: string) => mine.filter((c) => c.status === s).length;
  console.log(`  ${v}: quoted ${mine.filter((c) => c.price != null).length} of ${mine.length}; confirmed ${n('confirmed')}, assumed ${n('assumed')}, needs_review ${n('needs_review')}, conflict ${n('conflict')}, missing ${n('missing')}`);
}
const t = await pool.query(`select v.vendor_key, t.freight_terms, t.freight_amount_inr, t.payment_terms_days, t.stated_total_inr, jsonb_array_length(t.conditional_discounts) discounts from vendors v join vendor_terms t on t.vendor_id=v.id order by 1`);
console.log('Terms:', t.rows.map((r) => `${r.vendor_key} freight ${r.freight_terms}${r.freight_amount_inr ? ' ' + r.freight_amount_inr : ''}, ${r.payment_terms_days} days, stated total ${r.stated_total_inr ?? 'none'}, discounts ${r.discounts}`).join(' | '));
const sums = ['V2'].map((v) => all.filter((c) => c.vendor === v && c.price != null).reduce((s, c) => s + (c.price as number) * c.qty, 0));
console.log(`V2 sum of its own lines at annual qty: ${inr(sums[0] as number)}; stated minus sum as percent of sum: ${((Number(t.rows.find((r) => r.vendor_key === 'V2').stated_total_inr) / (sums[0] as number) - 1) * 100).toFixed(2)}`);
console.log('V3 missing lines:', all.filter((c) => c.vendor === 'V3' && c.price == null).map((c) => c.line).join(', '));
const top = all.filter((c) => c.status === 'assumed' && c.price != null).map((c) => ({ ...c, value: (c.price as number) * c.qty })).sort((a, b) => b.value - a.value).slice(0, 3);
console.log('Largest assumed cells:', top.map((c) => `${c.vendor} ${c.line} ${inr(c.value)}`).join(' | '));
const open = await pool.query(`select v.vendor_key, i.kind, left(i.message,90) m from review_items i join vendors v on v.id=i.vendor_id where i.state='open' order by 1,2`);
console.log('Open review items:', open.rows.map((r) => `${r.vendor_key}:${r.kind}`).join(', '));
const q = await pool.query(`select v.vendor_key, d.facts->>'expiry_date' exp from documents d join vendors v on v.id=d.vendor_id where d.facts->>'expiry_date' is not null and v.vendor_key='V4'`);
console.log('V4 certificate expiry:', q.rows.map((r) => r.exp).join(', '));
await pool.end();
