// The xlsx appendix: the allocation, assumptions, open items and the questionnaire matrix, with the
// same scenario and caveats as the memo. Numbers are real numbers with formats, not text. Text that
// came from a vendor document is neutralised so a spreadsheet cannot run it as a formula.
import ExcelJS from 'exceljs';
import { STATUS_LABEL, toCellStatus } from '../../../engine/certainty.js';
import type { NoteResult } from './note.js';
import { noDashes } from './text.js';
import { STRATEGY_NAME, type PackData } from './pack.js';

const INR = '#,##0.00';
const INR0 = '#,##0';

/** A vendor sourced string that starts like a formula gets a leading quote. */
function safe(v: unknown): string | number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = noDashes(String(v));
  return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
}

function sheet(wb: ExcelJS.Workbook, name: string, cols: { header: string; key: string; width: number; fmt?: string }[], rows: Record<string, unknown>[]): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width, style: { numFmt: c.fmt, alignment: { vertical: 'top', wrapText: c.width > 30 } } }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow(Object.fromEntries(cols.map((c) => [c.key, safe(r[c.key])])));
  return ws;
}

export async function buildAppendix(p: PackData, note: NoteResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'QuoteDesk';
  wb.created = new Date(p.generated_at);
  const r = p.result;
  const t = r.totals;

  const about = wb.addWorksheet('Read me');
  about.columns = [{ width: 34 }, { width: 100 }];
  about.addRow(['QuoteDesk award decision pack, appendix']).font = { bold: true, size: 14 };
  about.addRow([]);
  const kv: [string, string | number][] = [
    ['RFx', p.rfx.title],
    ['Buyer', p.rfx.buyer_org],
    ['Prepared', p.generated_on],
    ['Strategy', STRATEGY_NAME[p.scenario.strategy]],
    ['Scenario settings', p.scenario_text],
    ['Decision readiness', `${p.readiness.label}. ${p.readiness.summary}`],
    ['Goods total, excluding GST (Rs)', t.goods_total_inr],
    ['Landed total (Rs)', t.landed_total_inr],
    ['Landed total is complete', t.landed_complete ? 'Yes' : 'No, a floor: freight is unknown for at least one vendor'],
    ['Last year, same lines (Rs)', t.ly_value_of_awarded_lines_inr],
    ['Saving against last year (Rs)', t.savings_vs_ly_inr],
    ['Saving against last year (percent)', t.savings_vs_ly_pct ?? 'n/a'],
    ['Lines awarded', `${t.lines_awarded} of ${t.lines_total}`],
    ['USD to INR rate used', p.assumptions.usd_inr],
    ['GST percent (display only)', p.assumptions.gst_pct],
    ['Approval note', note.text],
    ['Approval note source', note.label],
  ];
  for (const [k, v] of kv) {
    const row = about.addRow([k, safe(v)]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    if (typeof v === 'number') row.getCell(2).numFmt = INR;
  }
  about.addRow([]);
  about.addRow(['All prices are INR per base unit, excluding GST. Not quoted is blank, never zero. A conditional discount is never part of a base price.']).getCell(1).alignment = { wrapText: false };

  sheet(
    wb, 'Allocation by line',
    [
      { header: 'Line', key: 'code', width: 14 }, { header: 'Section', key: 'section', width: 22 }, { header: 'Description', key: 'desc', width: 46 }, { header: 'Unit', key: 'uom', width: 8 },
      { header: 'Annual qty', key: 'qty', width: 12, fmt: INR0 }, { header: 'Vendor', key: 'vendor', width: 9 }, { header: 'Status', key: 'status', width: 13 },
      { header: 'List price (Rs)', key: 'base', width: 14, fmt: INR }, { header: 'Price used (Rs)', key: 'price', width: 14, fmt: INR }, { header: 'Discount percent', key: 'disc', width: 10 },
      { header: 'Annual value (Rs)', key: 'value', width: 17, fmt: INR }, { header: 'Last year rate (Rs)', key: 'ly', width: 15, fmt: INR }, { header: 'Last year value (Rs)', key: 'lyv', width: 17, fmt: INR },
      { header: 'Saving vs last year (Rs)', key: 'save', width: 17, fmt: INR }, { header: 'Next best', key: 'next', width: 22 }, { header: 'Gap', key: 'gap', width: 50 },
    ],
    r.allocation.map((a) => ({
      code: a.line_code, section: a.section, desc: p.descriptions[a.line_code], uom: a.uom, qty: a.annual_qty, vendor: a.vendor_key ?? 'Not covered',
      status: a.vendor_key && a.status ? STATUS_LABEL[toCellStatus(a.status)] : 'Not quoted', base: a.base_price, price: a.price, disc: a.discount_pct, value: a.annual_value_inr,
      ly: a.ly_rate, lyv: a.ly_value_inr, save: a.saving_vs_ly_inr, next: a.runner_up ? `${a.runner_up.vendor_key} at ${a.runner_up.price.toFixed(2)}` : '', gap: a.gap_reason,
    })),
  );

  sheet(
    wb, 'By vendor',
    [
      { header: 'Vendor', key: 'vendor', width: 30 }, { header: 'Lines', key: 'lines', width: 8 }, { header: 'Goods value (Rs)', key: 'goods', width: 18, fmt: INR }, { header: 'Share (percent)', key: 'share', width: 14, fmt: '0.0' },
      { header: 'Freight', key: 'freight', width: 24 }, { header: 'Landed total (Rs)', key: 'landed', width: 18, fmt: INR }, { header: 'Landed complete', key: 'complete', width: 16 }, { header: 'Questionnaire', key: 'q', width: 14 }, { header: 'Note', key: 'note', width: 60 },
    ],
    r.by_vendor.map((v) => ({
      vendor: `${v.vendor_key} ${v.vendor_name}`, lines: v.lines, goods: v.goods_value_inr, share: v.share * 100,
      freight: v.freight_terms === 'extra' ? (v.freight_amount_inr == null ? 'Extra, no amount' : `Extra, Rs ${v.freight_amount_inr}`) : v.freight_terms === 'included' ? 'Included' : 'Not stated',
      landed: v.landed_total_inr, complete: v.landed_complete ? 'Yes' : 'No, a floor', q: v.questionnaire ?? 'Not read', note: v.landed_note,
    })),
  );

  sheet(
    wb, 'Assumptions',
    [{ header: 'Kind', key: 'kind', width: 22 }, { header: 'Vendor', key: 'vendor', width: 9 }, { header: 'Lines', key: 'lines', width: 40 }, { header: 'Annual value (Rs)', key: 'value', width: 18, fmt: INR }, { header: 'Statement', key: 'text', width: 110 }],
    [
      ...p.risk.global_assumptions.map((x) => ({ kind: 'In force', vendor: '', lines: '', value: null, text: x.text })),
      ...p.risk.applied_assumptions.map((x) => ({ kind: 'Used by the award', vendor: x.vendor_key, lines: x.lines.join(', '), value: x.annual_value_inr, text: x.text })),
    ],
  );

  sheet(
    wb, 'Open items',
    [{ header: 'Kind', key: 'kind', width: 26 }, { header: 'Vendor', key: 'vendor', width: 9 }, { header: 'Severity', key: 'sev', width: 11 }, { header: 'Annual value at stake (Rs)', key: 'value', width: 22, fmt: INR }, { header: 'Statement', key: 'text', width: 110 }],
    [
      ...p.risk.unconfirmed_cells.map((x) => ({ kind: `Price ${STATUS_LABEL[x.status]}`, vendor: x.vendor_key, sev: 'Blocker', value: x.annual_value_inr, text: x.text })),
      ...p.risk.unresolved.map((x) => ({ kind: x.kind, vendor: x.vendor_key ?? '', sev: x.severity === 'block' ? 'Blocker' : x.severity === 'warn' ? 'Open' : 'Note', value: x.value_at_stake_inr, text: x.text })),
      ...p.risk.flags.map((x) => ({ kind: `Flag ${x.flag}`, vendor: x.vendor_key, sev: 'Note', value: null, text: x.text })),
      ...p.risk.coverage_gaps.map((x) => ({ kind: 'Coverage gap', vendor: '', sev: 'Open', value: null, text: x.text })),
      ...p.risk.excluded_vendors.map((x) => ({ kind: 'Vendor left out', vendor: x.vendor_key, sev: 'Note', value: null, text: x.text })),
      ...p.warnings.map((x) => ({ kind: 'Engine note', vendor: '', sev: 'Note', value: null, text: x })),
    ],
  );

  sheet(
    wb, 'Before a PO',
    [{ header: '#', key: 'n', width: 5 }, { header: 'Blocks PO', key: 'blocks', width: 11 }, { header: 'Vendor', key: 'vendor', width: 9 }, { header: 'What to do', key: 'text', width: 120 }],
    p.next_steps.map((x, i) => ({ n: i + 1, blocks: x.blocking ? 'Yes' : 'No', vendor: x.vendor_key ?? '', text: x.text })),
  );

  // Questionnaire matrix: one row per question, answer, status and outcome per vendor.
  const qCols = [
    { header: 'Code', key: 'code', width: 7 }, { header: 'Question', key: 'text', width: 52 }, { header: 'Knockout', key: 'ko', width: 10 }, { header: 'Pass rule', key: 'rule', width: 28 },
    ...p.questionnaire.vendors.flatMap((v) => [
      { header: `${v.key} answer`, key: `${v.key}_a`, width: 34 },
      { header: `${v.key} status`, key: `${v.key}_s`, width: 13 },
      { header: `${v.key} outcome`, key: `${v.key}_o`, width: 12 },
    ]),
  ];
  const qRows: Record<string, unknown>[] = p.questionnaire.questions.map((q) => ({
    code: q.code, text: q.text, ko: q.is_knockout ? 'Yes' : 'No', rule: q.rule_text ?? '',
    ...Object.fromEntries(p.questionnaire.vendors.flatMap((v) => {
      const c = q.cells[v.key];
      return [[`${v.key}_a`, c?.summary ?? ''], [`${v.key}_s`, c?.status ?? ''], [`${v.key}_o`, c?.outcome ? c.outcome[0]!.toUpperCase() + c.outcome.slice(1) : '']];
    })),
  }));
  qRows.push({ code: '', text: 'Questionnaire result', ko: '', rule: 'Cleared = passed all three knockouts', ...Object.fromEntries(p.questionnaire.vendors.map((v) => [`${v.key}_o`, v.result])) });
  const qs = sheet(wb, 'Questionnaire matrix', qCols, qRows);
  qs.getRow(qs.rowCount).font = { bold: true };

  sheet(
    wb, 'Sensitivity',
    [{ header: 'USD to INR rate', key: 'fx', width: 18 }, { header: 'Goods total, no discount (Rs)', key: 'off', width: 28, fmt: INR }, { header: 'Goods total, with discount (Rs)', key: 'on', width: 30, fmt: INR }, { header: 'Landed, no discount (Rs)', key: 'loff', width: 24, fmt: INR }, { header: 'Landed complete', key: 'lc', width: 15 }],
    [
      ...p.sensitivity.fx.map((x) => ({ fx: `${x.usd_inr}${x.is_current ? ' (current)' : ''}`, off: x.without_discount.ok ? x.without_discount.goods_inr : null, on: x.with_discount.ok ? x.with_discount.goods_inr : null, loff: x.without_discount.ok ? x.without_discount.landed_inr : null, lc: x.without_discount.landed_complete ? 'Yes' : 'No, a floor' })),
      {},
      { fx: p.sensitivity.discount_note },
      ...(p.sensitivity.top_vendor_lost
        ? [{ fx: `If ${p.sensitivity.top_vendor_lost.vendor_key} is lost`, off: p.sensitivity.top_vendor_lost.cell.ok ? p.sensitivity.top_vendor_lost.cell.goods_inr : null, lc: p.sensitivity.top_vendor_lost.note }]
        : []),
    ],
  );

  sheet(
    wb, 'Certificates',
    [{ header: 'Vendor', key: 'vendor', width: 9 }, { header: 'In this award', key: 'in', width: 13 }, { header: 'Document', key: 'file', width: 40 }, { header: 'Standard', key: 'std', width: 18 }, { header: 'Number', key: 'num', width: 22 }, { header: 'Legal name', key: 'legal', width: 40 }, { header: 'Expiry', key: 'exp', width: 13 }, { header: 'State', key: 'state', width: 16 }, { header: 'Flags', key: 'flags', width: 24 }],
    p.risk.certificates.map((x) => ({ vendor: x.vendor_key, in: x.in_award ? 'Yes' : 'No', file: x.filename, std: x.standard, num: x.number, legal: x.legal_name, exp: x.expiry, state: x.state.replaceAll('_', ' '), flags: x.flags.join(', ') })),
  );

  return Buffer.from(await wb.xlsx.writeBuffer());
}
