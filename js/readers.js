// Turns an uploaded Excel file into plain row objects and says which Meesho file it is.
// Files are recognised by their header row, never by file name.
import * as XLSX from '../lib/xlsx.js';

export const KIND = {
  SALES: 'sales',        // tcs_sales.xlsx
  RETURNS: 'returns',    // tcs_sales_return.xlsx
  DOCS: 'docs',          // Tax_invoice_details.xlsx
};

export const KIND_LABEL = {
  sales: 'Meesho sales (tcs_sales)',
  returns: 'Meesho returns (tcs_sales_return)',
  docs: 'Meesho tax invoice list (Tax_invoice_details)',
};

const GST_REPORT_COLS = [
  'identifier', 'gstin', 'sub_order_num', 'hsn_code', 'quantity', 'gst_rate',
  'total_taxable_sale_value', 'tax_amount', 'total_invoice_value',
  'end_customer_state_new', 'eco_tcs_gstin', 'financial_year', 'month_number',
];
const DOC_COLS = ['Type', 'Suborder No.', 'HSN', 'Invoice No.'];

function kindOf(headers) {
  const has = (cols) => cols.every((c) => headers.includes(c));
  if (has(GST_REPORT_COLS)) return headers.includes('cancel_return_date') ? KIND.RETURNS : KIND.SALES;
  if (has(DOC_COLS)) return KIND.DOCS;
  return null;
}

// data: ArrayBuffer (browser) or Buffer (Node). Returns { kind, sheet, headers, rows }.
// Throws an Error with a readable message when the file is not a known Meesho file.
export function readMeeshoFile(data, fileName = 'file') {
  const wb = XLSX.read(data, { type: data instanceof ArrayBuffer ? 'array' : 'buffer' });
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    // The header row is the first row that identifies the file (usually row 1).
    for (let h = 0; h < Math.min(grid.length, 10); h++) {
      const headers = (grid[h] || []).map((c) => (c === null ? '' : String(c).trim()));
      const kind = kindOf(headers);
      if (!kind) continue;
      const rows = [];
      for (let i = h + 1; i < grid.length; i++) {
        const cells = grid[i];
        if (!cells || cells.every((c) => c === null || String(c).trim() === '')) continue;
        const row = { _row: i + 1 }; // Excel row number, for messages
        headers.forEach((name, c) => { if (name) row[name] = cells[c] ?? null; });
        rows.push(row);
      }
      return { kind, sheet: sheetName, headers, rows };
    }
  }
  throw new Error(`${fileName}: not a Meesho GST report or tax invoice list (no matching header row found).`);
}
