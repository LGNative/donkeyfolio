/* ===================== Download Functions ===================== */
function blob(data, fn, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fn;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

const LEXWARE_EXPORT_SCHEMA = {
  delimiter: ';',
  includeHeader: false,
  lineEnding: '\r\n',
  filenameSuffix: '-lexware',
  columns: [
    { key: 'buchungsdatum', getter: (row) => formatLexwareDate(row.datum || row.date || '') },
    { key: 'wertstellung', getter: (row) => formatLexwareDate(row.datum || row.date || '') },
    { key: 'vorgang', getter: (row) => row.typ || row.type || '' },
    { key: 'empfaenger', getter: (row) => row.beschreibung || row.description || '' },
    { key: 'verwendungszweck', getter: (row) => row.beschreibung || row.description || '' },
    { key: 'betrag', getter: (row) => formatLexwareAmount(row) },
    { key: 'waehrung', getter: () => 'EUR' },
    { key: 'kategorie', getter: () => '' },
    { key: 'abgeglichen', getter: () => '' }
  ]
};

function escapeCsvValue(value, delimiter = ';') {
  const stringValue = String(value ?? '');
  const mustQuote = stringValue.includes(delimiter) || stringValue.includes('"') || /[\r\n]/.test(stringValue);
  if (!mustQuote) return stringValue;
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function buildGenericCsv(rows) {
  const cols = Object.keys(rows[0]).filter(k => !k.startsWith('_'));
  let csv = cols.join(';') + '\n'; // German CSV with semicolon
  rows.forEach((r) => {
    csv +=
      cols
        .map((k) => {
          const v = r[k] || '';
          return escapeCsvValue(v, ';');
        })
        .join(';') + '\n';
  });
  return csv;
}

function csvDL(rows, name) {
  const csv = buildGenericCsv(rows);
  blob(csv, name + '.csv', 'text/csv;charset=utf-8');
}

function normalizeExportMonthKey(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function parseExportDate(value) {
  if (typeof parseStatementDate === 'function') {
    const parsed = parseStatementDate(value);
    if (parsed) return parsed;
  }

  const fallbackMonth = {
    jan: 0, januar: 0, january: 0, ene: 0, enero: 0,
    feb: 1, februar: 1, february: 1, febbraio: 1, febb: 1, febrero: 1, fevrier: 1, fevr: 1, fev: 1,
    mar: 2, maerz: 2, marz: 2, mrz: 2, march: 2, marzo: 2, mars: 2,
    apr: 3, april: 3, aprile: 3, avril: 3, abr: 3,
    mai: 4, may: 4, maggio: 4, mag: 4, mayo: 4,
    jun: 5, juni: 5, june: 5, giugno: 5, giu: 5, juin: 5, junio: 5,
    jul: 6, juli: 6, july: 6, luglio: 6, lug: 6, juillet: 6, juil: 6, julio: 6,
    aug: 7, august: 7, agosto: 7, ago: 7, aout: 7,
    sep: 8, sept: 8, september: 8, settembre: 8, set: 8, sett: 8, septiembre: 8,
    oct: 9, oktober: 9, october: 9, ottobre: 9, ott: 9, octubre: 9, okt: 9,
    nov: 10, november: 10, novembre: 10, noviembre: 10,
    dec: 11, dez: 11, dezember: 11, december: 11, dicembre: 11, dic: 11, decembre: 11, diciembre: 11
  };

  const match = String(value || '').match(/(\d{1,2})\s+([^\s.]+)\.?\s+(\d{4})/);
  if (!match) return null;
  const [, day, monthName, year] = match;
  const monthIndex = fallbackMonth[normalizeExportMonthKey(monthName)];
  if (monthIndex == null) return null;
  return new Date(parseInt(year, 10), monthIndex, parseInt(day, 10));
}

function formatDateObjectToGerman(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  return `${day}.${month}.${year}`;
}

function formatLexwareDate(value) {
  return formatDateObjectToGerman(parseExportDate(value));
}

function parseMoneyString(value) {
  if (value == null || value === '') return 0;
  const normalized = String(value)
    .replace(/€/g, '')
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(?:[.,]|$))/g, '')
    .replace(',', '.');
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatLexwareSignedNumber(amount) {
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.0005) return '';
  return amount.toFixed(2).replace('.', ',');
}

function formatLexwareAmount(row) {
  const incoming = parseMoneyString(row.zahlungseingang || row.incoming || '');
  const outgoing = parseMoneyString(row.zahlungsausgang || row.outgoing || '');
  return formatLexwareSignedNumber(incoming - outgoing);
}

function buildLexwareCsv(rows, schema = LEXWARE_EXPORT_SCHEMA) {
  const lines = [];

  if (schema.includeHeader) {
    lines.push(schema.columns.map((column) => escapeCsvValue(column.header || column.key, schema.delimiter)).join(schema.delimiter));
  }

  rows.forEach((row) => {
    const values = schema.columns.map((column) => escapeCsvValue(column.getter(row), schema.delimiter));
    lines.push(values.join(schema.delimiter));
  });

  const lineEnding = schema.lineEnding || '\n';
  return `${lines.join(lineEnding)}${lineEnding}`;
}

function lexwareCsvDL(rows, name) {
  const csv = buildLexwareCsv(rows);
  blob(csv, `${name}${LEXWARE_EXPORT_SCHEMA.filenameSuffix}.csv`, 'text/csv;charset=utf-8');
}

function jsonDL(rows, name) {
  const sanitized = rows.map(r => {
    const entry = {};
    Object.keys(r).forEach(k => {
      if (!k.startsWith('_')) entry[k] = r[k];
    });
    return entry;
  });
  blob(JSON.stringify(sanitized, null, 2), name + '.json', 'application/json');
}

function xlsxDL(rows, name) {
  ensureXLSX(() => {
    /* ----- Prepare data ----- */
    const out = rows.map((r) => {
      const o = {};
      Object.keys(r).forEach(k => {
        if (!k.startsWith('_')) {
          o[k] = r[k];
        }
      });
      
      // Date → real Date object
      const dateValue = o.date || o.datum;
      if (dateValue) {
        const d = typeof parseStatementDate === 'function' ? parseStatementDate(dateValue) : null;
        if (d) {
          const key = o.date ? 'date' : 'datum';
          o[key] = { v: d, t: 'd', z: 'dd.mm.yyyy' };
        }
      }
      
      // Format money values
      moneyKeys.forEach((k) => {
        if (o[k]) {
          const num = parseFloat(o[k].replace(/\./g, '').replace(/,/, '.'));
          if (!isNaN(num)) o[k] = { v: num, t: 'n', z: '#,##0.00 "€"' };
        }
      });
      
      // Quantity as number without currency
      const hasQuantity = Object.prototype.hasOwnProperty.call(o, 'quantity');
      const hasStueck = Object.prototype.hasOwnProperty.call(o, 'stueck');
      const quantityValue = hasQuantity ? o.quantity : hasStueck ? o.stueck : null;
      if (quantityValue != null && quantityValue !== '') {
        const q = parseFloat(String(quantityValue).replace(/\./g, '').replace(/,/, '.'));
        if (!isNaN(q)) {
          if (hasQuantity) o.quantity = { v: q, t: 'n', z: '0.00' };
          if (hasStueck) o.stueck = { v: q, t: 'n', z: '0.00' };
        }
      }
      
      return o;
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(out, { cellDates: true });
    XLSX.utils.book_append_sheet(wb, ws, 'Daten');
    XLSX.writeFile(wb, name + '.xlsx');
  });
}

function ensureXLSX(cb) {
  if (window.XLSX) return cb();
  const s = document.createElement('script');
  s.src = 'js/vendor/xlsx.full.min.js';
  s.onload = cb;
  document.head.appendChild(s);
}

if (typeof window !== 'undefined') {
  window.csvDL = csvDL;
  window.lexwareCsvDL = lexwareCsvDL;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LEXWARE_EXPORT_SCHEMA,
    buildGenericCsv,
    buildLexwareCsv,
    csvDL,
    escapeCsvValue,
    formatLexwareAmount,
    formatLexwareDate,
    formatLexwareSignedNumber,
    lexwareCsvDL,
    parseExportDate,
    parseMoneyString
  };
}
