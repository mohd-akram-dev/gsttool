// Money helpers. All sums are done on full-precision numbers; rounding to paise
// happens once, when a figure is written into a return table.

// Round to 2 decimals, half away from zero (1.005 -> 1.01, -1.005 -> -1.01).
// The tiny epsilon absorbs binary representation error (1.005 is stored as 1.00499...).
export function round2(x) {
  if (!Number.isFinite(x)) throw new Error(`round2: not a finite number: ${x}`);
  const r = Math.round(Math.abs(x) * 100 + 1e-6) / 100;
  if (r === 0) return 0; // never return -0
  return x < 0 ? -r : r;
}

// Sum a list of already-rounded amounts without float noise (0.1 + 0.2 style errors).
export function sum2(values) {
  return round2(values.reduce((a, b) => a + b, 0));
}

// Parse a cell value into a number. Returns null for empty cells, NaN for junk.
export function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function fmtINR(n) {
  return inr.format(n);
}
