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
