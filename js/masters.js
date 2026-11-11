// Fixed lists from the GST Offline Tool (GSTR1_Excel_Workbook_Template_V2.2.xlsx, "master" sheet).

export const POS_NAMES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli & Daman & Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshdweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '97': 'Other Territory',
};

// State names as Meesho writes them (upper case), plus common spellings.
// Keys are normalised with normState() below.
const STATE_ALIASES = {
  'JAMMU AND KASHMIR': '01', 'J AND K': '01',
  'HIMACHAL PRADESH': '02',
  'PUNJAB': '03',
  'CHANDIGARH': '04',
  'UTTARAKHAND': '05', 'UTTARANCHAL': '05',
  'HARYANA': '06',
  'DELHI': '07', 'NEW DELHI': '07', 'NCT OF DELHI': '07',
  'RAJASTHAN': '08',
  'UTTAR PRADESH': '09',
  'BIHAR': '10',
  'SIKKIM': '11',
  'ARUNACHAL PRADESH': '12',
  'NAGALAND': '13',
  'MANIPUR': '14',
  'MIZORAM': '15',
  'TRIPURA': '16',
  'MEGHALAYA': '17',
  'ASSAM': '18',
  'WEST BENGAL': '19',
  'JHARKHAND': '20',
  'ODISHA': '21', 'ORISSA': '21',
  'CHHATTISGARH': '22', 'CHATTISGARH': '22', 'CHHATISGARH': '22',
  'MADHYA PRADESH': '23',
  'GUJARAT': '24',
  // Daman & Diu merged into code 26 in 2020.
  'DAMAN AND DIU': '26', 'DADRA AND NAGAR HAVELI': '26',
  'DADRA AND NAGAR HAVELI AND DAMAN AND DIU': '26',
  'THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU': '26',
  'MAHARASHTRA': '27',
  'KARNATAKA': '29',
  'GOA': '30',
  'LAKSHADWEEP': '31', 'LAKSHDWEEP': '31',
  'KERALA': '32',
  'TAMIL NADU': '33', 'TAMILNADU': '33',
  'PUDUCHERRY': '34', 'PONDICHERRY': '34',
  'ANDAMAN AND NICOBAR ISLANDS': '35', 'ANDAMAN AND NICOBAR': '35',
  'TELANGANA': '36',
  'ANDHRA PRADESH': '37',
  'LADAKH': '38',
  'OTHER TERRITORY': '97',
};

export function normState(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

// Returns the 2-digit POS code, or null when the name is unknown.
export function stateToPos(name) {
  return STATE_ALIASES[normState(name)] ?? null;
}

export const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];

// GSTR-1 Table 13 document natures (doc_num codes used in the portal JSON).
export const DOC_NATURE = {
  1: 'Invoices for outward supply',
  5: 'Credit Note',
};

export const UQC_OPTIONS = [
  { code: 'PCS', label: 'PCS - Pieces' },
  { code: 'NOS', label: 'NOS - Numbers' },
  { code: 'SET', label: 'SET - Sets' },
  { code: 'PRS', label: 'PRS - Pairs' },
];

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
