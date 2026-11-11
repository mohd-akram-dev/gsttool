// GSTR-1 Table 13 (documents issued): checks rows the seller can edit, and turns them into
// the natures used by the JSON builder. Pure functions; no DOM.
import { DOC_NATURE } from './masters.js';

const MAX_DOC_NO = 16; // a GST document number has at most 16 characters

// Split a document number into its series and serial number.
// seriesPrefix (e.g. seller code + "27") is known from the GST report; it keeps the
// financial-year digits apart from the serial ("xx2742" -> series "xx27", serial 42).
function splitNo(no, seriesPrefix) {
  const s = String(no ?? '').trim();
  if (seriesPrefix && s.startsWith(seriesPrefix)) {
    const m = /^([A-Za-z]*)(\d+)$/.exec(s.slice(seriesPrefix.length));
    if (m) return { series: seriesPrefix + m[1], num: Number(m[2]), width: null };
  }
  const m = /^(.*?)(\d+)$/.exec(s);
  if (!m) return null;
  return { series: m[1], num: Number(m[2]), width: m[2].length };
}

// How many numbers from..to covers, or null when that cannot be known for sure
// (different series, To before From, or ambiguous digits like INV9..INV10).
export function rangeSize(from, to, seriesPrefix) {
  const a = splitNo(from, seriesPrefix);
  const b = splitNo(to, seriesPrefix);
  if (!a || !b || a.series !== b.series) return null;
  if ((a.width !== null || b.width !== null) && a.width !== b.width) return null;
  const n = b.num - a.num + 1;
  return n >= 1 ? n : null;
}

function wholeNumber(v) {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * rows: [{ docNum, from, to, totnum, cancel }] as typed (strings or numbers).
 * Returns { errors, warnings, natures } where natures is ready for toPortalJson.
 */
export function validateDocRows(rows, seriesPrefix = null) {
  const errors = [];
  const warnings = [];
  const byNature = new Map();
  const seen = new Map();

  rows.forEach((r, i) => {
    const n = i + 1;
    const from = String(r.from ?? '').trim();
    const to = String(r.to ?? '').trim();
    const totText = String(r.totnum ?? '').trim();
    const canText = String(r.cancel ?? '').trim();
    if (!from && !to && !totText) return; // an empty row is ignored

    const label = DOC_NATURE[r.docNum];
    if (!label) errors.push(`Row ${n}: choose the nature of document.`);
    if (!from || !to) errors.push(`Row ${n}: enter both "From" and "To".`);
    if (from.length > MAX_DOC_NO || to.length > MAX_DOC_NO) errors.push(`Row ${n}: a document number can have at most ${MAX_DOC_NO} characters.`);

    const totnum = wholeNumber(totText);
    const cancel = canText === '' ? 0 : wholeNumber(canText);
    if (totnum === null || totnum < 1) errors.push(`Row ${n}: "Total" must be a whole number, 1 or more.`);
    if (cancel === null) errors.push(`Row ${n}: "Cancelled" must be a whole number (0 if none).`);
    if (totnum !== null && cancel !== null && cancel > totnum) errors.push(`Row ${n}: "Cancelled" cannot be more than "Total".`);

    const a = splitNo(from, seriesPrefix);
    const b = splitNo(to, seriesPrefix);
    if (a && b && a.series === b.series && b.num < a.num) errors.push(`Row ${n}: "To" (${to}) comes before "From" (${from}).`);
    const size = from && to ? rangeSize(from, to, seriesPrefix) : null;
    if (size !== null && totnum !== null && size !== totnum) {
      warnings.push(`Row ${n}: ${from} to ${to} covers ${size} numbers, but Total is ${totnum}. Check it.`);
    }

    const key = `${r.docNum}|${from}|${to}`;
    if (from && to && seen.has(key)) errors.push(`Row ${n} repeats row ${seen.get(key)}.`);
    seen.set(key, n);

    if (label && from && to && totnum !== null && cancel !== null) {
      if (!byNature.has(r.docNum)) byNature.set(r.docNum, []);
      byNature.get(r.docNum).push({ from, to, totnum, cancel, a, b });
    }
  });

  // Overlapping ranges in the same series are almost always a typing mistake.
  for (const list of byNature.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i];
        const y = list[j];
        if (x.a && x.b && y.a && y.b && x.a.series === y.a.series && x.b.series === y.b.series
          && x.a.num <= y.b.num && y.a.num <= x.b.num) {
          warnings.push(`${x.from}–${x.to} and ${y.from}–${y.to} overlap. Check them.`);
        }
      }
    }
  }

  const natures = [...byNature.keys()].sort((p, q) => p - q).map((docNum) => ({
    docNum,
    label: DOC_NATURE[docNum],
    rows: byNature.get(docNum).map(({ from, to, totnum, cancel }) => ({ from, to, totnum, cancel })),
  }));
  return { errors, warnings, natures };
}
