// Replays stored raw model replies (eval/fixtures/*.raw.json) through the CURRENT derivation. No model call, no database.
// Usage: tsx scripts/replay-sandbox.ts [--json <file>] [fixture name ...]
// --json writes every derived line (code, status, INR per base unit, flags, reasons, notes) so two versions can be diffed.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { ExtractionSchema, parseJsonLoose } from '../src/lib/schemas/extraction.js';
import { deriveLines, type RfxLineRow } from '../api/_lib/extract/persist.js';
import { indicativeFor } from '../api/_lib/sandbox/run.js';
import { shortValidityWarning } from '../engine/terms.js';
import type { Prepared } from '../api/_lib/extract/prepare.js';

const root = new URL('../eval/fixtures/', import.meta.url);
const seed = JSON.parse(readFileSync(new URL('../seed/rfx.json', import.meta.url), 'utf8')) as { rfx: { validity_days: number }; lines: { code: string; section: string; description: string; uom: RfxLineRow['uom']; annual_qty: number; ly_rate: number | null }[] };
const rfx: RfxLineRow[] = seed.lines.map((l, i) => ({ id: `seed-${i}`, code: l.code, section: l.section, description: l.description, uom: l.uom, annual_qty: l.annual_qty, last_year_rate_inr: l.ly_rate }));

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonFile = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
const dump: Record<string, unknown[]> = {};
const names = args.length ? args : readdirSync(root).filter((f) => f.endsWith('.raw.json')).map((f) => f.replace('.raw.json', ''));
for (const name of names) {
  const fx = JSON.parse(readFileSync(new URL(`${name}.raw.json`, root), 'utf8')) as { file: { filename: string }; replies: { text: string }[] };
  const reply = fx.replies.find((r) => /"document"\s*:/.test(r.text));
  if (!reply) throw new Error(`${name}: no extraction reply in the fixture`);
  const x = ExtractionSchema.parse(parseJsonLoose(reply.text));
  const source_type = /\.(eml|txt)$/.test(fx.file.filename) ? 'email' : 'xlsx';
  const prep = { source_type, observations: [] } as unknown as Prepared;
  const out = deriveLines(prep, x, rfx, { usd_inr: 96, gst_pct: 18 });
  console.log(`\n== ${fx.file.filename}  (${out.length} lines)`);
  for (const d of out) {
    console.log([d.rfx?.code ?? '?', `${d.line.price} ${d.line.uom_text ?? ''} per_n ${d.line.per_n ?? 1}`, '->', d.normalized == null ? 'none' : d.normalized.toFixed(4), d.status, d.flags.join(',') || '-', '|', d.reasons.join(' '), d.result?.notes.length ? `| notes: ${d.result.notes.join(' ')}` : ''].join(' '));
  }
  dump[name] = out.map((d) => ({ code: d.rfx?.code ?? null, vendor: d.line.vendor_description, status: d.status, inr: d.normalized, flags: d.flags, keys: d.assumption_keys, reasons: d.reasons, notes: d.result?.notes ?? [], steps: d.result?.steps.map((st) => `${st.op} ${st.factor}`) ?? [] }));
  const w = shortValidityWarning(x.document.validity_text, seed.rfx.validity_days);
  console.log('validity warning:', w ?? 'none');
  const covered = new Set(out.map((d) => d.rfx?.code));
  const missing = rfx.filter((l) => !covered.has(l.code)).map((l) => l.code);
  const ind = indicativeFor(missing, rfx, x.document.conditional_discounts.map((c) => ({ text: c.text, applies_to: c.applies_to, percent: c.percent, locator: c.evidence?.locator ?? null })), x.document.global_notes);
  console.log('indicative beside not quoted:', Object.keys(ind).length, 'lines;', JSON.stringify(Object.values(ind)[0] ?? null));
}
if (jsonFile) writeFileSync(jsonFile, JSON.stringify(dump, null, 1));
