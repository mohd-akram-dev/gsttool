// Payment reconciliation and profit engine for Meesho stores. Pure functions; no DOM.
// Same logic as the analysis done by hand for three stores (see DEV_NOTES.md section 10),
// whose results are the golden tests in tests/recon.mjs.
import { round2, sum2 } from './money.js';

export const DEFAULT_PACKAGING = 10;
const OVERDUE_DAYS = 14; // a delivered order placed this long before the last payment date should be paid

// Product group, used only to fill costs for similar products in one go.
export function familyOf(sku, product = '') {
  const s = String(sku).toLowerCase();
  const p = String(product).toLowerCase();
  if (s.includes('tiara') || p.includes('tiara')) return 'Tiara';
  if (s.includes('set')) return 'Jewellery set';
  if (s.includes('combo')) return 'Watch combo';
  if (s.includes('watch')) return 'Watch';
  if (/jewel|jewell|set\b/.test(p)) return 'Jewellery set';
  if (p.includes('combo')) return 'Watch combo';
  if (p.includes('watch')) return 'Watch';
  if (/necklace|nkl/.test(p + s)) return 'Necklace';
  return 'Other';
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (a, b) => (b ? a / b : null);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * files: [{ name, kind: 'orders'|'payments', supplierId, from, to, orders?, lines?, ads?, unhandled? }]
 *        in upload order; payment files are processed oldest period first.
 * costs: { [sku]: number }  cost per piece; packaging: Rs per parcel shipped.
 */
export function buildRecon({ files = [], costs = {}, packaging = DEFAULT_PACKAGING }) {
  const issues = [];
  const issue = (level, message, details = []) => issues.push({ level, message, details });

  const orderFiles = files.filter((f) => f.kind === 'orders');
  const payFiles = files.filter((f) => f.kind === 'payments')
    .map((f, i) => ({ ...f, i }))
    .sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')) || a.i - b.i);
  if (!orderFiles.length) issue('error', 'Add the Orders export (CSV) for the month you want to check.');
  if (!payFiles.length) issue('error', 'Add the payment files (xlsx) for that month and the next month.');

  const ids = [...new Set(files.map((f) => f.supplierId).filter(Boolean))];
  if (ids.length > 1) issue('error', `These files are from different Meesho stores (supplier IDs ${ids.join(', ')}). Check one store at a time.`);
  const supplierId = ids.length === 1 ? ids[0] : null;
  if (!orderFiles.length || !payFiles.length || ids.length > 1) return empty(issues, supplierId);

  // ---- orders (one row per sub-order) ----
  const orders = new Map();
  for (const f of orderFiles) {
    for (const o of f.orders) {
      const prev = orders.get(o.sub);
      if (prev && (prev.status !== o.status || prev.odate !== o.odate)) {
        issue('warning', `Order ${o.sub} appears in two order files with different details; the later file is used.`);
      }
      orders.set(o.sub, o);
    }
  }

  // ---- payment lines (each line is one money event) ----
  const lines = [];
  const seen = new Set();
  let dupes = 0;
  const mismatch = [];
  const unhandled = [];
  for (const f of payFiles) {
    f.lines.forEach((l, j) => {
      const key = [l.sub, l.pdate, l.txn, l.status, l.final, l.sale, l.claims].join('|');
      if (seen.has(key)) { dupes++; return; }
      seen.add(key);
      if (Math.abs(l.parts - l.final) > 0.011) mismatch.push(`${f.name} row ${l.row}: parts add up to ${round2(l.parts)}, final is ${l.final}`);
      lines.push({ ...l, file: f.name, order: lines.length, fi: f.i, j });
    });
    for (const u of f.unhandled || []) unhandled.push(`${f.name}: sheet "${u.sheet}" has ${u.rows} row(s)`);
  }
  if (dupes) issue('warning', `${dupes} payment line(s) appeared in more than one payment file and were counted once. Do the payment files overlap?`);
  if (mismatch.length) issue('warning', `${mismatch.length} payment line(s) where Meesho's own amounts do not add up to the final settlement. Meesho may have changed the file.`, mismatch);
  if (unhandled.length) issue('warning', 'Some payment-file sheets have data this tool does not include yet (referral payments or platform compensation / recovery). Their amounts are not in these totals.', unhandled);
  // Ads deductions, once each even if the same payment file was added twice.
  const adsSeen = new Set();
  const ads = payFiles.flatMap((f) => f.ads || []).filter((a) => {
    const key = [a.period, a.date, a.campaign, a.cost, a.credits, a.total].join('|');
    if (adsSeen.has(key)) return false;
    adsSeen.add(key);
    return true;
  });

  const isGst = lines.some((l) => l.gst > 0);
  const end = lines.reduce((a, l) => (l.pdate > a ? l.pdate : a), '');
  const overdueBefore = end ? addDays(end, -OVERDUE_DAYS) : '';

  const bySub = new Map();
  for (const l of lines) {
    if (!bySub.has(l.sub)) bySub.set(l.sub, []);
    bySub.get(l.sub).push(l);
  }

  // Estimate for delivered orders not yet paid: median payout at the same listing price, and the
  // GST / TCS that usually come with such a payout (zero for a non-GST store).
  const payoutByPrice = new Map();
  for (const l of lines) {
    if (l.status === 'Delivered' && l.final > 0) {
      if (!payoutByPrice.has(l.listing)) payoutByPrice.set(l.listing, { pay: [], gst: [], tcs: [] });
      const p = payoutByPrice.get(l.listing);
      p.pay.push(l.final);
      p.gst.push(((l.sale + l.ret) * l.gst) / (100 + l.gst) / l.final);
      p.tcs.push(-l.tcs / l.final);
    }
  }
  const expectedPayout = (price) => {
    if (!payoutByPrice.size) return { payout: 0, gst: 0, tcs: 0 };
    const near = payoutByPrice.has(price) ? price
      : [...payoutByPrice.keys()].reduce((a, b) => (Math.abs(b - price) < Math.abs(a - price) ? b : a));
    const p = payoutByPrice.get(near);
    const payout = round2(median(p.pay) + (price - near));
    return { payout, gst: round2(payout * median(p.gst)), tcs: round2(payout * median(p.tcs)) };
  };

  // ---- classify every order ----
  const unknownStatus = new Set();
  const recs = [...orders.values()].sort((a, b) => a.odate.localeCompare(b.odate) || a.sub.localeCompare(b.sub)).map((o) => {
    const ls = bySub.get(o.sub) || [];
    const paid = sum2(ls.map((l) => l.final));
    const claims = sum2(ls.map((l) => l.claims + l.comp));
    const retship = sum2(ls.map((l) => l.retship));
    const statuses = ls.map((l) => l.status).filter(Boolean);
    const last = statuses.length ? statuses[statuses.length - 1] : '';
    const rec = {
      ...o,
      lines: ls.length,
      paid,
      claims,
      retship,
      pstatus: last,
      gstOut: round2(ls.reduce((a, l) => a + ((l.sale + l.ret) * l.gst) / (100 + l.gst), 0)),
      tcsCredit: round2(-ls.reduce((a, l) => a + l.tcs, 0)),
      gstRate: [...new Set(ls.filter((l) => l.sale).map((l) => `${l.gst}%`))].join(', '),
      pdates: [...new Set(ls.map((l) => l.pdate).filter(Boolean))].sort().join(', '),
      txns: [...new Set(ls.map((l) => l.txn).filter((t) => t && t !== 'NA'))].sort().join(', '),
      pending: 0,
      result: '',
      action: '',
      flag: '',
    };
    const s = o.status;
    if (s === 'CANCELLED') {
      rec.result = 'Cancelled - no payment due';
      if (ls.length && Math.abs(paid) > 0.005) { rec.result = 'Cancelled but money moved'; rec.action = 'Check with Meesho'; rec.flag = 'bad'; }
    } else if (s === 'RTO_COMPLETE') {
      rec.result = ls.length ? 'RTO - settled at Rs 0 (no charge)' : 'RTO - nothing due';
      if (ls.length && Math.abs(paid) > 0.005) { rec.result = 'RTO with a charge'; rec.action = 'Check the deduction'; rec.flag = 'bad'; }
    } else if (s === 'DELIVERED') {
      if (last === 'Return') {
        rec.result = `Customer return - Rs ${-retship} return shipping charged`;
        if (claims > 0) rec.result += `, claim received Rs ${claims.toFixed(2)}`;
        else { rec.action = 'If it came back damaged / wrong / incomplete, raise a return claim on Meesho'; rec.flag = 'warn'; }
      } else if (last === 'Delivered' && paid > 0) {
        rec.result = 'Delivered - paid';
      } else if (!ls.length) {
        const est = expectedPayout(o.price);
        rec.pending = est.payout;
        rec.gstOut = est.gst; // estimates until the payment arrives
        rec.tcsCredit = est.tcs;
        if (o.odate <= overdueBefore) {
          rec.result = `Delivered - NOT PAID by ${end}`;
          rec.action = 'Raise a payment ticket with Meesho if it is not in the next payment file';
          rec.flag = 'bad';
        } else {
          rec.result = `Delivered - payment expected after ${end}`;
        }
      } else {
        rec.result = `Delivered - check (payment status ${last || 'blank'}, paid ${paid})`;
        rec.action = 'Check';
        rec.flag = 'warn';
      }
    } else {
      unknownStatus.add(s || '(blank)');
      rec.result = ls.length ? `Status ${s}: received Rs ${paid}` : `Status ${s}: nothing paid yet`;
      rec.flag = 'warn';
    }
    const kept = s === 'DELIVERED' && last !== 'Return';
    const ret = s === 'DELIVERED' && last === 'Return';
    rec.kept = kept ? 1 : 0;
    rec.returned = ret ? 1 : 0;
    rec.lost = ret && claims > 0 ? 1 : 0;
    rec.shipped = s === 'DELIVERED' || s === 'RTO_COMPLETE' ? 1 : 0;
    rec.family = familyOf(o.sku, o.product);
    return rec;
  });
  if (unknownStatus.size) issue('warning', `Order status(es) this tool does not know yet: ${[...unknownStatus].join(', ')}. Those orders are listed but not counted as sales.`);

  const orphans = lines.filter((l) => !orders.has(l.sub));

  // ---- costs and profit per order ----
  const skuList = [...new Set(recs.map((r) => r.sku))];
  const needCost = new Set(recs.filter((r) => r.kept || r.lost).map((r) => r.sku));
  const costOf = (sku) => {
    const c = costs[sku];
    return c === null || c === undefined || c === '' || !Number.isFinite(Number(c)) ? null : Number(c);
  };
  const missingCosts = skuList.filter((s) => needCost.has(s) && costOf(s) === null);
  const pack = Number.isFinite(Number(packaging)) ? Number(packaging) : DEFAULT_PACKAGING;
  for (const r of recs) {
    const c = costOf(r.sku) ?? 0;
    r.productCost = round2(c * (r.kept + r.lost));
    r.packaging = round2(pack * r.shipped);
    r.profit = round2(r.paid + r.pending - r.gstOut + r.tcsCredit - r.productCost - r.packaging);
  }
  const profitReady = missingCosts.length === 0;

  // ---- per order month ----
  const months = [...new Set(recs.map((r) => r.month))].sort();
  const adsFor = (m) => -sum2(ads.filter((a) => m === 'ALL' || a.date.slice(0, 7) === m).map((a) => a.total));
  const kpiOf = (rs, m) => {
    const n = rs.length;
    const canc = rs.filter((r) => r.status === 'CANCELLED').length;
    const rto = rs.filter((r) => r.status === 'RTO_COMPLETE').length;
    const deliv = rs.filter((r) => r.status === 'DELIVERED');
    const returns = deliv.filter((r) => r.returned).length;
    const kept = deliv.length - returns;
    const paidKept = rs.filter((r) => r.result === 'Delivered - paid');
    const money = sum2(rs.map((r) => r.paid + r.pending));
    const gst = sum2(rs.map((r) => r.gstOut));
    const tcs = sum2(rs.map((r) => r.tcsCredit));
    const product = sum2(rs.map((r) => r.productCost));
    const packing = sum2(rs.map((r) => r.packaging));
    const adsCost = adsFor(m);
    const profit = round2(money - gst + tcs - adsCost - product - packing);
    return {
      orders: n,
      orderValue: sum2(rs.map((r) => r.price)),
      cancelled: canc,
      rto,
      delivered: deliv.length,
      returns,
      kept,
      cancelRate: pct(canc, n),
      rtoRate: pct(rto, n - canc),
      returnRate: pct(returns, deliv.length),
      successRate: pct(kept, n),
      received: sum2(rs.map((r) => r.paid)),
      returnCharges: sum2(rs.map((r) => r.retship)),
      claims: sum2(rs.map((r) => r.claims)),
      pending: sum2(rs.map((r) => r.pending)),
      pendingCount: rs.filter((r) => r.pending).length,
      avgPayoutKept: paidKept.length ? round2(mean(paidKept.map((r) => r.paid))) : 0,
      avgPrice: n ? round2(mean(rs.map((r) => r.price))) : 0,
      money,
      gst,
      tcs,
      ads: adsCost,
      product,
      packing,
      profit,
      profitPerOrder: n ? profit / n : 0,
      margin: money ? profit / money : 0,
    };
  };
  const kpi = {};
  for (const m of months) kpi[m] = kpiOf(recs.filter((r) => r.month === m), m);
  kpi.ALL = kpiOf(recs, 'ALL');

  // ---- cash and bank transfers ----
  const cashMap = new Map();
  for (const l of lines) cashMap.set(l.pdate.slice(0, 7), (cashMap.get(l.pdate.slice(0, 7)) || 0) + l.final);
  for (const a of ads) cashMap.set(a.date.slice(0, 7), (cashMap.get(a.date.slice(0, 7)) || 0) + a.total);
  const cash = [...cashMap.entries()].sort().map(([month, amount]) => ({ month, amount: round2(amount) }));
  const creditMap = new Map();
  for (const l of lines) {
    const t = l.txn && l.txn !== 'NA' ? l.txn : 'NA';
    const c = creditMap.get(t) || { txn: t, dates: new Set(), count: 0, amount: 0 };
    c.dates.add(l.pdate);
    c.count++;
    c.amount += l.final;
    creditMap.set(t, c);
  }
  const credits = [...creditMap.values()].filter((c) => c.txn !== 'NA')
    .map((c) => ({ txn: c.txn, date: [...c.dates].sort().join(', '), count: c.count, amount: round2(c.amount) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.txn.localeCompare(b.txn));
  const noTxn = creditMap.get('NA');

  const totals = {
    cash: sum2(cash.map((c) => c.amount)),
    forOrders: sum2(recs.map((r) => r.paid)),
    later: sum2(orphans.map((l) => l.final)),
    ads: sum2(ads.map((a) => a.total)),
    noTxnLines: noTxn ? noTxn.count : 0,
    noTxnAmount: noTxn ? round2(noTxn.amount) : 0,
  };
  const balance = round2(totals.forOrders + totals.later + totals.ads - totals.cash);
  if (Math.abs(balance) > 0.01) issue('error', `Internal check failed: payments do not add up (difference Rs ${balance}). Do not rely on these figures; report this.`);

  // ---- per product ----
  const skus = skuList.map((sku) => {
    const rs = recs.filter((r) => r.sku === sku);
    const k = kpiOf(rs, null);
    const money = k.money;
    const profit = round2(money - k.gst + k.tcs - k.product - k.packing); // ads are not split by product
    return {
      sku,
      product: rs[0].product,
      family: rs[0].family,
      orders: k.orders,
      cancelled: k.cancelled,
      rto: k.rto,
      delivered: k.delivered,
      returns: k.returns,
      lost: rs.reduce((a, r) => a + r.lost, 0),
      kept: k.kept,
      received: k.received,
      pending: k.pending,
      gst: k.gst,
      tcs: k.tcs,
      cost: costOf(sku),
      productCost: k.product,
      packaging: k.packing,
      profit,
      perKept: k.kept ? profit / k.kept : 0,
      breakEven: k.kept ? (money - k.gst + k.tcs) / k.kept : 0,
      margin: money ? profit / money : 0,
      successRate: k.successRate,
      needsCost: needCost.has(sku),
    };
  }).sort((a, b) => b.orders - a.orders || a.sku.localeCompare(b.sku));

  // ---- things to act on ----
  const overdue = recs.filter((r) => r.result.includes('NOT PAID'));
  if (overdue.length) issue('warning', `${overdue.length} delivered order(s) are not paid yet although they are more than ${OVERDUE_DAYS} days old. Check the next payment file; raise a ticket if they stay unpaid.`, overdue.map((r) => `${r.odate} ${r.sub} ${r.sku}`));
  const waiting = recs.filter((r) => r.pending && !r.result.includes('NOT PAID'));
  if (waiting.length) issue('info', `${waiting.length} delivered order(s) are not paid yet (recent; estimated Rs ${sum2(waiting.map((r) => r.pending))}). Add the next payment file later to close them.`, waiting.map((r) => `${r.odate} ${r.sub} ${r.sku}`));
  const noClaim = recs.filter((r) => r.returned && !r.claims);
  if (noClaim.length) issue('warning', `${noClaim.length} customer return(s) have no claim. If any came back damaged, wrong or incomplete, raise a claim on Meesho.`, noClaim.map((r) => `${r.odate} ${r.sub} ${r.sku}`));
  const odd = recs.filter((r) => r.flag === 'bad' && !r.result.includes('NOT PAID'));
  if (odd.length) issue('error', `${odd.length} order(s) where money moved unexpectedly (cancelled or RTO but charged/paid). Check them.`, odd.map((r) => `${r.sub}: ${r.result}`));
  if (orphans.length) issue('info', `${orphans.length} payment line(s) are for orders not in the uploaded Orders export (usually next month's orders): Rs ${totals.later}. They are in the bank total but not in this month's profit.`);
  if (!profitReady) issue('info', `Enter the cost per piece for ${missingCosts.length} product(s) to see profit.`);
  if (ads.length) issue('info', `Ads cost deducted by Meesho: Rs ${-totals.ads}. It is included in the bank total and the profit.`);

  return {
    ok: !issues.some((i) => i.level === 'error'),
    supplierId,
    isGst,
    end,
    months,
    recs,
    kpi,
    cash,
    credits,
    ads,
    orphans,
    skus,
    lines,
    totals,
    profitReady,
    missingCosts,
    packaging: pack,
    issues,
  };
}

function empty(issues, supplierId) {
  return { ok: false, supplierId, isGst: false, end: '', months: [], recs: [], kpi: {}, cash: [], credits: [], ads: [], orphans: [], skus: [], lines: [], totals: null, profitReady: false, missingCosts: [], packaging: DEFAULT_PACKAGING, issues };
}
