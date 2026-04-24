/* ===================== Helper & Locale ===================== */
const $ = (id) => document.getElementById(id);
const log = (m) => {
  const debugEl = $("debug");
  if (!debugEl) return;
  const t = new Date().toISOString().slice(11, 19);
  debugEl.innerHTML += `[${t}] ${m}<br>`;
};

let pdf = null;

const strip = (s = "") =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const normalizeMonthKey = (value = "") =>
  strip(value)
    .replace(/\.$/, "")
    .toLowerCase();

const month = {
  // German
  jan: 0, januar: 0,
  feb: 1, februar: 1,
  mar: 2, mär: 2, maerz: 2, marz: 2, mrz: 2, maer: 2,
  apr: 3, april: 3,
  mai: 4,
  jun: 5, juni: 5,
  jul: 6, juli: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  okt: 9, oct: 9, oktober: 9,
  nov: 10, november: 10,
  dez: 11, dezember: 11,
  // Italian (abbrev and full)
  gen: 0, gennaio: 0,
  febb: 1, febbraio: 1,
  marzo: 2,
  aprile: 3,
  mag: 4, maggio: 4,
  giu: 5, giugno: 5,
  lug: 6, luglio: 6,
  ago: 7, agosto: 7,
  set: 8, sett: 8, settembre: 8,
  ott: 9, ottobre: 9,
  dicembre: 11, dic: 11,
  // English
  january: 0,
  february: 1,
  march: 2,
  may: 4,
  june: 5,
  july: 6,
  october: 9,
  december: 11,
  // French
  janvier: 0, janv: 0,
  fevrier: 1, fevr: 1, fev: 1,
  mars: 2,
  avril: 3,
  juin: 5,
  juillet: 6, juil: 6,
  aout: 7,
  octobre: 9,
  novembre: 10,
  decembre: 11, dec: 11,
  // Spanish
  ene: 0, enero: 0,
  febrero: 1,
  abr: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  octubre: 9,
  noviembre: 10,
  dic: 11, diciembre: 11,
};

function getMonthIndex(value) {
  const normalized = normalizeMonthKey(value);
  if (!normalized) return null;
  return Object.prototype.hasOwnProperty.call(month, normalized) ? month[normalized] : null;
}

function parseStatementDate(dateStr) {
  const match = String(dateStr || '').match(/(\d{1,2})\s+([^\s.]+)\.?\s+(\d{4})/);
  if (!match) return null;

  const [, day, monthName, year] = match;
  const monthIndex = getMonthIndex(monthName);
  if (monthIndex == null) return null;

  return new Date(parseInt(year, 10), monthIndex, parseInt(day, 10));
}

// Debug toggle functionality (kept for backwards compatibility)
const dbgToggle = $("dbg");
if (dbgToggle) {
  dbgToggle.onchange = (e) => {
    const debugEl = $("debug");
    if (debugEl) {
      debugEl.style.display = e.target.checked ? "block" : "none";
    }
  };
}

// Money field keys for formatting
const moneyKeys = [
  "incoming",
  "outgoing",
  "balance",
  "price",
  "amount",
  "zahlungseingang",
  "zahlungsausgang",
  "saldo",
  "kurs",
  "betrag",
];

/* ===================== PDF.js Init ===================== */
function resolvePdfWorkerPath() {
  try {
    // Build worker URL relative to this script file so it works for:
    // - production root (/js/...)
    // - language routes (/en/ -> ../js/...)
    // - local subfolder hosting (/traderepublic/js/...)
    if (document.currentScript && document.currentScript.src) {
      return new URL('vendor/pdf.worker.min.js', document.currentScript.src).toString();
    }
  } catch (_) {}

  // Fallback if currentScript is unavailable for any reason.
  return new URL('js/vendor/pdf.worker.min.js', window.location.origin + '/').toString();
}

const pdfWorkerPath = resolvePdfWorkerPath();
let pdfWorkerBlobUrl = null;
const pdfWorkerReady = (async () => {
  if (!window.pdfjsLib) return false;
  try {
    const res = await fetch(pdfWorkerPath, { cache: "force-cache" });
    if (!res.ok) throw new Error(`Worker fetch failed: ${res.status}`);
    const blob = await res.blob();
    pdfWorkerBlobUrl = URL.createObjectURL(blob);
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerBlobUrl;
    return true;
  } catch (err) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerPath;
    console.warn("PDF worker preload failed, falling back to path.", err);
    return false;
  }
})();

function ensurePdfWorkerReady() {
  return pdfWorkerReady;
}

window.ensurePdfWorkerReady = ensurePdfWorkerReady;
window.parseStatementDate = parseStatementDate;

/* ===================== PDF Processing Functions ===================== */
async function items(pn) {
  const page = await pdf.getPage(pn), tc = await page.getTextContent();
  return tc.items
    .filter(t => t.str.trim())
    .map(t => {
      const [, , , , x, y] = t.transform;
      return { str: t.str, x: Math.round(x), y: Math.round(y), x2: Math.round(x + t.width) };
    })
    .filter(t => t.y > 50);
} 
