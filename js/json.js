// Builds the GSTR-1 JSON in the shape the GST portal accepts
// (GSTR-1 -> Prepare Offline -> Upload). Key names follow two files the portal accepted
// for October 2026: the Offline Tool 3.2.4 export (b2cs) and the billoora.com export
// (hsn, supeco). See DEV_NOTES.md section 4.
export const JSON_VERSION = 'GST3.2.4';

// opts.docNatures: Table 13 rows as edited by the seller (from validateDocRows); defaults
// to the rows the engine worked out.
export function toPortalJson(r, opts = {}) {
  if (!r || !r.ok) throw new Error('Cannot build JSON while there are errors.');
  const out = { gstin: r.gstin, fp: r.period.fp, version: JSON_VERSION, hash: 'hash' };

  if (r.b2cs.length) {
    out.b2cs = r.b2cs.map((x) => {
      const o = { sply_ty: x.sply_ty, rt: x.rate, typ: x.typ, pos: x.pos, txval: x.txval };
      if (x.typ === 'E') o.etin = x.etin;
      if (x.sply_ty === 'INTER') o.iamt = x.iamt;
      else { o.camt = x.camt; o.samt = x.samt; }
      o.csamt = 0;
      return o;
    });
  }

  if (r.hsn.length) {
    out.hsn = {
      hsn_b2c: r.hsn.map((x, i) => ({
        num: i + 1,
        hsn_sc: x.hsn,
        user_desc: x.desc,
        uqc: x.uqc,
        qty: x.qty,
        rt: x.rate,
        txval: x.txval,
        iamt: x.iamt,
        camt: x.camt,
        samt: x.samt,
        csamt: 0,
      })),
    };
  }

  const natures = (opts.docNatures ?? r.docs.natures).filter((n) => n.rows.length);
  if (natures.length) {
    out.doc_issue = {
      doc_det: natures.map((n) => ({
        doc_num: n.docNum,
        doc_typ: n.label,
        docs: n.rows.map((d, i) => ({
          num: i + 1,
          from: d.from,
          to: d.to,
          totnum: d.totnum,
          cancel: d.cancel,
          net_issue: d.totnum - d.cancel,
        })),
      })),
    };
  }

  if (r.eco) {
    out.supeco = {
      clttx: [{
        etin: r.eco.etin,
        suppval: r.eco.suppval,
        igst: r.eco.igst,
        cgst: r.eco.cgst,
        sgst: r.eco.sgst,
        cess: 0,
        flag: 'N',
      }],
    };
  }
  return out;
}

export function jsonFileName(r) {
  return `GSTR1_${r.gstin}_${r.period.fp}.json`;
}
