// Test runner (Node 18+). Runs the same modules the browser uses.
//
//   node tests/run.mjs                                   unit tests only
//   node tests/run.mjs --expected <file.json> [--offline <offline.json>] [--out <file.json>] <xlsx files...>
//
// --expected  full GSTR-1 JSON the output must match exactly (except user_desc)
// --offline   a JSON exported by the GST Offline Tool; its b2cs must match ours exactly
// Real data never goes in the repo: keep expected files in tests/private/ (git-ignored).
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { round2, sum2 } from '../js/money.js';
import { stateToPos } from '../js/masters.js';
import { readMeeshoFile, KIND } from '../js/readers.js';
import { buildGstr1 } from '../js/gstr1.js';
import { toPortalJson } from '../js/json.js';
import { buildGstr3b } from '../js/gstr3b.js';
import { rangeSize, validateDocRows } from '../js/table13.js';

let failures = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; return; }
  failures++;
  console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- unit tests ----------
check('round2 1.005', round2(1.005) === 1.01, round2(1.005));
check('round2 -1.005', round2(-1.005) === -1.01, round2(-1.005));
check('round2 2.675', round2(2.675) === 2.68, round2(2.675));
check('round2 0.125', round2(0.125) === 0.13);
check('round2 1.004999', round2(1.004999) === 1);
check('round2 -0.001 is 0 not -0', Object.is(round2(-0.001), 0));
check('round2 14.855534', round2(495.184466 * 3 / 100) === 14.86);
check('sum2 float noise', sum2([0.1, 0.2]) === 0.3);
check('state JAMMU & KASHMIR', stateToPos('JAMMU & KASHMIR') === '01');
check('state Kerala', stateToPos('Kerala') === '32');
check('state ORISSA', stateToPos('ORISSA') === '21');
check('state unknown', stateToPos('ATLANTIS') === null);

// Table 13 editor (made-up numbers: seller code "abcde", FY "27")
const P = 'abcde27';
check('range invoices across 2-3 digit serials', rangeSize('abcde2742', 'abcde27120', P) === 79, rangeSize('abcde2742', 'abcde27120', P));
check('range credit notes', rangeSize('abcde27C16', 'abcde27C31', P) === 16);
check('range across series is unknown', rangeSize('abcde27C16', 'abcde27CC3', P) === null);
check('range To before From is unknown', rangeSize('abcde27C31', 'abcde27C16', P) === null);
check('range generic same width', rangeSize('INV001', 'INV100') === 100);
check('range generic ambiguous width', rangeSize('INV9', 'INV10') === null);
{
  const ok = validateDocRows([
    { docNum: 1, from: 'abcde2742', to: 'abcde27120', totnum: '79', cancel: '0' },
    { docNum: 5, from: 'abcde27C16', to: 'abcde27C31', totnum: 16, cancel: '' },
    { docNum: 5, from: '', to: '', totnum: '', cancel: '' }, // empty row ignored
  ], P);
  check('t13 valid rows: no errors', ok.errors.length === 0 && ok.warnings.length === 0, JSON.stringify(ok));
  check('t13 valid rows: grouped by nature', same(ok.natures.map((n) => [n.docNum, n.rows.length]), [[1, 1], [5, 1]]));
  check('t13 empty Cancelled = 0', ok.natures[1].rows[0].cancel === 0);
  const bad = validateDocRows([
    { docNum: 5, from: 'abcde27C31', to: 'abcde27C16', totnum: '16', cancel: '0' },
    { docNum: 1, from: 'abcde2742', to: '', totnum: '5', cancel: '0' },
    { docNum: 1, from: 'abcde2750', to: 'abcde2760', totnum: '3', cancel: '4' },
    { docNum: 1, from: 'abcde2770', to: 'abcde2771', totnum: 'x', cancel: '0' },
  ], P);
  check('t13 To before From is an error', bad.errors.some((e) => e.startsWith('Row 1') && e.includes('comes before')));
  check('t13 missing To is an error', bad.errors.some((e) => e.startsWith('Row 2') && e.includes('both')));
  check('t13 Cancelled > Total is an error', bad.errors.some((e) => e.startsWith('Row 3') && e.includes('Cancelled')));
  check('t13 non-number Total is an error', bad.errors.some((e) => e.startsWith('Row 4') && e.includes('Total')));
  const warn = validateDocRows([
    { docNum: 1, from: 'abcde2742', to: 'abcde2750', totnum: '5', cancel: '0' },
    { docNum: 1, from: 'abcde2748', to: 'abcde2755', totnum: '8', cancel: '0' },
  ], P);
  check('t13 Total not matching range warns', warn.warnings.some((w) => w.startsWith('Row 1') && w.includes('covers 9')));
  check('t13 overlapping ranges warn', warn.warnings.some((w) => w.includes('overlap')));
  check('t13 warnings do not block', warn.errors.length === 0);
}

// ---------- golden test on real files ----------
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const expectedPath = opt('--expected');
const offlinePath = opt('--offline');
const outPath = opt('--out');
const files = args;

if (files.length) {
  const input = { sales: null, returns: null, docs: [], settings: { b2csType: 'OE', uqc: 'PCS' } };
  for (const f of files) {
    if (basename(f).startsWith('~$')) continue;
    try {
      const res = readMeeshoFile(readFileSync(f), basename(f));
      if (res.kind === KIND.SALES) input.sales = res.rows;
      else if (res.kind === KIND.RETURNS) input.returns = res.rows;
      else input.docs.push(...res.rows);
      console.log(`read ${basename(f)}: ${res.kind}, ${res.rows.length} rows`);
    } catch (e) {
      console.log(`skip ${basename(f)}: ${e.message}`);
    }
  }
  const r = buildGstr1(input);
  console.log(`\nperiod ${r.period?.fp}  gstin ${r.gstin}  ok=${r.ok}`);
  for (const i of r.issues) {
    console.log(`  [${i.level}] ${i.message}`);
    for (const d of i.details.slice(0, 12)) console.log(`        ${d}`);
  }
  if (r.totals) {
    const { t7, t12 } = r.totals;
    console.log(`\nTable 7 : ${t7.rows} rows, taxable ${t7.txval}, IGST ${t7.iamt}, CGST ${t7.camt}, SGST ${t7.samt}`);
    console.log(`Table 12: ${t12.rows} rows, qty ${t12.qty}, taxable ${t12.txval}, IGST ${t12.iamt}, CGST ${t12.camt}, SGST ${t12.samt}`);
    for (const n of r.docs.natures) for (const d of n.rows) console.log(`Table 13: ${n.label}: ${d.from} .. ${d.to} total ${d.totnum} (${d.kind})`);
    if (r.eco) console.log(`Table 14: ${r.eco.etin} ${r.eco.suppval} IGST ${r.eco.igst} CGST ${r.eco.cgst} SGST ${r.eco.sgst}`);
  }
  if (r.ok) {
    const json = toPortalJson(r);
    if (outPath) { writeFileSync(outPath, JSON.stringify(json)); console.log(`\nwrote ${outPath}`); }

    if (offlinePath) {
      const off = JSON.parse(readFileSync(offlinePath, 'utf8'));
      const key = (x) => `${x.pos}|${x.rt}`;
      const ours = new Map(json.b2cs.map((x) => [key(x), x]));
      check('b2cs row count = Offline Tool', off.b2cs.length === json.b2cs.length, `${json.b2cs.length} vs ${off.b2cs.length}`);
      for (const x of off.b2cs) {
        const y = ours.get(key(x));
        const norm = (o) => o && Object.fromEntries(Object.entries(o).sort());
        check(`b2cs ${key(x)} = Offline Tool`, same(norm(x), norm(y)), `offline ${JSON.stringify(x)}\n     ours    ${JSON.stringify(y)}`);
      }
      check('gstin/fp = Offline Tool', off.gstin === json.gstin && off.fp === json.fp);
    }
    // ---- Table 13 editor round trip: unedited automatic rows must give the same JSON ----
    const autoRows = r.docs.natures.flatMap((n) => n.rows.map((d) => ({ docNum: n.docNum, from: d.from, to: d.to, totnum: String(d.totnum), cancel: String(d.cancel) })));
    const v13 = validateDocRows(autoRows, r.docs.prefix);
    check('t13 automatic rows pass the editor checks', v13.errors.length === 0, v13.errors.join('; '));
    check('t13 automatic rows: no editor warnings', v13.warnings.length === 0, v13.warnings.join('; '));
    check('t13 editor JSON = engine JSON', same(toPortalJson(r, { docNatures: v13.natures }), json));

    // ---- GSTR-3B: invariants, then the independent expectation if given ----
    const g = buildGstr3b(r, {});
    const { t7 } = r.totals;
    console.log(`\nGSTR-3B 3.1(a): ${g.t31a.txval} IGST ${g.t31a.iamt} CGST ${g.t31a.camt} SGST ${g.t31a.samt}`);
    console.log(`GSTR-3B 3.2  : ${g.t32.length} states, ${g.t32tot.txval} IGST ${g.t32tot.iamt}`);
    console.log(`TCS estimate : IGST ${g.tcsEstimate.igst} CGST ${g.tcsEstimate.cgst} SGST ${g.tcsEstimate.sgst}`);
    console.log(`Deposit (no ledger balance): ${g.deposit.igst} / ${g.deposit.cgst} / ${g.deposit.sgst}, challan ${g.challan.igst} / ${g.challan.cgst} / ${g.challan.sgst}`);
    check('3B 3.1(a) = Table 7 totals', same([g.t31a.txval, g.t31a.iamt, g.t31a.camt, g.t31a.samt], [t7.txval, t7.iamt, t7.camt, t7.samt]));
    check('3B 3.2 + intra-state = 3.1(a) taxable', sum2([g.t32tot.txval, g.intraValue]) === g.t31a.txval);
    check('3B 3.2 IGST = 3.1(a) IGST', g.t32tot.iamt === g.t31a.iamt);
    check('3B no balance: deposit = payable', same(g.deposit, g.payable));
    check('3B challan = deposit rounded up', ['igst', 'cgst', 'sgst'].every((h) => g.challan[h] === Math.ceil(g.deposit[h] - 1e-9) && g.challan[h] >= g.deposit[h]));
    const withCash = buildGstr3b(r, { igst: 49.89, cgst: 5.88, sgst: 100 });
    check('3B ledger balance reduces deposit', withCash.deposit.igst === round2(g.payable.igst - 49.89) && withCash.deposit.cgst === round2(g.payable.cgst - 5.88));
    check('3B ledger balance above tax leaves 0 to deposit', withCash.deposit.sgst === 0 && withCash.fromLedger.sgst === g.payable.sgst);

    if (expectedPath) {
      const exp = JSON.parse(readFileSync(expectedPath, 'utf8'));
      const strip = (j) => {
        const o = Object.fromEntries(Object.entries(j).filter(([k]) => !k.startsWith('_')));
        if (o.hsn) o.hsn = { hsn_b2c: o.hsn.hsn_b2c.map(({ user_desc, ...rest }) => rest) };
        return o;
      };
      const a = strip(json);
      const b = strip(exp);
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        check(`section ${k} = expected`, same(a[k], b[k]), `expected ${JSON.stringify(b[k])}\n     ours     ${JSON.stringify(a[k])}`);
      }
      const e3 = exp._gstr3b;
      if (e3) {
        check('3B 3.1(a) = independent', same([g.t31a.txval, g.t31a.iamt, g.t31a.camt, g.t31a.samt], e3.t31a));
        check('3B 3.2 row count = independent', g.t32.length === e3.t32_rows, `${g.t32.length} vs ${e3.t32_rows}`);
        check('3B 3.2 totals = independent', same([g.t32tot.txval, g.t32tot.iamt], e3.t32_tot), `${[g.t32tot.txval, g.t32tot.iamt]} vs ${e3.t32_tot}`);
        check('3B 3.2 first state = independent', same([g.t32[0].pos, g.t32[0].txval], e3.t32_first));
        check('3B TCS estimate = independent', same([g.tcsEstimate.igst, g.tcsEstimate.cgst, g.tcsEstimate.sgst], e3.tcs), `${JSON.stringify(g.tcsEstimate)} vs ${e3.tcs}`);
      }
    }
  } else {
    check('engine produced a result without errors', false);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
