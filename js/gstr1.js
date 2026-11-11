// GSTR-1 engine: Meesho rows in, return tables out. Pure functions only (no DOM),
// so the same code runs in the browser and in the Node golden tests.
//
// Rounding rule (see DEV_NOTES.md section 1):
//   1. add up each group at full precision,
//   2. round the group's taxable value and tax ONCE to paise,
//   3. every later total = sum of those rounded rows.
import { round2, sum2, toNumber } from './money.js';
import { stateToPos, POS_NAMES, GST_RATES, DOC_NATURE } from './masters.js';

const ROW_TOLERANCE = 0.05; // rupees; for checking Meesho's own per-row arithmetic
const HSN_DESC_MAX = 30;

// ---------- small helpers ----------

function unique(values) {
  return [...new Set(values)];
}

// 'YYYY-MM' from an ISO-like string, a DD-MM-YYYY string or an Excel serial date.
function monthKey(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 864e5));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}`;
  return null;
}

function normHsn(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    let s = String(Math.trunc(v));
    if (s.length % 2 === 1) s = `0${s}`; // a numeric cell drops the leading zero (0401 -> 401)
    return s;
  }
  return String(v).replace(/\s+/g, '');
}

function listPreview(items, max = 8) {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

// ---------- main ----------

/**
 * @param {object} input
 * @param {object[]|null} input.sales    rows of tcs_sales.xlsx (null = file not added)
 * @param {object[]|null} input.returns  rows of tcs_sales_return.xlsx (null = file not added)
 * @param {object[]} input.docs          rows of one or more Tax_invoice_details.xlsx files
 * @param {object} input.settings        { b2csType: 'OE'|'E', uqc: 'PCS', hsnDesc: { '7117': '...' } }
 */
export function buildGstr1({ sales = null, returns = null, docs = [], settings = {} }) {
  const issues = [];
  const issue = (level, message, details = []) => issues.push({ level, message, details });

  if (!sales) issue('error', 'Add tcs_sales.xlsx (sales file from the Meesho GST report).');
  if (!returns) issue('error', 'Add tcs_sales_return.xlsx (returns file from the Meesho GST report).');
  if (!sales || !returns) return emptyResult(issues);

  // ---- 1. read and check every row ----
  const lines = [];
  const badRows = [];
  const arithmetic = [];
  const rateMismatch = [];
  const oddRows = [];

  const take = (rows, src) => {
    const file = src === 'S' ? 'tcs_sales' : 'tcs_sales_return';
    for (const r of rows) {
      const where = `${file} row ${r._row}`;
      const l = {
        src,
        sign: src === 'S' ? 1 : -1,
        where,
        sub: String(r.sub_order_num ?? '').trim(),
        hsn: normHsn(r.hsn_code),
        qty: toNumber(r.quantity),
        rate: toNumber(r.gst_rate),
        taxable: toNumber(r.total_taxable_sale_value),
        tax: toNumber(r.tax_amount),
        invoiceValue: toNumber(r.total_invoice_value),
        stateName: String(r.end_customer_state_new ?? '').trim(),
        gstin: String(r.gstin ?? '').trim().toUpperCase(),
        eco: String(r.eco_tcs_gstin ?? '').trim().toUpperCase(),
        identifier: String(r.identifier ?? '').trim(),
        month: toNumber(r.month_number),
        fy: toNumber(r.financial_year),
        eventMonth: monthKey(src === 'S' ? r.manifest_date : r.cancel_return_date),
      };
      l.pos = stateToPos(l.stateName);

      const problems = [];
      for (const [field, label] of [['qty', 'quantity'], ['rate', 'gst_rate'],
        ['taxable', 'total_taxable_sale_value'], ['tax', 'tax_amount'],
        ['invoiceValue', 'total_invoice_value'], ['month', 'month_number'], ['fy', 'financial_year']]) {
        if (l[field] === null || Number.isNaN(l[field])) problems.push(`${label} is empty or not a number`);
      }
      if (!l.sub) problems.push('sub_order_num is empty');
      if (!l.pos) problems.push(`state "${l.stateName}" is not a known Indian state`);
      if (l.rate !== null && !Number.isNaN(l.rate) && !GST_RATES.includes(l.rate)) problems.push(`GST rate ${l.rate}% is not a GST rate`);
      if (!/^\d{4,8}$/.test(l.hsn)) problems.push(`HSN "${l.hsn}" must be 4 to 8 digits`);
      if (Number.isFinite(l.qty) && (!Number.isInteger(l.qty) || l.qty < 0)) problems.push(`quantity ${l.qty} is not a whole number`);
      if (problems.length) { badRows.push(`${where}: ${problems.join('; ')}`); continue; }

      if (Math.abs(l.taxable + l.tax - l.invoiceValue) > ROW_TOLERANCE) {
        arithmetic.push(`${where}: ${l.taxable} + ${l.tax} ≠ ${l.invoiceValue}`);
      }
      if (Math.abs(l.tax - (l.taxable * l.rate) / 100) > ROW_TOLERANCE) {
        rateMismatch.push(`${where}: tax ${l.tax} is not ${l.rate}% of ${l.taxable}`);
      }
      if (src === 'S' && l.qty === 0 && l.taxable > 0) oddRows.push(`${where}: quantity 0 with a positive value ${l.taxable}`);
      if (src === 'R' && l.qty === 0) oddRows.push(`${where}: return row with quantity 0`);
      lines.push(l);
    }
  };
  take(sales, 'S');
  take(returns, 'R');

  if (badRows.length) issue('error', `${badRows.length} row(s) cannot be used. Fix the file or tell the developer.`, badRows);
  if (arithmetic.length) issue('warning', `${arithmetic.length} row(s) where Meesho's taxable value + tax does not equal the invoice value.`, arithmetic);
  if (rateMismatch.length) issue('warning', `${rateMismatch.length} row(s) where Meesho's tax does not match the GST rate.`, rateMismatch);
  if (oddRows.length) issue('warning', `${oddRows.length} unusual row(s). Check them before filing.`, oddRows);
  if (!lines.length) {
    issue('error', 'No usable rows in the sales and returns files.');
    return emptyResult(issues);
  }

  // ---- 2. who and when ----
  const gstins = unique(lines.map((l) => l.gstin));
  if (gstins.length !== 1) {
    issue('error', `The files contain more than one GSTIN: ${gstins.join(', ')}. Use files of one seller only.`);
    return emptyResult(issues);
  }
  const gstin = gstins[0];
  if (!/^\d{2}[A-Z0-9]{13}$/.test(gstin)) issue('error', `GSTIN "${gstin}" does not look like a valid GSTIN.`);
  const home = gstin.slice(0, 2);

  const periods = unique(lines.map((l) => `${l.month}|${l.fy}`));
  if (periods.length !== 1) {
    issue('error', `The sales and returns files are for different months (${periods.map((p) => p.replace('|', '/')).join(', ')}). Use both files from the same Meesho GST report.`);
    return emptyResult(issues);
  }
  const month = lines[0].month;
  const fyField = lines[0].fy;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    issue('error', `month_number ${month} is not a month.`);
    return emptyResult(issues);
  }
  // Meesho's financial_year could mean the calendar year or the FY start year; pick the
  // year that the shipping / return dates in the file actually fall in.
  const mm = String(month).padStart(2, '0');
  const inA = lines.filter((l) => l.eventMonth === `${fyField}-${mm}`).length;
  const inB = lines.filter((l) => l.eventMonth === `${fyField + 1}-${mm}`).length;
  const year = inB > inA ? fyField + 1 : fyField;
  if (inA === 0 && inB === 0) issue('warning', `Could not confirm the year from the dates in the file; using ${year}.`);
  const fyEnd = month >= 4 ? year + 1 : year;
  const period = { month, year, fp: `${mm}${year}`, fyLabel: `${fyEnd - 1}-${String(fyEnd % 100).padStart(2, '0')}` };

  // ---- 3. Table 7: B2C (Others), one row per place of supply x rate ----
  const typ = settings.b2csType === 'E' ? 'E' : 'OE';
  const ecos = unique(lines.map((l) => l.eco).filter(Boolean));
  if (ecos.length > 1) issue('error', `More than one e-commerce GSTIN in the files: ${ecos.join(', ')}.`);
  const etin = ecos.length === 1 ? ecos[0] : null;
  if (!etin) issue('warning', 'No e-commerce operator GSTIN (eco_tcs_gstin) in the files, so Table 14 is left out.');
  if (typ === 'E' && !etin) issue('error', 'Table 7 type "E" needs the e-commerce GSTIN, which is missing.');

  const posGroups = new Map();
  for (const l of lines) {
    const key = `${l.pos}|${l.rate}`;
    let g = posGroups.get(key);
    if (!g) posGroups.set(key, (g = { pos: l.pos, rate: l.rate, raw: 0, rows: 0 }));
    g.raw += l.sign * l.taxable;
    g.rows += 1;
  }
  const b2cs = [];
  const droppedZero = [];
  for (const g of [...posGroups.values()].sort((a, b) => Number(a.pos) - Number(b.pos) || a.rate - b.rate)) {
    const inter = g.pos !== home;
    const row = {
      pos: g.pos,
      posName: POS_NAMES[g.pos] ?? g.pos,
      rate: g.rate,
      sply_ty: inter ? 'INTER' : 'INTRA',
      typ,
      etin: typ === 'E' ? etin : null,
      txval: round2(g.raw),
      iamt: inter ? round2((g.raw * g.rate) / 100) : 0,
      camt: inter ? 0 : round2((g.raw * g.rate) / 200),
      samt: inter ? 0 : round2((g.raw * g.rate) / 200),
      sourceRows: g.rows,
    };
    if (row.txval === 0 && row.iamt === 0 && row.camt === 0) { droppedZero.push(`${row.pos}-${row.posName} ${row.rate}%`); continue; }
    b2cs.push(row);
  }
  if (droppedZero.length) issue('info', `Left out ${droppedZero.length} Table 7 row(s) where sales and returns cancel to ₹0: ${droppedZero.join(', ')}.`);
  const negatives = b2cs.filter((r) => r.txval < 0);
  if (negatives.length) {
    issue('warning', `${negatives.length} Table 7 row(s) are negative because returns were more than sales in that state. The portal accepts this.`,
      negatives.map((r) => `${r.pos}-${r.posName} ${r.rate}%: ${r.txval}`));
  }

  // ---- 4. Table 12: HSN summary (B2C), one row per HSN x rate ----
  const descDefaults = defaultHsnDescriptions(docs);
  const uqc = settings.uqc || 'PCS';
  const hsnGroups = new Map();
  for (const l of lines) {
    const key = `${l.hsn}|${l.rate}`;
    let g = hsnGroups.get(key);
    if (!g) hsnGroups.set(key, (g = { hsn: l.hsn, rate: l.rate, qty: 0, raw: 0, inter: 0, intra: 0, value: 0 }));
    g.qty += l.sign * l.qty;
    g.raw += l.sign * l.taxable;
    g.value += l.sign * l.invoiceValue;
    if (l.pos !== home) g.inter += l.sign * l.taxable;
    else g.intra += l.sign * l.taxable;
  }
  const hsn = [];
  const missingDesc = [];
  const byHsn = (a, b) => (a.hsn < b.hsn ? -1 : a.hsn > b.hsn ? 1 : a.rate - b.rate);
  for (const g of [...hsnGroups.values()].sort(byHsn)) {
    const row = {
      hsn: g.hsn,
      rate: g.rate,
      qty: g.qty,
      txval: round2(g.raw),
      iamt: round2((g.inter * g.rate) / 100),
      camt: round2((g.intra * g.rate) / 200),
      samt: round2((g.intra * g.rate) / 200),
      totalValue: round2(g.value),
      uqc,
      desc: '',
    };
    if (row.qty === 0 && row.txval === 0 && row.iamt === 0 && row.camt === 0) continue;
    const typed = (settings.hsnDesc?.[g.hsn] ?? '').trim();
    row.desc = (typed || descDefaults[g.hsn] || '').slice(0, HSN_DESC_MAX);
    if (!row.desc) missingDesc.push(g.hsn);
    hsn.push(row);
  }
  if (missingDesc.length) issue('error', `Add a description for HSN ${missingDesc.join(', ')} (Table 12).`);
  const negHsn = hsn.filter((r) => r.txval < 0 || r.qty < 0);
  if (negHsn.length) issue('warning', `${negHsn.length} HSN row(s) are negative (returns more than sales).`, negHsn.map((r) => `${r.hsn} ${r.rate}%: qty ${r.qty}, ₹${r.txval}`));

  // ---- 5. Table 14: supplies through e-commerce (Meesho collects TCS u/s 52) ----
  const t7 = {
    rows: b2cs.length,
    txval: sum2(b2cs.map((r) => r.txval)),
    iamt: sum2(b2cs.map((r) => r.iamt)),
    camt: sum2(b2cs.map((r) => r.camt)),
    samt: sum2(b2cs.map((r) => r.samt)),
  };
  const eco = etin ? { etin, suppval: t7.txval, igst: t7.iamt, cgst: t7.camt, sgst: t7.samt, cess: 0 } : null;

  // ---- 6. cross-checks between tables and against Meesho's own tax ----
  const t12 = {
    rows: hsn.length,
    txval: sum2(hsn.map((r) => r.txval)),
    iamt: sum2(hsn.map((r) => r.iamt)),
    camt: sum2(hsn.map((r) => r.camt)),
    samt: sum2(hsn.map((r) => r.samt)),
    qty: hsn.reduce((a, r) => a + r.qty, 0),
  };
  const t7tax = sum2([t7.iamt, t7.camt, t7.samt]);
  const meeshoTax = round2(lines.reduce((a, l) => a + l.sign * l.tax, 0));
  const meeshoTaxable = round2(lines.reduce((a, l) => a + l.sign * l.taxable, 0));
  const paise = [];
  for (const [label, a, b] of [['taxable', t12.txval, t7.txval], ['IGST', t12.iamt, t7.iamt], ['CGST', t12.camt, t7.camt], ['SGST', t12.samt, t7.samt]]) {
    const diff = round2(a - b);
    if (Math.abs(diff) > 1) issue('error', `Table 12 ${label} (${a}) differs from Table 7 (${b}) by more than ₹1. This should never happen; do not file.`);
    else if (diff !== 0) paise.push(`${label} ${diff > 0 ? '+' : ''}${diff.toFixed(2)}`);
  }
  if (paise.length) issue('info', `Table 12 totals differ from Table 7 by a few paise because each HSN row is rounded on its own (${paise.join(', ')}). Normal.`);
  const taxDiff = round2(t7tax - meeshoTax);
  if (Math.abs(taxDiff) > 1) issue('warning', `Tax in Table 7 (₹${t7tax}) differs from the total of Meesho's tax_amount (₹${meeshoTax}) by ₹${taxDiff}. Check GST rates.`);

  // ---- 7. Table 13: documents issued ----
  const t13 = buildDocs({ lines, docs, identifier: unique(lines.map((l) => l.identifier).filter(Boolean)), fyEnd, issue });

  const errors = issues.filter((i) => i.level === 'error').length;
  return {
    ok: errors === 0,
    gstin,
    home,
    period,
    b2cs,
    hsn,
    eco,
    docs: t13,
    totals: { t7, t12, meeshoTax, meeshoTaxable, salesRows: sales.length, returnRows: returns.length },
    issues,
  };
}

function emptyResult(issues) {
  return { ok: false, gstin: null, home: null, period: null, b2cs: [], hsn: [], eco: null, docs: { natures: [], prefix: null }, totals: null, issues };
}

// Most common product description per HSN in the tax invoice list (a starting point the seller can edit).
export function defaultHsnDescriptions(docs) {
  const counts = {};
  for (const d of docs) {
    const h = normHsn(d.HSN);
    const desc = String(d['Product Description'] ?? '').replace(/\s+/g, ' ').trim();
    if (!h || !desc) continue;
    counts[h] ??= {};
    counts[h][desc] = (counts[h][desc] ?? 0) + 1;
  }
  const out = {};
  for (const [h, m] of Object.entries(counts)) {
    out[h] = shortText(Object.entries(m).sort((a, b) => b[1] - a[1])[0][0], HSN_DESC_MAX);
  }
  return out;
}

// Cut text to max characters at a word boundary ("Red Cotton Kurta Set For Women" -> "Red Cotton Kurta Set").
function shortText(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : text.slice(0, max))
    .replace(/[\s(&,-]+$/, '')
    .replace(/\s+(for|and|with|of|the|in|to)$/i, '') // don't end on a dangling small word
    .trim();
}

// ---------- Table 13 ----------

const DOC_TYPE = {
  'INVOICE': 'INV',
  'CREDIT NOTE': 'CN',          // return of goods
  'CREDIT CONVERSION': 'CC',    // price credit, already netted into the sale row by Meesho
  'CREDIT DISCOUNT': 'CD',      // shipping-charge reversal, the quantity-0 negative sale rows
};
const TYPE_LABEL = { INV: 'invoice', CN: 'return credit note', CC: 'conversion credit note', CD: 'shipping-discount credit note' };

function buildDocs({ lines, docs, identifier, fyEnd, issue }) {
  const natures = [
    { docNum: 1, label: DOC_NATURE[1], rows: [] },
    { docNum: 5, label: DOC_NATURE[5], rows: [] },
  ];
  if (!docs.length) {
    issue('warning', 'Add Tax_invoice_details.xlsx (Meesho tax invoices) to fill Table 13, which is mandatory. Without it the JSON has no Table 13.');
    return { natures, used: 0, prefix: null };
  }
  if (identifier.length !== 1) {
    issue('error', `Cannot read document numbers: expected one Meesho "identifier" in the GST report, found ${identifier.length ? identifier.join(', ') : 'none'}.`);
    return { natures, used: 0, prefix: null };
  }
  const prefix = `${identifier[0]}${String(fyEnd % 100).padStart(2, '0')}`; // seller code + '27' for FY 2026-27

  // Normalise and de-duplicate (the same document can appear in two uploaded files).
  const byNo = new Map();
  const unknownType = [];
  const badNumber = [];
  const foreign = [];
  for (const d of docs) {
    const no = String(d['Invoice No.'] ?? '').trim();
    const type = DOC_TYPE[String(d.Type ?? '').toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim()];
    const sub = String(d['Suborder No.'] ?? '').trim();
    if (!no) continue;
    if (!type) { unknownType.push(`${no} (${d.Type})`); continue; }
    if (byNo.has(no)) {
      const prev = byNo.get(no);
      if (prev.sub !== sub || prev.type !== type) issue('error', `Document ${no} appears twice with different details. Check the Tax_invoice_details files.`);
      continue;
    }
    const parsed = no.startsWith(prefix) ? /^([A-Z]*)(\d+)$/.exec(no.slice(prefix.length)) : null;
    // Numbers from another financial year (other prefix) are simply not this period's documents.
    if (!parsed) { (no.startsWith(identifier[0]) ? badNumber : foreign).push(no); continue; }
    byNo.set(no, { no, type, sub, series: parsed[1], serial: Number(parsed[2]), used: false });
  }
  if (unknownType.length) issue('warning', `${unknownType.length} document(s) of an unknown type were ignored.`, unknownType);
  if (badNumber.length) issue('info', `${badNumber.length} document number(s) are not in the ${prefix}… series for this financial year and were ignored.`, badNumber);
  if (foreign.length) issue('warning', `${foreign.length} document number(s) do not start with this seller's Meesho code "${identifier[0]}". Is this the right Tax_invoice_details file?`, foreign);

  const pool = new Map(); // `${type}|${sub}` -> documents, lowest number first
  for (const d of byNo.values()) {
    const k = `${d.type}|${d.sub}`;
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(d);
  }
  for (const list of pool.values()) list.sort((a, b) => a.serial - b.serial);

  // What this month's GST report says must exist:
  const salesLines = lines.filter((l) => l.src === 'S');
  const need = {
    INV: unique(salesLines.filter((l) => l.qty > 0).map((l) => l.sub)),           // one invoice per sold sub-order
    CN: lines.filter((l) => l.src === 'R').map((l) => l.sub),                      // one credit note per return row
    CD: salesLines.filter((l) => l.qty === 0 && l.taxable < 0).map((l) => l.sub),  // one per shipping reversal row
  };
  const found = { INV: [], CN: [], CD: [], CC: [] };
  const missing = { INV: [], CN: [], CD: [] };
  for (const type of ['INV', 'CN', 'CD']) {
    for (const sub of need[type]) {
      const d = (pool.get(`${type}|${sub}`) || []).find((x) => !x.used);
      if (d) { d.used = true; found[type].push(d); } else missing[type].push(sub);
    }
  }
  // Conversion credit notes have no row of their own in the GST report (Meesho nets them
  // into the sale value), so they follow the month of their sale.
  const soldSubs = new Set(salesLines.map((l) => l.sub));
  for (const d of byNo.values()) {
    if (d.type === 'CC' && soldSubs.has(d.sub) && !d.used) { d.used = true; found.CC.push(d); }
  }

  const ambiguous = [...pool.values()].filter((list) => list.length > 1 && list.some((d) => d.used) && list.some((d) => !d.used));
  if (ambiguous.length) {
    issue('warning', 'Some sub-orders have more than one document of the same type; only the first was counted.', ambiguous.map((l) => l.map((d) => d.no).join(' / ')));
  }

  // Turn found documents into Table 13 rows, one series at a time.
  const addRows = (nature, type) => {
    const list = found[type];
    const miss = missing[type]?.length ?? 0;
    const series = unique(list.map((d) => d.series));
    if (!list.length) {
      if (miss) issue('warning', `${miss} ${TYPE_LABEL[type]}(s) for this month are not in the uploaded Tax_invoice_details, so Table 13 leaves them out. Add the Tax_invoice_details of the previous month(s).`, missing[type]);
      return;
    }
    for (const s of series.sort()) {
      const docsOfSeries = list.filter((d) => d.series === s).sort((a, b) => a.serial - b.serial);
      const missHere = series.length === 1 ? miss : 0;
      const res = seriesRows(docsOfSeries, missHere, `${prefix}${s}`);
      nature.rows.push(...res.rows.map((r) => ({ ...r, kind: TYPE_LABEL[type] })));
      if (res.filled) {
        issue('info', `${res.filled} ${TYPE_LABEL[type]}(s) for this month are not in Tax_invoice_details (orders placed in an earlier month), and exactly ${res.filled} number(s) are unused inside ${res.rows[0].from}…${res.rows[0].to}: ${listPreview(res.gaps)}. They are counted inside that range. Add the previous month's Tax_invoice_details to confirm.`, missing[type]);
      } else if (res.gaps.length) {
        issue('warning', `${TYPE_LABEL[type]} numbers have gaps (${listPreview(res.gaps)}), so Table 13 lists ${res.rows.length} separate ranges.`);
      }
      const notCovered = missHere - res.filled;
      if (notCovered > 0) {
        issue('warning', `${notCovered} ${TYPE_LABEL[type]}(s) for this month are not in the uploaded Tax_invoice_details (orders placed in an earlier month). Table 13 under-counts them. Add the previous month's Tax_invoice_details file.`, missing[type]);
      }
    }
    if (series.length > 1 && miss) {
      issue('warning', `${miss} ${TYPE_LABEL[type]}(s) are missing and could belong to any of the series ${series.join(', ')}; they are not counted.`, missing[type]);
    }
  };
  addRows(natures[0], 'INV');
  addRows(natures[1], 'CN');
  addRows(natures[1], 'CC');
  addRows(natures[1], 'CD');

  const unused = [...byNo.values()].filter((d) => !d.used).map((d) => d.no);
  if (unused.length) issue('info', `${unused.length} document(s) in Tax_invoice_details belong to another month's sales or returns and were left out of Table 13: ${listPreview(unused)}.`);

  return { natures, used: [...byNo.values()].filter((d) => d.used).length, prefix };
}

// docs: one series, sorted by serial. Returns Table 13 rows for it.
function seriesRows(docs, missing, seriesPrefix) {
  const first = docs[0];
  const last = docs[docs.length - 1];
  const span = last.serial - first.serial + 1;
  const gaps = [];
  for (let i = 1; i < docs.length; i++) {
    for (let n = docs[i - 1].serial + 1; n < docs[i].serial; n++) gaps.push(`${seriesPrefix}${n}`);
  }
  if (gaps.length === 0) {
    return { rows: [{ from: first.no, to: last.no, totnum: docs.length, cancel: 0 }], filled: 0, gaps };
  }
  if (missing > 0 && gaps.length === missing) {
    // The unused numbers match the documents we know exist but could not see: count them in.
    return { rows: [{ from: first.no, to: last.no, totnum: span, cancel: 0 }], filled: gaps.length, gaps };
  }
  // Otherwise list each unbroken run separately, so every row is exact.
  const rows = [];
  let start = docs[0];
  for (let i = 1; i <= docs.length; i++) {
    if (i === docs.length || docs[i].serial !== docs[i - 1].serial + 1) {
      rows.push({ from: start.no, to: docs[i - 1].no, totnum: docs[i - 1].serial - start.serial + 1, cancel: 0 });
      start = docs[i];
    }
  }
  return { rows, filled: 0, gaps };
}
