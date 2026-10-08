// House style for generated copy: no em dashes or en dashes anywhere (memo, note, workbook).
export function noDashes(s: string): string {
  return s.replace(/\s*[\u2013\u2014]\s*/g, (m, off: number, all: string) => (/\d/.test(all[off - 1] ?? '') && /\d/.test(all[off + m.length] ?? '') ? ' to ' : ', '));
}
