// GSTR-3B figures, derived from the GSTR-1 result. The portal pre-fills Tables 3.1 and 3.2
// from the filed GSTR-1 (sum of the rounded Table 7 rows), so these numbers are what the
// seller should see there. Pure functions; no DOM.
//
// Scope: a Meesho-only B2C seller with no ITC (DEV_NOTES section 7). Table 4 (ITC) is 0.
import { round2, sum2 } from './money.js';

export const TCS_RATE = 0.5; // % collected by the e-commerce operator u/s 52 (0.25% CGST + 0.25% SGST intra-state)
const HEADS = ['igst', 'cgst', 'sgst'];

/**
 * @param {object} r      result of buildGstr1 (must be ok)
 * @param {object} cash   balance in the electronic cash ledger per head, typed from the portal
 *                        (includes TCS accepted and money left from earlier months)
 */
export function buildGstr3b(r, cash = {}) {
  const notes = [];
  const t7 = r.totals.t7;

  // 3.1(a): outward taxable supplies = Table 7 totals.
  const t31a = { txval: t7.txval, iamt: t7.iamt, camt: t7.camt, samt: t7.samt, csamt: 0 };

  // 3.2: inter-state supplies to unregistered persons, one row per place of supply (all rates).
  const inter = r.b2cs.filter((x) => x.sply_ty === 'INTER');
  const intra = r.b2cs.filter((x) => x.sply_ty === 'INTRA');
  const byPos = new Map();
  for (const x of inter) {
    const g = byPos.get(x.pos) ?? { pos: x.pos, posName: x.posName, parts: [], tax: [] };
    g.parts.push(x.txval);
    g.tax.push(x.iamt);
    byPos.set(x.pos, g);
  }
  const t32 = [...byPos.values()].map((g) => ({ pos: g.pos, posName: g.posName, txval: sum2(g.parts), iamt: sum2(g.tax) }));
  const t32tot = { txval: sum2(t32.map((x) => x.txval)), iamt: sum2(t32.map((x) => x.iamt)) };
  const negPos = t32.filter((x) => x.txval < 0);
  if (negPos.length) {
    notes.push(`Table 3.2 has ${negPos.length} negative state(s) (${negPos.map((x) => `${x.pos}-${x.posName} ${x.txval}`).join(', ')}). The portal fills 3.2 from GSTR-1 and does not let you edit it; compare and continue.`);
  }

  // Expected TCS from the operator, to compare with "TDS and TCS credit received" on the portal.
  const interValue = sum2(inter.map((x) => x.txval));
  const intraValue = sum2(intra.map((x) => x.txval));
  const tcsEstimate = {
    igst: round2(Math.max(0, interValue) * TCS_RATE / 100),
    cgst: round2(Math.max(0, intraValue) * TCS_RATE / 200),
    sgst: round2(Math.max(0, intraValue) * TCS_RATE / 200),
  };

  // 6.1 payment. No ITC, so all tax is paid from the cash ledger; deposit only the shortfall.
  const payable = { igst: t31a.iamt, cgst: t31a.camt, sgst: t31a.samt };
  const balance = {};
  const fromLedger = {};
  const deposit = {};
  const challan = {};
  for (const h of HEADS) {
    if (payable[h] < 0) notes.push(`${h.toUpperCase()} is negative (${payable[h]}): returns were more than sales. Tax payable for that head is 0.`);
    const need = Math.max(0, payable[h]);
    const bal = Number(cash[h]);
    balance[h] = Number.isFinite(bal) && bal > 0 ? round2(bal) : 0;
    fromLedger[h] = round2(Math.min(need, balance[h]));
    deposit[h] = round2(need - fromLedger[h]);
    challan[h] = Math.ceil(deposit[h] - 1e-9); // whole rupees; the portal's own challan figure wins
  }
  const total = (o) => sum2(HEADS.map((h) => o[h]));

  return {
    t31a,
    t32,
    t32tot,
    intraValue,
    tcsEstimate,
    payable,
    balance,
    fromLedger,
    deposit,
    challan,
    totals: {
      payable: total(payable),
      fromLedger: total(fromLedger),
      deposit: total(deposit),
      challan: HEADS.reduce((a, h) => a + challan[h], 0),
      tcsEstimate: total(tcsEstimate),
    },
    notes,
  };
}
