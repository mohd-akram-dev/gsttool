# Meesho GST Tool

A browser-only tool for Meesho sellers, with two tabs:

- **GST returns**: turns the monthly Meesho GST reports into the GSTR-1 JSON the GST portal
  accepts, plus the GSTR-3B figures.
- **Payments & profit**: matches every order with Meesho's payments, lists the bank transfers
  to tick, and works out profit per month and per product from your raw material cost.

Files are read inside the browser and never uploaded anywhere.

- Developer notes, verification status and known fixes: [DEV_NOTES.md](DEV_NOTES.md)

## Use it: Payments & profit

1. Open the **Payments & profit** tab.
2. Add, for one store: the **Orders** export (CSV) for the month, and the **payment files**
   (xlsx, `..._SP_ORDER_ADS_REFERRAL_PAYMENT_FILE_...`) for that month and the next month.
3. Type the raw material cost per piece for each product (or one cost for a whole group).
   Packaging is ₹10 per parcel shipped by default. Costs are remembered in your browser,
   per store, so next month only new products need a cost.
4. Read the checks (unpaid orders, returns without a claim, later orders), the month summary
   and the profit, then **Download Excel** for your records.
5. GST stores: GST inside the sales is taken off and Meesho's TCS is added back (it counts
   against your GST). Non-GST stores are detected automatically.

## Use it: GST returns

1. Open the tool (GitHub Pages URL, or `http://localhost/gsttool/` with Laragon).
2. Add these files for the month:
   - `tcs_sales.xlsx` and `tcs_sales_return.xlsx` from the Meesho GST report zip
   - `Tax_invoice_details.xlsx` from Meesho tax invoices (also add the previous month's,
     so credit notes for older orders are found)
3. Read the checks. Errors block the download; warnings explain what to look at.
4. Check Table 13 (invoice and credit-note From / To ranges). Edit any cell or add a row
   if needed; Total fills itself from the range. The JSON uses these rows.
5. Review Tables 7, 12 and 14, then click **Download GSTR-1 JSON**.
6. On the GST portal: Returns Dashboard → GSTR-1 → Prepare Offline → Upload. Check the
   portal's summary before filing.

## What it produces

| GSTR-1 table | Built from |
| --- | --- |
| 7 – B2C (Others) | Sales minus returns, by place of supply and rate |
| 12 – HSN summary (B2C) | Same rows, by HSN and rate |
| 13 – Documents issued | Meesho invoice and credit-note numbers in Tax_invoice_details |
| 14 – Supplies through e-commerce | Meesho's GSTIN, totals of Table 7 |

GSTR-3B (step 5 on the page): the figures the portal should pre-fill in Tables 3.1 and 3.2,
and the cash to deposit after the balance in your Electronic Cash Ledger (including
Meesho's TCS once accepted). Nothing to upload for GSTR-3B.

## Run locally

The page uses JavaScript modules, so open it through a web server, not by
double-clicking the file. With Laragon running, open `http://localhost/gsttool/`.

## Tests

```
npm test                                  # unit tests (GST and payments, made-up data)
node tests/run.mjs --expected tests/private/<month>.expected.json \
  --offline <Offline Tool JSON> <xlsx files...>   # GSTR-1 golden test on real files
node tests/recon.mjs tests/private/recon-golden.json   # payments golden test on real store folders
```

Real GST data and expected outputs live in `tests/private/`, which is git-ignored.

## Deploy

Push to the `main` branch. GitHub Pages serves the root folder at
`https://<username>.github.io/gsttool/`.

## Disclaimer

The tool prepares figures; the seller checks them and files on the GST portal.
