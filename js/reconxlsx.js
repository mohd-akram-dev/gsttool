// Excel download for the payment reconciliation (SheetJS). Values only: the page is where costs
// are edited; the file is the record to keep or share with an accountant.
import * as XLSX from '../lib/xlsx.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (m) => (m === 'ALL' ? 'Total' : `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`);
const MONEY = '#,##0.00;-#,##0.00';
const PCT = '0.0%';

// rows: array of arrays; money / pct: sets of column indexes to format
function sheet(rows, { money = new Set(), pct = new Set(), widths = [], firstDataRow = 1 } = {}) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  for (let r = firstDataRow; r < rows.length; r++) {
    for (let c = 0; c < (rows[r] || []).length; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.t !== 'n') continue;
      if (money.has(c)) cell.z = MONEY;
      else if (pct.has(c)) cell.z = PCT;
    }
  }
  if (widths.length) ws['!cols'] = widths.map((w) => ({ wch: w }));
  return ws;
}

export function reconFileName(r) {
  const span = r.months.length ? `${r.months[0]}_to_${r.months[r.months.length - 1]}` : 'month';
  return `Meesho_Reconciliation_${r.supplierId || 'store'}_${span}.xlsx`;
}

export function buildReconWorkbook(r, { storeLabel = '' } = {}) {
  const wb = XLSX.utils.book_new();
  const cols = [...r.months, 'ALL'];

  // ---- Summary ----
  const S = [];
  S.push(['Meesho payment reconciliation']);
  S.push([`${storeLabel || 'Store'}${r.supplierId ? ` (supplier ID ${r.supplierId})` : ''}${r.isGst ? ', GST store' : ', non-GST store'}`]);
  S.push([`Orders placed ${monthLabel(r.months[0])} to ${monthLabel(r.months[r.months.length - 1])}; payments up to ${r.end}. Amounts in Rs.`]);
  S.push([]);
  const kpiStart = S.length;
  S.push(['By order month', ...cols.map(monthLabel)]);
  const krow = (label, key) => S.push([label, ...cols.map((m) => r.kpi[m][key] ?? '')]);
  krow('Orders placed', 'orders');
  krow('Order value (listing price)', 'orderValue');
  krow('Cancelled', 'cancelled');
  krow('RTO (not delivered, came back)', 'rto');
  krow('Delivered', 'delivered');
  krow('Customer returns', 'returns');
  krow('Kept by customer (real sales)', 'kept');
  krow('Cancel rate (of orders)', 'cancelRate');
  krow('RTO rate (of shipped)', 'rtoRate');
  krow('Return rate (of delivered)', 'returnRate');
  krow('Success rate (kept / orders)', 'successRate');
  krow('Money received from Meesho', 'received');
  krow('  of which return shipping charged', 'returnCharges');
  krow('  of which claims paid back', 'claims');
  krow('Still to receive (estimate)', 'pending');
  krow('Average payout per kept order', 'avgPayoutKept');
  S.push([]);
  if (r.profitReady) {
    S.push(['Profit by order month', ...cols.map(monthLabel)]);
    krow('Money from Meesho (received + still to receive)', 'money');
    if (r.isGst) {
      krow('GST inside these sales (paid to the government)', 'gst');
      krow("TCS credit back (Meesho's TCS counts against GST)", 'tcs');
    }
    krow('Ads cost', 'ads');
    krow('Product cost', 'product');
    krow(`Packaging (Rs ${r.packaging} per parcel shipped)`, 'packing');
    krow('Profit', 'profit');
    krow('Profit per order placed', 'profitPerOrder');
    krow('Profit margin (of money from Meesho)', 'margin');
  } else {
    S.push([`Profit not shown: cost per piece missing for ${r.missingCosts.join(', ')}.`]);
  }
  S.push([]);
  S.push(['Cash received by payment month', 'Rs']);
  for (const c of r.cash) S.push([`Paid in ${monthLabel(c.month)}${c.month === r.end.slice(0, 7) ? ` (up to ${r.end})` : ''}`, c.amount]);
  S.push(['Total paid by Meesho', r.totals.cash]);
  S.push(['  for the orders in this review', r.totals.forOrders]);
  S.push(['  for later orders (not in this Orders export)', r.totals.later]);
  if (r.ads.length) S.push(['  ads cost deducted', r.totals.ads]);
  S.push([]);
  S.push(['Checks']);
  for (const i of r.issues) S.push([`${i.level.toUpperCase()}: ${i.message}`]);
  const pctRows = new Set(['Cancel rate (of orders)', 'RTO rate (of shipped)', 'Return rate (of delivered)', 'Success rate (kept / orders)', 'Profit margin (of money from Meesho)']);
  const ws = sheet(S, { widths: [52, 14, 14, 14, 14] });
  for (let row = kpiStart; row < S.length; row++) {
    const isPct = pctRows.has(S[row][0]);
    const isCount = ['Orders placed', 'Cancelled', 'RTO (not delivered, came back)', 'Delivered', 'Customer returns', 'Kept by customer (real sales)'].includes(S[row][0]);
    for (let c = 1; c < (S[row] || []).length; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: row, c })];
      if (cell && cell.t === 'n' && !isCount) cell.z = isPct ? PCT : MONEY;
    }
  }
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');

  // ---- Orders ----
  const O = [['Sub order no', 'Order date', 'Month', 'SKU', 'Product', 'Group', 'Customer state', 'Listing price',
    'Order status', 'Payment status', 'Payment lines', 'Received Rs', 'Return shipping Rs', 'Claims Rs', 'Still to receive Rs (est.)',
    'GST rate', 'GST payable Rs', 'TCS credit Rs', 'Cost per piece Rs', 'Product cost Rs', 'Packaging Rs', 'Profit Rs',
    'Payment date(s)', 'Transaction id(s)', 'Result', 'Action']];
  for (const x of r.recs) {
    const cost = r.skus.find((s) => s.sku === x.sku)?.cost;
    O.push([x.sub, x.odate, x.month, x.sku, x.product, x.family, x.state, x.price, x.status, x.pstatus, x.lines, x.paid, x.retship,
      x.claims, x.pending || '', x.gstRate, x.gstOut, x.tcsCredit, cost ?? '', x.productCost, x.packaging, r.profitReady ? x.profit : '',
      x.pdates, x.txns, x.result, x.action]);
  }
  XLSX.utils.book_append_sheet(wb, sheet(O, {
    money: new Set([7, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21]),
    widths: [22, 11, 9, 18, 30, 13, 14, 9, 14, 11, 8, 11, 11, 10, 12, 8, 10, 9, 10, 11, 10, 10, 22, 34, 46, 50],
  }), 'Orders');

  // ---- Bank transfers ----
  const B = [['Payment date', 'Transaction id', 'Orders in this transfer', 'Amount Rs', 'Found in bank statement? (Y/N)', 'Note']];
  for (const c of r.credits) B.push([c.date, c.txn, c.count, c.amount, '', '']);
  for (const a of r.ads) B.push([a.date, `Ads cost (campaign ${a.campaign})`, '', a.total, '', "Deducted by Meesho; that day's transfer is likely lower by this amount"]);
  B.push(['Total', '', '', r.totals.cash, '', '']);
  if (r.totals.noTxnLines) B.push([`${r.totals.noTxnLines} payment line(s) have no transaction id (RTO settled at Rs 0): no money moved.`]);
  XLSX.utils.book_append_sheet(wb, sheet(B, { money: new Set([3]), widths: [22, 30, 12, 14, 18, 60] }), 'Bank transfers');

  // ---- Products ----
  const P = [['SKU', 'Product', 'Group', 'Orders', 'Cancelled', 'RTO', 'Delivered', 'Customer returns', 'Lost in return', 'Kept (sold)',
    'Received Rs', 'Still to receive Rs', 'GST payable Rs', 'TCS credit Rs', 'Cost per piece Rs', 'Product cost Rs', 'Packaging Rs',
    'Profit Rs', 'Profit per piece sold Rs', 'Break-even cost per piece Rs', 'Margin', 'Success rate']];
  for (const s of r.skus) {
    P.push([s.sku, s.product, s.family, s.orders, s.cancelled, s.rto, s.delivered, s.returns, s.lost, s.kept, s.received, s.pending,
      s.gst, s.tcs, s.cost ?? '', s.productCost, s.packaging, r.profitReady ? s.profit : '', r.profitReady ? s.perKept : '',
      s.breakEven, r.profitReady ? s.margin : '', s.successRate ?? '']);
  }
  XLSX.utils.book_append_sheet(wb, sheet(P, {
    money: new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
    pct: new Set([20, 21]),
    widths: [20, 30, 13, 7, 9, 6, 9, 9, 9, 9, 11, 11, 10, 9, 10, 11, 10, 10, 12, 12, 8, 9],
  }), 'Products');

  // ---- Payment lines ----
  const orderSubs = new Set(r.recs.map((x) => x.sub));
  const L = [['Sub order no', 'Order date', 'Dispatch date', 'SKU', 'Payment status', 'Payment date', 'Transaction id', 'GST %',
    'Sale Rs', 'Sale return Rs', 'Shipping Rs', 'Return shipping Rs', 'Commission Rs', 'Other fees Rs', 'TCS Rs', 'TDS Rs',
    'Claims + compensation Rs', 'Recovery Rs', 'Final settlement Rs', 'Reason', 'Order in this export?', 'From file']];
  for (const l of [...r.lines].sort((a, b) => a.pdate.localeCompare(b.pdate) || a.sub.localeCompare(b.sub))) {
    L.push([l.sub, l.odate, l.dispatch, l.sku, l.status, l.pdate, l.txn, l.gst, l.sale, l.ret, l.ship, l.retship, l.comm,
      Math.round(l.other * 100) / 100, l.tcs, l.tds, l.claims + l.comp, l.recov, l.final, l.why, orderSubs.has(l.sub) ? 'Yes' : 'No (later order)', l.file]);
  }
  XLSX.utils.book_append_sheet(wb, sheet(L, {
    money: new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]),
    widths: [22, 11, 11, 18, 10, 11, 20, 6, 10, 10, 10, 10, 10, 10, 8, 8, 12, 10, 12, 40, 16, 40],
  }), 'Payment lines');

  if (r.ads.length) {
    const A = [['Ad period', 'Deducted on', 'Campaign', 'Ad cost Rs', 'Credits / waivers Rs', 'GST Rs', 'Total deducted Rs']];
    for (const a of r.ads) A.push([a.period, a.date, a.campaign, a.cost, a.credits, a.gst, a.total]);
    XLSX.utils.book_append_sheet(wb, sheet(A, { money: new Set([3, 4, 5, 6]), widths: [12, 12, 14, 12, 16, 10, 16] }), 'Ads');
  }
  return wb;
}

export function downloadReconWorkbook(r, opts) {
  XLSX.writeFile(buildReconWorkbook(r, opts), reconFileName(r));
}
