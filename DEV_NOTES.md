# Development notes

Things to fix or remember while building. The PRD is the spec (private link, ask the owner).
Month-specific figures used for testing (real GSTIN, amounts, order numbers) are kept in
`tests/private/DEV_NOTES_private.md`, which is git-ignored. Nothing in this file may name
real GSTINs, amounts or order numbers.

## 1. Rounding rule (the PRD's GSTR-3B example is wrong)

The PRD's GSTR-3B example adds up unrounded values. The GST portal adds up the rounded
Table 7 (B2CS) rows, so GSTR-3B 3.1 / 3.2 and Table 14 must do the same. Rule:

1. Sum each place-of-supply x rate group at full precision.
2. Round the group's taxable value and its tax to 2 decimals (one Table 7 row).
   Tax = rate x the unrounded group value (same as the Offline Tool).
3. Every later total (Table 14, GSTR-3B 3.1, 3.2, payment) = sum of those rounded rows.

Table 12 (HSN) is rounded per HSN row, so its totals can differ from Table 7 by a few paise.
The "Table 12 total = Table 7 total" check uses a Rs 1 tolerance and shows an info note.
Implemented in `js/gstr1.js`.

## 2. Golden test

`tests/run.mjs` runs the browser modules in Node on a real month's files and compares the
JSON with (a) the Offline Tool export for that month and (b) an independent Python + Decimal
implementation. Expected files live in `tests/private/`.

## 3. Table 13 (documents issued)

- Invoices = distinct `sub_order_num` with a row where `quantity` > 0. A sub-order that only
  has a quantity-0 shipping reversal belongs to an earlier month's invoice.
- "Credit notes = return rows" is wrong. Meesho issues three kinds:
  `<code><FY>C<n>` return credit note, `<code><FY>CC<n>` CREDIT_CONVERSION,
  `<code><FY>CM<n>` CREDIT_DISCOUNT (`<code>` = the GST report's `identifier`,
  `<FY>` = last two digits of the financial year's end).
- `Tax_invoice_details.xlsx` (Type, Order Date, Suborder No., Product Description, HSN,
  Invoice No.) is filtered by **order date**. Document dates are only inside the PDFs.
- CM notes = the quantity-0 negative rows in `tcs_sales` (same value).
- CC notes are already netted into the `tcs_sales` row value. They count in Table 13 only.
- Documents for orders placed in an earlier month (returns, shipping reversals, orders shipped
  on the 1st) are not in the current month's download: the seller must add the previous
  month's `Tax_invoice_details.xlsx`. The engine says how many are missing.
- When the number of unused numbers inside a range equals the number of missing invoices,
  the engine counts them inside the range (and says so). Otherwise it lists separate ranges.
- Possible later improvement: read document dates from the PDFs (pdf.js).
- Editor (step 4, `js/table13.js` + `app.js`): starts from the automatic rows; the seller can
  edit, add or remove rows; Total fills from From/To when the range size is certain
  (`rangeSize` uses the seller-code + FY prefix so "xx2742".."xx27120" = 79). Checks: both
  ends present, max 16 characters, whole numbers, Cancelled <= Total, To not before From,
  no repeated row (errors, block download); Total not matching the range, overlapping
  ranges (warnings). Unedited rows give byte-identical JSON (tested).

## 4. JSON key names (portal-accepted references)

- `b2cs`: from an Offline Tool 3.2.4 export the portal accepted.
- `hsn.hsn_b2c[]`: `num, hsn_sc, user_desc, uqc, qty, rt, txval, iamt, camt, samt, csamt`
  (the PRD wrote `desc`; the key is `user_desc`). UQC `PCS` accepted. No `val` field.
- `supeco.clttx[]`: `etin, suppval, igst, cgst, sgst, cess, flag` with `flag: "N"`.
- A third-party tool kept a zero row in `b2cs`; the portal accepts it. We drop zero rows.

## 5. Meesho file quirks

- Quantity-0 rows with a small negative value are shipping reversals: count the value, not
  the quantity.
- Group by `month_number` / `financial_year`, never by `order_date`.
- Drop place-of-supply x rate groups that net to exactly 0; negative groups are valid.
- State names arrive in upper case (`JAMMU & KASHMIR`); map them to POS codes (`01`).
- Detect files by their header row, not by file name. Values are stored as text.

## 6. Privacy

The repo is public (free GitHub Pages needs that). Real GSTINs, sales figures, order numbers
and JSON returns must never be committed: keep them in `tests/private/` or `samples/private/`.
`.gitignore` blocks `*.zip`, `*.xlsx`, `*.csv` and return JSONs.

## 7. Still open

- [ ] Table 7 type: `OE` (current practice) or `E` with the e-commerce GSTIN (setting exists).
- [ ] Confirm the GST rate for one HSN billed at 3% outside chapter 71 (see private notes).
- [x] ITC: none for now (purchases without GST invoices), so GSTR-3B Table 4 = 0 and the
      GSTR-2B reader is low priority.
- [ ] How the portal shows negative states in GSTR-3B Table 3.2.

## 8. TCS credit can arrive late

The portal's "TDS and TCS credit received" form can show no TCS records days after the
operator's GSTR-8 due date. The GSTR-3B tab must treat "TCS accepted on portal" as an
input that defaults to 0, show the full cash amount, and explain that TCS accepted later
stays in the cash ledger for the next month.

## 9. Build status: GSTR-1 JSON

Code: `js/money.js` (rounding), `js/masters.js`, `js/readers.js` (file detection),
`js/gstr1.js` (engine), `js/json.js`, `js/app.js` (screen).

Verified on the first real month:

- 46/46 checks in `tests/run.mjs` (unit tests; `b2cs` identical to the Offline Tool export;
  every section identical to the independent Python implementation).
- Browser test (Chrome via Playwright): files uploaded on the real page; the downloaded JSON
  is byte-identical to the engine output; no console errors.

GSTR-3B section (`js/gstr3b.js`): 3.1(a) = Table 7 totals; 3.2 = inter-state Table 7 rows
summed per state; no ITC; payment = tax minus the cash-ledger balance the seller types
(defaults to 0, so TCS is never assumed); challan rounded up to whole rupees; TCS shown as
an estimate (0.5%) to compare only. Checked by invariants plus the independent Python
figures (58/58), and in the browser.

NOT yet verified against the portal:

- [ ] GSTR-3B 3.1(a) and 3.2 as pre-filled by the portal for a month whose GSTR-1 came from
      this tool (compare on the first such month).

- [ ] `doc_issue` key names (`doc_num`, `doc_typ`, `docs[].num/from/to/totnum/cancel/net_issue`)
      follow the GSTN schema as remembered, not a file the portal accepted. Check against a
      filed GSTR-1 JSON download, or upload a month's JSON before filing (upload alone does
      not file).
