// Indian number formatting. Display only: values are stored at full precision.

/** 4012930.5 -> "40,12,930.50" */
export function formatIndian(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return 'Not available';
  const neg = value < 0;
  const [whole = '0', frac] = Math.abs(value).toFixed(decimals).split('.');
  let grouped = whole;
  if (whole.length > 3) {
    const head = whole.slice(0, -3);
    const tail = whole.slice(-3);
    grouped = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail;
  }
  return (neg ? '-' : '') + grouped + (frac ? '.' + frac : '');
}

/** Compact rupee display: lakh and crore for large values. */
export function formatInrCompact(value: number): string {
  if (!Number.isFinite(value)) return 'Not available';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} crore`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} lakh`;
  return `${sign}₹${formatIndian(abs)}`;
}

/** Rupee amount with the symbol and Indian grouping: 1180 -> "₹1,180.00". */
export function formatRupee(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return 'Not available';
  return `${value < 0 ? '-' : ''}₹${formatIndian(Math.abs(value), decimals)}`;
}

/** Percent change with an explicit sign and an ASCII hyphen: 3.24 -> "+3.2%", -1 -> "-1.0%". */
export function formatPct(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return 'Not available';
  const s = Math.abs(value).toFixed(decimals);
  const zero = Number(s) === 0;
  return `${zero ? '' : value < 0 ? '-' : '+'}${s}%`;
}

/** Whole number with Indian grouping, for quantities. */
export function formatQty(value: number): string {
  return formatIndian(value, Number.isInteger(value) ? 0 : 2);
}

/** Rate for a unit price: two decimals, but keep a third when it is needed to tell prices apart. */
export function formatUnitPrice(value: number): string {
  if (!Number.isFinite(value)) return 'Not available';
  return formatIndian(value, 2);
}
