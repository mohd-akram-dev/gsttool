// Golden test for the payment reconciliation engine on real store folders (Node 18+).
//
//   node tests/recon.mjs tests/private/recon-golden.json
//
// The JSON lists store folders and the expected results worked out independently.
// Real data and expectations stay in tests/private/ (git-ignored).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readPaymentOrOrders } from '../js/payreaders.js';
import { buildRecon } from '../js/recon.js';
import { buildReconWorkbook } from '../js/reconxlsx.js';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let pass = 0;
let fail = 0;
const near = (a, b) => Math.abs(a - b) < 0.005;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// Cost rule used in the hand analysis: tiara 80, 'set' / 'combo' in the SKU 110, other 80.
const costFor = (sku) => {
  const s = sku.toLowerCase();
  if (s.includes('tiara')) return 80;
  if (s.includes('set') || s.includes('combo')) return 110;
  return 80;
};

for (const store of cfg.stores) {
  console.log(`\n== ${store.name}`);
  const files = [];
  for (const name of readdirSync(store.dir).sort()) {
    if (!/\.(csv|xlsx)$/i.test(name) || name.startsWith('~$') || name.startsWith('Meesho_Reconciliation')) continue;
    const res = readPaymentOrOrders(readFileSync(join(store.dir, name)), name);
    files.push({ name, ...res });
    console.log(`  read ${name.slice(0, 60)}: ${res.kind}, ${res.kind === 'orders' ? res.orders.length : res.lines.length} rows`);
  }
  const skus = new Set(files.flatMap((f) => (f.orders || []).map((o) => o.sku)));
  const costs = Object.fromEntries([...skus].map((s) => [s, costFor(s)]));
  const r = buildRecon({ files, costs, packaging: 10 });
  const e = store.expect;
  for (const i of r.issues) console.log(`  [${i.level}] ${i.message}`);

  check('no errors', r.ok);
  check('orders', r.recs.length === e.orders, `${r.recs.length} vs ${e.orders}`);
  check('GST store detected', r.isGst === e.isGst);
  check('bank transfers', r.credits.length === e.credits, `${r.credits.length} vs ${e.credits}`);
  check('cash total', near(r.totals.cash, e.cash), `${r.totals.cash} vs ${e.cash}`);
  check('later orders amount', near(r.totals.later, e.later), `${r.totals.later} vs ${e.later}`);
  check('later order lines', r.orphans.length === e.orphans, `${r.orphans.length} vs ${e.orphans}`);
  check('ads', near(r.totals.ads, e.ads), `${r.totals.ads} vs ${e.ads}`);
  for (const [m, v] of Object.entries(e.cashByMonth)) {
    const got = r.cash.find((c) => c.month === m)?.amount ?? null;
    check(`cash ${m}`, got !== null && near(got, v), `${got} vs ${v}`);
  }
  check('profit ready', r.profitReady, r.missingCosts.join(', '));
  for (const [m, exp] of Object.entries(e.kpi)) {
    for (const [k, v] of Object.entries(exp)) {
      const got = r.kpi[m]?.[k];
      check(`${m} ${k}`, got !== undefined && near(got, v), `${got} vs ${v}`);
    }
  }
  // Products add up to the total (before ads).
  const skuProfit = r.skus.reduce((a, s) => a + s.profit, 0);
  check('product profits add up', near(skuProfit - (-r.totals.ads), r.kpi.ALL.profit), `${skuProfit} vs ${r.kpi.ALL.profit}`);
  // Excel export builds.
  const wb = buildReconWorkbook(r, { storeLabel: store.name });
  check('excel has 5+ sheets', wb.SheetNames.length >= 5, wb.SheetNames.join(','));
  console.log(`  profit ${r.kpi.ALL.profit} | cash ${r.totals.cash} | transfers ${r.credits.length}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
