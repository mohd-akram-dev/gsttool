// "Payments & profit" tab: Meesho orders + payment files -> reconciliation, bank check and profit.
// Also owns the switch between the two tabs of the page.
import { readPaymentOrOrders } from './payreaders.js';
import { buildRecon, DEFAULT_PACKAGING } from './recon.js';
import { downloadReconWorkbook, monthLabel } from './reconxlsx.js';
import { fmtINR } from './money.js';
import { $, h, N, moneyCell, numCell, pctText, table, field, tile, checksList, loadJSON, saveJSON } from './dom.js';

// ---------- tabs ----------
const TAB_KEY = 'meesho-tab-v1';
function showTab(name) {
  const pay = name === 'pay';
  $('view-gst').hidden = pay;
  $('view-pay').hidden = !pay;
  document.body.classList.toggle('view-pay', pay);
  for (const b of document.querySelectorAll('.apptabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  saveJSON(TAB_KEY, name);
  if (location.hash !== (pay ? '#payments' : '#gst')) history.replaceState(null, '', pay ? '#payments' : '#gst');
}
for (const b of document.querySelectorAll('.apptabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
showTab(location.hash === '#payments' ? 'pay' : location.hash === '#gst' ? 'gst' : loadJSON(TAB_KEY, 'gst'));

// ---------- remembered costs, per store ----------
const COST_KEY = 'meesho-costs-v1';
const allStores = loadJSON(COST_KEY, {});
const storeKey = (id) => id || 'unknown-store';
function storeRec(id) {
  const k = storeKey(id);
  allStores[k] ??= { name: '', packaging: DEFAULT_PACKAGING, costs: {} };
  return allStores[k];
}
const saveStores = () => saveJSON(COST_KEY, allStores);

// ---------- state ----------
// onlyAction: null = automatic (on when some orders need action), then whatever the seller picks.
const state = { files: [], result: null, tab: 'orders', onlyAction: null, costSig: null };
let nextId = 1;

async function addFiles(list) {
  for (const f of list) {
    if (f.name.startsWith('~$') || f.name.startsWith('Meesho_Reconciliation')) continue;
    const entry = { id: nextId++, name: f.name, size: f.size, kind: null, error: null };
    try {
      Object.assign(entry, readPaymentOrOrders(await f.arrayBuffer(), f.name));
    } catch (e) {
      entry.error = e.message;
    }
    state.files = state.files.filter((x) => !(x.name === entry.name && x.size === entry.size));
    state.files.push(entry);
  }
  refresh();
}

function currentStoreId() {
  const ids = [...new Set(state.files.filter((f) => f.kind).map((f) => f.supplierId).filter(Boolean))];
  return ids.length === 1 ? ids[0] : null;
}

function compute() {
  const files = state.files.filter((f) => f.kind);
  if (!files.length) return null;
  const store = storeRec(currentStoreId());
  return buildRecon({ files, costs: store.costs, packaging: store.packaging });
}

function refresh() {
  let r = null;
  let crash = null;
  try { r = compute(); } catch (e) { crash = e; console.error(e); }
  state.result = r;
  renderFiles();
  const ready = !!(r && r.recs.length);
  $('pay-checks-card').hidden = !(r || crash);
  $('pay-costs-card').hidden = !ready;
  $('pay-summary-card').hidden = !ready;
  $('pay-details-card').hidden = !ready;
  if (crash) $('pay-checks').replaceChildren(...checksList([{ level: 'error', message: `Unexpected problem: ${crash.message}. Please report this.`, details: [] }]));
  else if (r) $('pay-checks').replaceChildren(...checksList(r.issues));
  if (!ready) { state.costSig = null; return; }
  renderCosts(r);
  renderSummary(r);
  renderDetails(r);
}

// ---------- files ----------
function renderFiles() {
  const list = $('pay-files');
  const kindText = (f) => {
    if (f.kind === 'orders') return `Orders export · ${f.orders.length} orders${f.from ? ` · ${f.from} to ${f.to}` : ''}`;
    return `Payment file · ${f.lines.length} payment lines${f.from ? ` · paid ${f.from} to ${f.to}` : ''}${f.ads.length ? ` · ${f.ads.length} ads deduction(s)` : ''}`;
  };
  list.replaceChildren(...state.files.map((f) => h('li', {},
    h('div', {},
      h('div', {}, f.name),
      f.error ? h('div', { class: 'err' }, f.error)
        : h('div', { class: 'kind' }, `${kindText(f)}${f.supplierId ? ` · store ${f.supplierId}` : ''}`)),
    h('button', { type: 'button', class: 'x', 'aria-label': `Remove ${f.name}`, onclick: () => { state.files = state.files.filter((x) => x !== f); refresh(); } }, '×'))));
  $('pay-clear').hidden = state.files.length === 0;
  const has = (k) => state.files.some((f) => f.kind === k);
  const need = [];
  if (state.files.length && !has('orders')) need.push('the Orders export (CSV)');
  if (state.files.length && !has('payments')) need.push('payment files (xlsx) for the month and the next month');
  if (need.length) list.append(h('li', { class: 'muted' }, `Still needed: ${need.join(' and ')}`));
}

// ---------- costs ----------
function renderCosts(r) {
  const id = currentStoreId();
  const store = storeRec(id);
  const sig = `${id}|${r.skus.map((s) => s.sku).join('|')}`;
  // Rebuild inputs only when the store or product list changes, so typing keeps focus.
  if (sig !== state.costSig) {
    state.costSig = sig;
    const groups = [...new Set(r.skus.map((s) => s.family))];
    const groupBoxes = groups.map((g) => {
      const n = r.skus.filter((s) => s.family === g).length;
      const inp = h('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: 'Rs', 'aria-label': `Cost for all ${g}` });
      return h('div', { class: 'group-fill' }, h('span', {}, `${g} (${n})`), inp,
        h('button', { type: 'button', class: 'secondary', onclick: () => {
          const v = Number(inp.value);
          if (inp.value === '' || !Number.isFinite(v) || v < 0) return;
          for (const s of r.skus) if (s.family === g) store.costs[s.sku] = v;
          saveStores();
          state.costSig = null;
          refresh();
        } }, 'Apply to all'));
    });
    $('pay-costs').replaceChildren(
      h('div', { class: 'grid' },
        field('Store name (for your reference)', h('input', { type: 'text', value: store.name, maxlength: '40', placeholder: id ? `Store ${id}` : 'Store',
          oninput: (e) => { store.name = e.target.value; saveStores(); } })),
        field('Packaging + handling per parcel shipped (Rs)', h('input', { type: 'number', min: '0', step: '0.5', value: String(store.packaging),
          oninput: (e) => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v) && v >= 0) { store.packaging = v; saveStores(); refreshResultsOnly(); } } }))),
      groups.length > 1 ? h('div', {}, h('p', { class: 'muted small' }, 'Same cost for a whole group (you can still change single products below):'), h('div', { class: 'groups' }, groupBoxes)) : null,
      table(['SKU', 'Product', 'Group', N('Orders'), N('Sold'), N('Cost per piece Rs')],
        r.skus.map((s) => h('tr', { class: s.needsCost && (store.costs[s.sku] === undefined || store.costs[s.sku] === '') ? 'needs' : null },
          h('td', {}, s.sku), h('td', { class: 'muted small wrap' }, s.product), h('td', {}, s.family), numCell(s.orders), numCell(s.kept),
          h('td', { class: 'n' }, h('input', {
            type: 'number', min: '0', step: '0.01', inputmode: 'decimal', class: 'num', value: store.costs[s.sku] ?? '', placeholder: s.needsCost ? 'needed' : 'Rs',
            'aria-label': `Cost per piece for ${s.sku}`,
            oninput: (e) => {
              const v = e.target.value;
              if (v === '') delete store.costs[s.sku];
              else if (Number.isFinite(Number(v)) && Number(v) >= 0) store.costs[s.sku] = Number(v);
              saveStores();
              e.target.closest('tr').classList.toggle('needs', s.needsCost && v === '');
              refreshResultsOnly();
            },
          }))))),
      h('p', { class: 'muted small note' }, `Costs are remembered in this browser for ${id ? `store ${id}` : 'this store'}, so next month only new products need a cost. Raw material cost only; packaging is added per parcel.`),
    );
  }
  const missing = r.missingCosts.length;
  $('pay-costs-status').textContent = missing ? `Cost needed for ${missing} product(s) that sold, to show profit.` : 'All costs filled.';
  $('pay-costs-status').className = missing ? 'warn-text' : 'good-text';
}

function refreshResultsOnly() {
  let r;
  try { r = compute(); } catch (e) { console.error(e); return; }
  state.result = r;
  $('pay-checks').replaceChildren(...checksList(r.issues));
  const missing = r.missingCosts.length;
  $('pay-costs-status').textContent = missing ? `Cost needed for ${missing} product(s) that sold, to show profit.` : 'All costs filled.';
  $('pay-costs-status').className = missing ? 'warn-text' : 'good-text';
  renderSummary(r);
  renderDetails(r);
}

// ---------- summary ----------
function renderSummary(r) {
  const k = r.kpi.ALL;
  const store = storeRec(currentStoreId());
  $('pay-tiles').replaceChildren(
    tile('Orders placed', String(k.orders)),
    tile('Real sales (kept)', `${k.kept} (${pctText(k.successRate)})`),
    tile('Money from Meesho', `₹${fmtINR(k.money)}`, k.pending ? `incl. ₹${fmtINR(k.pending)} still to come` : ''),
    tile('Profit', r.profitReady ? `₹${fmtINR(k.profit)}` : 'Enter costs', r.profitReady ? `${pctText(k.margin)} margin` : ''),
    tile('Store', store.name || r.supplierId || '–', r.isGst ? 'GST store' : 'non-GST store'),
  );
  const cols = [...r.months, 'ALL'];
  const row = (label, key, fmt = 'n') => h('tr', {}, h('td', { class: label.startsWith('  ') ? 'indent' : null }, label.trim()), cols.map((m) => {
    const v = r.kpi[m][key];
    if (fmt === 'money') return moneyCell(v);
    if (fmt === 'pct') return h('td', { class: 'n' }, pctText(v));
    return numCell(v);
  }));
  const head = ['', ...cols.map((m) => N(monthLabel(m)))];
  const blocks = [
    h('h3', { class: 'h3' }, 'By order month'),
    table(head, [
      row('Orders placed', 'orders'), row('Cancelled', 'cancelled'), row('RTO (came back undelivered)', 'rto'), row('Delivered', 'delivered'),
      row('Customer returns', 'returns'), row('Kept by customer (real sales)', 'kept'), row('Success rate (kept / orders)', 'successRate', 'pct'),
      row('RTO rate (of shipped)', 'rtoRate', 'pct'), row('Return rate (of delivered)', 'returnRate', 'pct'),
      row('Money received from Meesho', 'received', 'money'), row('  of which return shipping charged', 'returnCharges', 'money'),
      row('  of which claims paid back', 'claims', 'money'), row('Still to receive (estimate)', 'pending', 'money'),
    ]),
  ];
  if (r.profitReady) {
    const prow = [row('Money from Meesho', 'money', 'money')];
    if (r.isGst) prow.push(row('− GST inside these sales (you pay it)', 'gst', 'money'), row("+ TCS credit back (counts against GST)", 'tcs', 'money'));
    if (r.ads.length) prow.push(row('− Ads cost', 'ads', 'money'));
    prow.push(row('− Product cost', 'product', 'money'), row(`− Packaging (₹${fmtINR(r.packaging)} per parcel)`, 'packing', 'money'));
    const profitRow = row('Profit', 'profit', 'money');
    profitRow.classList.add('strong');
    prow.push(profitRow, row('Profit per order placed', 'profitPerOrder', 'money'), row('Margin (of money from Meesho)', 'margin', 'pct'));
    blocks.push(h('h3', { class: 'h3' }, 'Profit by order month'), table(head, prow));
    if (r.isGst) blocks.push(h('p', { class: 'muted small note' }, 'GST store: the money Meesho pays includes GST you collected; it is taken off. Meesho\'s 0.5% TCS comes back as a GST credit, so it is added back. TDS (0.1%) stays as a cost; claim it in your income tax return.'));
  } else {
    blocks.push(h('p', { class: 'warn-text' }, `Profit appears when every product that sold has a cost (step 2). Missing: ${r.missingCosts.join(', ')}.`));
  }
  const cashRows = r.cash.map((c) => h('tr', {}, h('td', {}, `Paid in ${monthLabel(c.month)}${c.month === r.end.slice(0, 7) ? ` (up to ${r.end})` : ''}`), moneyCell(c.amount)));
  cashRows.push(h('tr', { class: 'total' }, h('td', {}, 'Total paid by Meesho'), moneyCell(r.totals.cash)));
  cashRows.push(h('tr', {}, h('td', { class: 'muted' }, '  for the orders above'), moneyCell(r.totals.forOrders)));
  if (r.totals.later) cashRows.push(h('tr', {}, h('td', { class: 'muted' }, `  for ${r.orphans.length} later order line(s), not in this Orders export`), moneyCell(r.totals.later)));
  if (r.ads.length) cashRows.push(h('tr', {}, h('td', { class: 'muted' }, '  ads cost deducted'), moneyCell(r.totals.ads)));
  blocks.push(h('h3', { class: 'h3' }, 'Cash received (by payment date)'), table(['', N('Rs')], cashRows));
  $('pay-summary').replaceChildren(...blocks);
}

// ---------- details ----------
const TABS = [
  { id: 'orders', label: 'Orders' },
  { id: 'bank', label: 'Bank transfers' },
  { id: 'products', label: 'Products' },
];

function renderDetails(r) {
  const counts = { orders: r.recs.length, bank: r.credits.length, products: r.skus.length };
  $('pay-tabs').replaceChildren(...TABS.map((t) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(state.tab === t.id),
    onclick: () => { state.tab = t.id; renderDetails(r); },
  }, `${t.label} (${counts[t.id]})`)));
  const panel = $('pay-panel');
  if (state.tab === 'orders') {
    const actionCount = r.recs.filter((x) => x.action).length;
    const only = state.onlyAction ?? actionCount > 0;
    const rows = r.recs.filter((x) => !only || x.action);
    panel.replaceChildren(
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: only, onchange: (e) => { state.onlyAction = e.target.checked; renderDetails(r); } }),
        ` Only orders that need action (${actionCount} of ${r.recs.length}); untick to see every order`),
      table(['Order date', 'Sub order', 'SKU', 'Status', N('Received ₹'), N('Profit ₹'), 'Result', 'Action'],
        rows.map((x) => h('tr', { class: x.flag ? `row-${x.flag}` : null },
          h('td', {}, x.odate), h('td', { class: 'mono' }, x.sub), h('td', {}, x.sku), h('td', {}, x.status),
          moneyCell(x.paid + x.pending), r.profitReady ? moneyCell(x.profit) : h('td', { class: 'n muted' }, '–'),
          h('td', { class: 'wrap' }, x.result), h('td', { class: 'wrap small' }, x.action)))),
    );
  } else if (state.tab === 'bank') {
    const rows = r.credits.map((c) => h('tr', {}, h('td', {}, c.date), h('td', { class: 'mono' }, c.txn), numCell(c.count), moneyCell(c.amount)));
    for (const a of r.ads) rows.push(h('tr', {}, h('td', {}, a.date), h('td', {}, `Ads cost (campaign ${a.campaign})`), h('td', {}), moneyCell(a.total)));
    rows.push(h('tr', { class: 'total' }, h('td', { colspan: '3' }, 'Total'), moneyCell(r.totals.cash)));
    panel.replaceChildren(
      h('p', { class: 'muted small' }, 'Match each transfer with your bank statement (Meesho transfers show the transaction id). The Excel download has a column to tick.'),
      table(['Payment date', 'Transaction id', N('Orders'), N('Amount ₹')], rows),
      r.totals.noTxnLines ? h('p', { class: 'muted small note' }, `${r.totals.noTxnLines} payment line(s) have no transaction id: RTO orders settled at ₹0, so no money moved.`) : null,
    );
  } else {
    panel.replaceChildren(
      table(['SKU', 'Group', N('Orders'), N('Sold'), N('Returns'), N('RTO'), N('Received ₹'), N('Profit ₹'), N('Per piece sold ₹'), N('Break-even ₹'), N('Margin')],
        r.skus.map((s) => h('tr', { class: r.profitReady && s.profit < 0 ? 'row-bad' : null },
          h('td', {}, s.sku), h('td', {}, s.family), numCell(s.orders), numCell(s.kept), numCell(s.returns), numCell(s.rto),
          moneyCell(s.received + s.pending),
          r.profitReady ? moneyCell(s.profit) : h('td', { class: 'n muted' }, '–'),
          r.profitReady ? moneyCell(s.perKept) : h('td', { class: 'n muted' }, '–'),
          moneyCell(s.breakEven),
          h('td', { class: 'n' }, r.profitReady ? pctText(s.margin) : '–')))),
      h('p', { class: 'muted small note' }, 'Break-even = money left per piece sold (after returns, RTO and GST). If raw material plus packaging costs more than this, the product loses money. Ads are not split by product.'),
    );
  }
  $('pay-download').disabled = !r.recs.length;
}

// ---------- wire up ----------
const drop = $('pay-drop');
const input = $('pay-input');
input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
$('pay-clear').addEventListener('click', () => { state.files = []; refresh(); });
$('pay-download').addEventListener('click', () => {
  if (!state.result) return;
  const store = storeRec(currentStoreId());
  downloadReconWorkbook(state.result, { storeLabel: store.name });
});
refresh();
