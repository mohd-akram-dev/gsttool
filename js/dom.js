// Small DOM helpers. Text is always inserted as text, never as HTML.
import { fmtINR } from './money.js';

export const $ = (id) => document.getElementById(id);

export function h(tag, attrs = {}, ...children) {
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

export const N = (t) => ({ t, n: true });
export const moneyCell = (v) => h('td', { class: v < 0 ? 'n neg' : 'n' }, fmtINR(v));
export const numCell = (v) => h('td', { class: 'n' }, v);
export const pctText = (v) => (v === null || v === undefined || Number.isNaN(v) ? '–' : `${(v * 100).toFixed(0)}%`);

export function table(headers, rows, cls = '') {
  return h('div', { class: 'table-wrap' }, h('table', { class: cls || null },
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', { class: x.n ? 'n' : null }, x.t ?? x)))),
    h('tbody', {}, rows)));
}

export function field(label, content) {
  return h('label', { class: 'field' }, label, content);
}

export function tile(label, value, note = '') {
  return h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, value), note ? h('div', { class: 'label' }, note) : null);
}

const LEVEL_LABEL = { error: 'Error', warning: 'Warning', info: 'Note' };
export function checksList(issues) {
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.level] - order[b.level]);
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  const head = errors
    ? h('p', {}, `${errors} error(s) to fix.`)
    : h('p', { class: warnings ? '' : 'all-good' }, warnings ? `No errors. ${warnings} thing(s) to look at.` : 'No errors or warnings.');
  return [head, ...sorted.map((i) => h('div', { class: `check ${i.level}` },
    h('span', { class: 'lvl' }, LEVEL_LABEL[i.level]),
    i.message,
    i.details && i.details.length ? h('details', {}, h('summary', {}, `Show ${i.details.length} item(s)`), h('ul', {}, i.details.map((d) => h('li', {}, d)))) : null))];
}

// Safe localStorage access (private windows and blocked storage must not break the page).
export function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
export function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: keep in memory only */ }
}
