// Readers for the Meesho Supplier Panel "Orders" export (CSV) and the
// "SP_ORDER_ADS_REFERRAL_PAYMENT_FILE" payment workbook (xlsx).
// Files are recognised by their contents (headers / sheet names), never by name alone.
import * as XLSX from '../lib/xlsx.js';
import { toNumber } from './money.js';

export const PKIND = { ORDERS: 'orders', PAYMENTS: 'payments' };

const ORDER_COLS = {
  status: 'Reason for Credit Entry',
  sub: 'Sub Order No',
  odate: 'Order Date',
  source: 'Order source',
  state: 'Customer State',
  product: 'Product Name',
  sku: 'SKU',
  qty: 'Quantity',
  listed: 'Supplier Listed Price (Incl. GST + Commission)',
  price: 'Supplier Discounted Price (Incl GST and Commision)',
};

// Payment columns, found by their header text on the "Order Payments" sheet.
const PAY_COLS = {
  sub: 'Sub Order No', odate: 'Order Date', dispatch: 'Dispatch Date', product: 'Product Name',
  sku: 'Supplier SKU', status: 'Live Order Status', gst: 'Product GST %', listing: 'Listing Price (Incl. taxes)',
  qty: 'Quantity', txn: 'Transaction ID', pdate: 'Payment Date', final: 'Final Settlement Amount',
  sale: 'Total Sale Amount (Incl. Shipping & GST)', ret: 'Total Sale Return Amount (Incl. Shipping & GST)',
  comm: 'Meesho Commission (Incl. GST)', retship: 'Return Shipping Charge (Incl. GST)', ship: 'Shipping Charge (Incl. GST)',
  tcs: 'TCS', tds: 'TDS', comp: 'Compensation', claims: 'Claims', recov: 'Recovery',
  compWhy: 'Compensation Reason', claimWhy: 'Claims Reason', recovWhy: 'Recovery Reason',
};
// Money columns between "Total Sale Amount" and "Recovery" that are NOT part of the settlement
// sum (they are percentages, or amounts already folded into "Net Other Support Service Charges").
const NOT_IN_SUM = new Set(['Meesho Commission Percentage', 'Other Support Service Charges (Excl. GST)', 'Waivers (Excl. GST)', 'TDS Rate %']);

// 'YYYY-MM-DD' from a text date ("2026-09-03 17:25:49", "03-09-2026") or an Excel serial number.
export function isoDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 864e5));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return '';
}

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const money = (v) => {
  const n = toNumber(v);
  return n === null || Number.isNaN(n) ? 0 : n;
};

// Supplier id and period from Meesho's own file names (null when the file was renamed).
export function fileMeta(name) {
  let m = /^(\d+)_SP_ORDER_ADS_REFERRAL_PAYMENT_FILE.*?(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/i.exec(name);
  if (m) return { supplierId: m[1], from: m[2], to: m[3] };
  m = /^Orders_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2}).*_(\d+)\.csv$/i.exec(name);
  if (m) return { supplierId: m[3], from: m[1], to: m[2] };
  return { supplierId: null, from: null, to: null };
}

/**
 * data: ArrayBuffer (browser) or Buffer (Node). Returns
 *   { kind: 'orders', orders: [...] } or
 *   { kind: 'payments', lines: [...], ads: [...], unhandled: [...] }
 * plus { supplierId, from, to } from the file name. Throws a readable Error for other files.
 */
export function readPaymentOrOrders(data, fileName = 'file') {
  const meta = fileMeta(fileName);
  const isText = /\.csv$/i.test(fileName);
  const wb = isText
    ? XLSX.read(typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data), { type: 'string', raw: true })
    : XLSX.read(data, { type: data instanceof ArrayBuffer ? 'array' : 'buffer' });

  if (wb.SheetNames.includes('Order Payments')) return { ...meta, ...readPayments(wb, fileName) };

  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    const hdr = (grid[0] || []).map(text);
    if (Object.values(ORDER_COLS).every((c) => hdr.includes(c))) return { ...meta, ...readOrders(grid, hdr) };
  }
  throw new Error(`${fileName}: not a Meesho orders export (CSV) or payment file (xlsx with an "Order Payments" sheet).`);
}

function readOrders(grid, hdr) {
  const at = Object.fromEntries(Object.entries(ORDER_COLS).map(([k, c]) => [k, hdr.indexOf(c)]));
  const orders = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const sub = text(r[at.sub]);
    if (!sub) continue;
    const odate = isoDate(r[at.odate]);
    orders.push({
      sub,
      odate,
      month: odate.slice(0, 7),
      status: text(r[at.status]).toUpperCase(),
      source: text(r[at.source]),
      state: text(r[at.state]),
      product: text(r[at.product]),
      sku: text(r[at.sku]),
      qty: money(r[at.qty]),
      listed: money(r[at.listed]),
      price: money(r[at.price]),
      row: i + 1,
    });
  }
  return { kind: PKIND.ORDERS, orders };
}

function readPayments(wb, fileName) {
  const grid = XLSX.utils.sheet_to_json(wb.Sheets['Order Payments'], { header: 1, raw: true, defval: null, blankrows: false });
  const h = grid.findIndex((row) => row && row.map(text).includes('Sub Order No') && row.map(text).includes('Final Settlement Amount'));
  if (h < 0) throw new Error(`${fileName}: the "Order Payments" sheet has no "Sub Order No" / "Final Settlement Amount" header row.`);
  const hdr = grid[h].map(text);
  const at = {};
  for (const [k, c] of Object.entries(PAY_COLS)) {
    at[k] = hdr.indexOf(c);
    if (at[k] < 0 && !k.endsWith('Why')) throw new Error(`${fileName}: column "${c}" is missing from the "Order Payments" sheet. Meesho may have changed the file.`);
  }
  const sumIdx = [];
  for (let c = at.sale; c <= at.recov; c++) if (hdr[c] && !NOT_IN_SUM.has(hdr[c])) sumIdx.push(c);

  const lines = [];
  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i];
    const sub = text(r[at.sub]);
    if (!sub || !/\d/.test(sub)) continue; // skips the formula-letter row under the headers
    const v = (k) => money(r[at[k]]);
    const parts = sumIdx.reduce((a, c) => a + money(r[c]), 0);
    const known = v('sale') + v('ret') + v('comm') + v('retship') + v('ship') + v('tcs') + v('tds') + v('comp') + v('claims') + v('recov');
    const g = v('gst');
    const odate = isoDate(r[at.odate]);
    lines.push({
      sub,
      odate,
      dispatch: isoDate(r[at.dispatch]),
      product: text(r[at.product]),
      sku: text(r[at.sku]),
      status: text(r[at.status]),
      gst: g,
      listing: v('listing'),
      qty: v('qty'),
      txn: text(r[at.txn]),
      pdate: isoDate(r[at.pdate]),
      final: v('final'),
      sale: v('sale'),
      ret: v('ret'),
      comm: v('comm'),
      retship: v('retship'),
      ship: v('ship'),
      tcs: v('tcs'),
      tds: v('tds'),
      comp: v('comp'),
      claims: v('claims'),
      recov: v('recov'),
      other: parts - known, // fixed / warehousing / support fees, return premiums, platform fees
      parts,
      why: ['compWhy', 'claimWhy', 'recovWhy'].map((k) => (at[k] >= 0 ? text(r[at[k]]) : '')).filter(Boolean).join(' '),
      row: i + 1,
    });
  }

  const ads = [];
  if (wb.SheetNames.includes('Ads Cost')) {
    const g = XLSX.utils.sheet_to_json(wb.Sheets['Ads Cost'], { header: 1, raw: true, defval: null, blankrows: false });
    for (const r of g) {
      if (!r || !/^20\d\d-\d\d-\d\d/.test(text(r[1]))) continue;
      const total = toNumber(r[7]);
      if (total === null || Number.isNaN(total)) continue;
      ads.push({ period: isoDate(r[0]), date: isoDate(r[1]), campaign: text(r[2]), cost: money(r[3]), credits: money(r[4]), gst: money(r[6]), total });
    }
  }

  // Sheets the tool does not handle yet: report any data so nothing is silently ignored.
  const unhandled = [];
  for (const name of ['Referral Payments', 'Compensation and Recovery']) {
    if (!wb.SheetNames.includes(name)) continue;
    const g = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    const rows = g.slice(2).filter((r) => r && r[0] !== null && !/^No data/i.test(text(r[0])));
    if (rows.length) unhandled.push({ sheet: name, rows: rows.length });
  }
  return { kind: PKIND.PAYMENTS, lines, ads, unhandled };
}
