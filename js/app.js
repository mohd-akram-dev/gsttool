// Screen logic: reads the files, runs the engine, shows the tables, downloads the JSON.
import { readMeeshoFile, KIND, KIND_LABEL } from './readers.js';
import { buildGstr1 } from './gstr1.js';
import { toPortalJson, jsonFileName } from './json.js';
import { buildGstr3b } from './gstr3b.js';
import { validateDocRows, rangeSize } from './table13.js';
import { fmtINR } from './money.js';
import { MONTHS, UQC_OPTIONS, POS_NAMES, DOC_NATURE } from './masters.js';

const $ = (id) => document.getElementById(id);

// Tiny element builder: h('td', { class: 'n' }, '12.00'). Text is always inserted as text, never HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// ---------- settings (remembered in this browser only) ----------
const STORE_KEY = 'meesho-gst-settings-v1';
const DEFAULT_SETTINGS = { b2csType: 'OE', uqc: 'PCS', hsnDesc: {} };
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...saved, hsnDesc: { ...(saved.hsnDesc || {}) } };
  } catch {
    return { ...DEFAULT_SETTINGS, hsnDesc: {} };
  }
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.settings)); } catch { /* storage blocked: keep in memory */ }
}

// cash: Electronic Cash Ledger balance typed by the seller (month-specific, not remembered).
// t13: Table 13 rows shown in the editor. While not edited they follow the automatic rows;
// once the seller edits, their rows are kept (and used in the JSON) until "Use automatic rows".
const state = {
  files: [],
  settings: loadSettings(),
  tab: 't7',
  result: null,
  hsnSig: null,
  cash: { igst: '', cgst: '', sgst: '' },
  t13: { fp: null, edited: false, rows: [], autoSig: '', latestAutoSig: '' },
};
let nextId = 1;

// ---------- files ----------
async function addFiles(fileList) {
  for (const f of fileList) {
    if (f.name.startsWith('~$')) continue; // Excel lock files
    const entry = { id: nextId++, name: f.name, size: f.size, kind: null, rows: [], error: null };
    try {
      entry.rows = [];
      const res = readMeeshoFile(await f.arrayBuffer(), f.name);
      entry.kind = res.kind;
      entry.rows = res.rows;
    } catch (e) {
      entry.error = e.message;
    }
    state.files = state.files.filter((x) => !(x.name === entry.name && x.size === entry.size));
    // Only one sales file and one returns file at a time: a new one replaces the old.
    if (entry.kind === KIND.SALES || entry.kind === KIND.RETURNS) {
      state.files = state.files.filter((x) => x.kind !== entry.kind);
    }
    state.files.push(entry);
  }
  refresh();
}

function removeFile(id) {
  state.files = state.files.filter((f) => f.id !== id);
  refresh();
}

function compute() {
  if (!state.files.some((f) => f.kind)) return null;
  const sales = state.files.find((f) => f.kind === KIND.SALES);
  const returns = state.files.find((f) => f.kind === KIND.RETURNS);
  const docs = state.files.filter((f) => f.kind === KIND.DOCS).flatMap((f) => f.rows);
  return buildGstr1({
    sales: sales ? sales.rows : null,
    returns: returns ? returns.rows : null,
    docs,
    settings: state.settings,
  });
}

// ---------- render ----------
function refresh() {
  let r = null;
  let crash = null;
  try { r = compute(); } catch (e) { crash = e; console.error(e); }
  state.result = r;

  renderFiles();
  const ready = !!(r && r.period);
  $('details-card').hidden = !ready;
  $('result-card').hidden = !ready;
  $('checks-card').hidden = !(r || crash);
  const badge = $('gstin-badge');
  badge.hidden = !ready;
  badge.textContent = ready ? `GSTIN ${r.gstin}` : '';

  if (crash) {
    renderChecks([{ level: 'error', message: `Unexpected problem: ${crash.message}. Nothing can be downloaded; please report this.`, details: [] }]);
  } else if (r) {
    renderChecks(r.issues);
  }
  $('t13-card').hidden = !ready;
  if (ready) {
    renderDetails(r);
    renderT13(r);
    renderTiles(r);
    renderTabs(r);
    renderPanel(r);
    renderDownload(r);
  } else {
    state.hsnSig = null;
  }
  $('gstr3b-card').hidden = !(ready && r.ok);
  if (ready && r.ok) renderGstr3b(r);
}

function renderFiles() {
  const list = $('file-list');
  list.replaceChildren(...state.files.map((f) => h('li', {},
    h('div', {},
      h('div', {}, f.name),
      f.error
        ? h('div', { class: 'err' }, f.error)
        : h('div', { class: 'kind' }, `${KIND_LABEL[f.kind]} · ${f.rows.length} rows`)),
    h('button', { type: 'button', class: 'x', 'aria-label': `Remove ${f.name}`, onclick: () => removeFile(f.id) }, '×'))));
  $('clear-files').hidden = state.files.length === 0;

  const kinds = new Set(state.files.map((f) => f.kind));
  const missing = [KIND.SALES, KIND.RETURNS, KIND.DOCS].filter((k) => !kinds.has(k));
  if (state.files.length && missing.length) {
    list.append(h('li', { class: 'muted' }, `Still needed: ${missing.map((k) => KIND_LABEL[k]).join(', ')}`));
  }
}

function field(label, content) {
  return h('label', { class: 'field' }, label, content);
}

function renderDetails(r) {
  const p = r.period;
  const typeSelect = h('select', {
    onchange: (e) => { state.settings.b2csType = e.target.value; saveSettings(); refresh(); },
  },
  h('option', { value: 'OE', selected: state.settings.b2csType !== 'E' }, 'OE (as filed so far)'),
  h('option', { value: 'E', selected: state.settings.b2csType === 'E' }, 'E (with Meesho GSTIN)'));
  const uqcSelect = h('select', {
    onchange: (e) => { state.settings.uqc = e.target.value; saveSettings(); refresh(); },
  }, UQC_OPTIONS.map((u) => h('option', { value: u.code, selected: state.settings.uqc === u.code }, u.label)));

  $('details-grid').replaceChildren(
    field('Return period', h('span', { class: 'value' }, `${MONTHS[p.month - 1]} ${p.year}`), ),
    field('Financial year', h('span', { class: 'value' }, p.fyLabel)),
    field('GSTIN (from the files)', h('span', { class: 'value' }, r.gstin)),
    field('Your state', h('span', { class: 'value' }, `${r.home}-${POS_NAMES[r.home] ?? ''}`)),
    field('Table 7 type', typeSelect),
    field('Unit (UQC) for Table 12', uqcSelect),
  );

  // HSN descriptions: rebuilt only when the HSN list changes, so typing keeps focus.
  const sig = r.hsn.map((x) => x.hsn).join('|');
  if (sig === state.hsnSig) return;
  state.hsnSig = sig;
  $('hsn-desc').replaceChildren(
    h('p', { class: 'muted small' }, 'Description for each HSN in Table 12 (up to 30 characters). Filled from your product names; edit if you like.'),
    h('div', { class: 'grid' }, r.hsn.map((x) => field(`HSN ${x.hsn}`, h('input', {
      type: 'text',
      maxlength: '30',
      value: x.desc,
      oninput: (e) => {
        state.settings.hsnDesc[x.hsn] = e.target.value;
        saveSettings();
        refresh();
      },
    })))),
  );
}

const LEVEL_LABEL = { error: 'Error', warning: 'Warning', info: 'Note' };
function renderChecks(issues) {
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.level] - order[b.level]);
  const box = $('checks');
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  const head = errors
    ? h('p', {}, `${errors} error(s) must be fixed before you can download.`)
    : h('p', { class: warnings ? '' : 'all-good' }, warnings ? `No errors. Read the ${warnings} warning(s) before uploading.` : 'No errors or warnings.');
  box.replaceChildren(head, ...sorted.map((i) => h('div', { class: `check ${i.level}` },
    h('span', { class: 'lvl' }, LEVEL_LABEL[i.level]),
    i.message,
    i.details.length ? h('details', {}, h('summary', {}, `Show ${i.details.length} item(s)`), h('ul', {}, i.details.map((d) => h('li', {}, d)))) : null)));
}

function tile(label, value) {
  return h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, value));
}

function renderTiles(r) {
  const { t7 } = r.totals;
  const natures = t13Check().natures;
  const docsCount = (num) => natures.find((n) => n.docNum === num)?.rows.reduce((a, d) => a + d.totnum, 0) ?? 0;
  $('tiles').replaceChildren(
    tile('Net taxable value', `₹${fmtINR(t7.txval)}`),
    tile('IGST', `₹${fmtINR(t7.iamt)}`),
    tile('CGST', `₹${fmtINR(t7.camt)}`),
    tile('SGST', `₹${fmtINR(t7.samt)}`),
    tile('Invoices / credit notes', `${docsCount(1)} / ${docsCount(5)}`),
  );
}

function tabDefs(r) {
  return [
    { id: 't7', label: `Table 7 · B2C Others (${r.b2cs.length})` },
    { id: 't12', label: `Table 12 · HSN (${r.hsn.length})` },
    { id: 't14', label: `Table 14 · E-commerce (${r.eco ? 1 : 0})` },
    { id: 'json', label: 'JSON' },
  ];
}

function renderTabs(r) {
  $('tabs').replaceChildren(...tabDefs(r).map((t) => h('button', {
    type: 'button',
    role: 'tab',
    'aria-selected': String(state.tab === t.id),
    onclick: () => { state.tab = t.id; renderTabs(r); renderPanel(r); },
  }, t.label)));
}

const money = (v) => h('td', { class: v < 0 ? 'n neg' : 'n' }, fmtINR(v));
const totalRow = (label, span, values) => h('tr', { class: 'total' }, h('td', { colspan: String(span) }, label), values.map(money));
function table(headers, rows) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', { class: x.n ? 'n' : null }, x.t ?? x)))),
    h('tbody', {}, rows)));
}
const N = (t) => ({ t, n: true });

function renderPanel(r) {
  const panel = $('tab-panel');
  const { t7, t12 } = r.totals;
  if (state.tab === 't7') {
    panel.replaceChildren(table(
      ['Place of supply', 'Type', N('Rate %'), N('Taxable ₹'), N('IGST ₹'), N('CGST ₹'), N('SGST ₹')],
      [...r.b2cs.map((x) => h('tr', {},
        h('td', {}, `${x.pos}-${x.posName}`), h('td', {}, x.sply_ty === 'INTER' ? 'Inter-state' : 'Intra-state'),
        h('td', { class: 'n' }, x.rate), money(x.txval), money(x.iamt), money(x.camt), money(x.samt))),
      totalRow(`Total (${t7.rows} rows)`, 3, [t7.txval, t7.iamt, t7.camt, t7.samt])]));
  } else if (state.tab === 't12') {
    panel.replaceChildren(table(
      ['HSN', 'Description', 'UQC', N('Qty'), N('Rate %'), N('Taxable ₹'), N('IGST ₹'), N('CGST ₹'), N('SGST ₹')],
      [...r.hsn.map((x) => h('tr', {},
        h('td', {}, x.hsn), h('td', {}, x.desc), h('td', {}, x.uqc), h('td', { class: x.qty < 0 ? 'n neg' : 'n' }, x.qty),
        h('td', { class: 'n' }, x.rate), money(x.txval), money(x.iamt), money(x.camt), money(x.samt))),
      h('tr', { class: 'total' }, h('td', { colspan: '3' }, 'Total'), h('td', { class: 'n' }, t12.qty), h('td', {}),
        money(t12.txval), money(t12.iamt), money(t12.camt), money(t12.samt))]),
    h('p', { class: 'muted small note' }, 'Each HSN row is rounded on its own, so these totals can differ from Table 7 by a few paise. That is normal.'));
  } else if (state.tab === 't14') {
    panel.replaceChildren(r.eco
      ? table(['Nature of supply', 'E-commerce GSTIN', N('Net value ₹'), N('IGST ₹'), N('CGST ₹'), N('SGST ₹')],
        [h('tr', {}, h('td', {}, 'Liable to collect tax u/s 52 (TCS)'), h('td', {}, r.eco.etin),
          money(r.eco.suppval), money(r.eco.igst), money(r.eco.cgst), money(r.eco.sgst))])
      : h('p', { class: 'muted' }, 'No e-commerce GSTIN found in the files.'));
  } else {
    const v = t13Check();
    let text;
    if (v.errors.length) text = 'Fix the Table 13 errors in step 4 first.';
    else {
      try { text = JSON.stringify(toPortalJson(r, { docNatures: v.natures }), null, 2); } catch (e) { text = e.message; }
    }
    panel.replaceChildren(h('pre', { class: 'json' }, text));
  }
}

// ---------- Table 13 editor ----------
let rowSeq = 1;
const KIND_TEXT = { typed: 'added by you' };

function autoT13Rows(r) {
  return r.docs.natures.flatMap((n) => n.rows.map((d) => ({
    id: rowSeq++, docNum: n.docNum, from: d.from, to: d.to,
    totnum: String(d.totnum), cancel: String(d.cancel), kind: d.kind, totalTyped: false,
  })));
}
const rowsSig = (rows) => JSON.stringify(rows.map((x) => [x.docNum, x.from, x.to, String(x.totnum), String(x.cancel)]));

// The checked Table 13 rows: what goes into the JSON.
function t13Check() {
  return validateDocRows(state.t13.rows, state.result?.docs?.prefix ?? null);
}

function renderT13(r) {
  const t = state.t13;
  const auto = autoT13Rows(r);
  const sig = rowsSig(auto);
  t.latestAutoSig = sig;
  let rebuild = false;
  if (t.fp !== r.period.fp) {
    Object.assign(t, { fp: r.period.fp, edited: false, rows: auto, autoSig: sig });
    rebuild = true;
  } else if (!t.edited && sig !== t.autoSig) {
    t.rows = auto;
    t.autoSig = sig;
    rebuild = true;
  }
  if (rebuild || $('t13-body').children.length !== t.rows.length) buildT13Table();
  updateT13Status();
}

function buildT13Table() {
  $('t13-body').replaceChildren(...state.t13.rows.map(t13Row));
}

function t13Row(row) {
  const prefix = () => state.result?.docs?.prefix ?? null;
  const input = (key, label, extra = {}) => h('input', {
    type: 'text',
    value: row[key],
    'aria-label': label,
    ...extra,
    oninput: (e) => {
      row[key] = e.target.value;
      if (key === 'totnum') row.totalTyped = true;
      markT13Edited();
    },
  });
  const nature = h('select', {
    'aria-label': 'Nature of document',
    onchange: (e) => { row.docNum = Number(e.target.value); markT13Edited(); },
  }, Object.entries(DOC_NATURE).map(([num, label]) => h('option', { value: num, selected: Number(num) === row.docNum }, label)));
  const from = input('from', 'Sr. No. from', { maxlength: '16', spellcheck: 'false' });
  const to = input('to', 'Sr. No. to', { maxlength: '16', spellcheck: 'false' });
  const total = input('totnum', 'Total number', { class: 'num', inputmode: 'numeric' });
  const cancel = input('cancel', 'Cancelled', { class: 'num', inputmode: 'numeric' });
  // After From or To changes, fill Total from the range (unless Total was typed by hand).
  const fillTotal = () => {
    if (row.totalTyped) return;
    const size = rangeSize(row.from, row.to, prefix());
    if (size !== null && String(size) !== row.totnum) {
      row.totnum = String(size);
      total.value = row.totnum;
      markT13Edited();
    }
  };
  from.addEventListener('change', fillTotal);
  to.addEventListener('change', fillTotal);
  const remove = h('button', {
    type: 'button', class: 'x', 'aria-label': 'Remove this row',
    onclick: () => {
      state.t13.rows = state.t13.rows.filter((x) => x !== row);
      state.t13.edited = true;
      buildT13Table();
      afterT13Change();
    },
  }, '×');
  return h('tr', { 'data-id': String(row.id) },
    h('td', {}, nature), h('td', {}, from), h('td', {}, to), h('td', {}, total), h('td', {}, cancel),
    h('td', { class: 'n', 'data-net': '' }), h('td', { class: 'muted small' }, KIND_TEXT[row.kind] ?? row.kind), h('td', {}, remove));
}

function addT13Row() {
  const row = { id: rowSeq++, docNum: 5, from: '', to: '', totnum: '', cancel: '0', kind: 'typed', totalTyped: false };
  state.t13.rows.push(row);
  state.t13.edited = true;
  buildT13Table();
  afterT13Change();
  $('t13-body').lastElementChild?.querySelector('input')?.focus();
}

function resetT13() {
  const r = state.result;
  if (!r || !r.period) return;
  state.t13.rows = autoT13Rows(r);
  state.t13.autoSig = rowsSig(state.t13.rows);
  state.t13.edited = false;
  buildT13Table();
  afterT13Change();
}

function markT13Edited() {
  state.t13.edited = true;
  afterT13Change();
}

function afterT13Change() {
  updateT13Status();
  const r = state.result;
  if (!r || !r.period) return;
  renderTiles(r);
  if (state.tab === 'json') renderPanel(r);
  renderDownload(r);
}

function updateT13Status() {
  const t = state.t13;
  const v = t13Check();
  for (const tr of $('t13-body').children) {
    const row = t.rows.find((x) => String(x.id) === tr.dataset.id);
    const tot = String(row?.totnum ?? '').trim();
    const can = String(row?.cancel ?? '').trim() || '0';
    tr.querySelector('[data-net]').textContent = /^\d+$/.test(tot) && /^\d+$/.test(can) ? String(Number(tot) - Number(can)) : '–';
  }
  const count = (num) => v.natures.find((n) => n.docNum === num)?.rows.reduce((a, d) => a + d.totnum - d.cancel, 0) ?? 0;
  const parts = [h('p', { class: 'small' }, `Net issued: ${count(1)} invoice(s), ${count(5)} credit note(s).`)];
  if (!t.rows.length) parts.push(h('p', { class: 'muted' }, 'No rows yet. Add Tax_invoice_details.xlsx in step 1, or add rows by hand.'));
  if (t.edited) {
    parts.push(h('div', { class: 'check info' }, h('span', { class: 'lvl' }, 'Note'),
      t.latestAutoSig !== t.autoSig
        ? 'The automatic rows changed (for example, a file was added) after you edited this table. Your rows are still used. '
        : 'You edited this table; your rows are used in the JSON. ',
      h('button', { type: 'button', class: 'link', onclick: resetT13 }, 'Use automatic rows')));
  }
  for (const e of v.errors) parts.push(h('div', { class: 'check error' }, h('span', { class: 'lvl' }, 'Error'), e));
  for (const w of v.warnings) parts.push(h('div', { class: 'check warning' }, h('span', { class: 'lvl' }, 'Warning'), w));
  $('t13-status').replaceChildren(...parts);
}

// ---------- GSTR-3B ----------
const HEAD_LABEL = { igst: 'IGST', cgst: 'CGST', sgst: 'SGST' };

function renderGstr3b(r) {
  const g = buildGstr3b(r, state.cash);
  const t = g.t31a;
  $('gstr3b-tables').replaceChildren(
    h('h3', { class: 'h3' }, 'Table 3.1: outward supplies'),
    table(['', N('Taxable ₹'), N('IGST ₹'), N('CGST ₹'), N('SGST ₹'), N('Cess ₹')], [
      h('tr', {}, h('td', {}, '(a) Outward taxable supplies'), money(t.txval), money(t.iamt), money(t.camt), money(t.samt), money(0)),
      h('tr', {}, h('td', { class: 'muted' }, '(b) to (e) and 3.1.1'), h('td', { class: 'n muted', colspan: '5' }, 'all 0')),
    ]),
    h('details', { class: 'more' },
      h('summary', {}, `Table 3.2: inter-state supplies to unregistered persons (${g.t32.length} states)`),
      table(['Place of supply', N('Taxable ₹'), N('IGST ₹')], [
        ...g.t32.map((x) => h('tr', {}, h('td', {}, `${x.pos}-${x.posName}`), money(x.txval), money(x.iamt))),
        totalRow('Total', 1, [g.t32tot.txval, g.t32tot.iamt]),
      ])),
    ...g.notes.map((n) => h('div', { class: 'check warning note' }, h('span', { class: 'lvl' }, 'Warning'), n)),
    h('p', { class: 'muted small note' },
      `Meesho's TCS for this month should be about IGST ₹${fmtINR(g.tcsEstimate.igst)}, CGST ₹${fmtINR(g.tcsEstimate.cgst)}, SGST ₹${fmtINR(g.tcsEstimate.sgst)} `
      + `(${fmtINR(g.totals.tcsEstimate)} in all, 0.5% of net sales). Compare it in "TDS and TCS credit received" before accepting. `
      + 'It can appear a few days after the 10th.'),
  );

  // Cash inputs are built once per month so typing keeps focus.
  const box = $('gstr3b-cash');
  if (box.dataset.fp !== r.period.fp) {
    box.dataset.fp = r.period.fp;
    box.replaceChildren(...['igst', 'cgst', 'sgst'].map((head) => field(`${HEAD_LABEL[head]} balance ₹`, h('input', {
      type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: state.cash[head], placeholder: '0',
      oninput: (e) => {
        state.cash[head] = e.target.value;
        // Always use the latest result: files may have changed since these inputs were built.
        if (state.result && state.result.ok) renderPay(buildGstr3b(state.result, state.cash));
      },
    }))));
  }
  renderPay(g);
}

function renderPay(g) {
  const heads = ['igst', 'cgst', 'sgst'];
  $('gstr3b-pay').replaceChildren(
    table(['', N('Tax payable ₹'), N('From cash ledger ₹'), N('To deposit ₹'), N('Challan ₹')], [
      ...heads.map((x) => h('tr', {}, h('td', {}, HEAD_LABEL[x]), money(g.payable[x]), money(g.fromLedger[x]), money(g.deposit[x]),
        h('td', { class: 'n' }, g.challan[x]))),
      h('tr', { class: 'total' }, h('td', {}, 'Total'), money(g.totals.payable), money(g.totals.fromLedger), money(g.totals.deposit),
        h('td', { class: 'n' }, g.totals.challan)),
    ]),
    h('p', { class: 'muted small note' }, g.totals.deposit > 0
      ? 'Create a challan on the portal for the shortfall (whole rupees, rounded up; the portal shows its own figure). Any extra stays in your cash ledger for next month.'
      : 'Your cash ledger covers the tax. No challan needed.'),
  );
}

function renderDownload(r) {
  const btn = $('download');
  const v = t13Check();
  btn.disabled = !r.ok || v.errors.length > 0;
  const warnings = r.issues.filter((i) => i.level === 'warning').length + v.warnings.length;
  $('download-note').textContent = !r.ok
    ? 'Fix the errors in step 3 first.'
    : v.errors.length ? 'Fix Table 13 in step 4 first.'
      : warnings ? `${jsonFileName(r)} · read the ${warnings} warning(s) first` : jsonFileName(r);
}

function download() {
  const r = state.result;
  const v = t13Check();
  if (!r || !r.ok || v.errors.length) return;
  const blob = new Blob([JSON.stringify(toPortalJson(r, { docNatures: v.natures }))], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: jsonFileName(r) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- wire up ----------
const drop = $('drop');
const input = $('file-input');
input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
$('clear-files').addEventListener('click', () => { state.files = []; refresh(); });
$('download').addEventListener('click', download);
$('t13-add').addEventListener('click', addT13Row);
refresh();
