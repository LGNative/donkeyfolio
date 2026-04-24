/**
 * Native TypeScript bootstrap for jcmpagel's TR parser modules.
 *
 * The original code is plain JS that uses `window.*` globals to share
 * functions between files. We load them in the right order, run them in
 * the current window context, and then re-export the pure-function API
 * that React components need.
 *
 * DOM-dependent helpers (Chart.js renderers, tab navigation, export
 * blob downloads) are intentionally NOT re-exported here — they run
 * against the jcmpagel HTML layout which we're not using.
 *
 * Source: https://github.com/jcmpagel/Trade-Republic-CSV-Excel
 * Vendored under @jcmpagel's open-source license (see README).
 */
import * as pdfjsLib from "pdfjs-dist";
// Inline the worker source as a raw string — we construct a Blob URL at
// runtime so the worker loads inside the Donkeyfolio addon context (where
// relative asset URLs don't resolve).
// eslint-disable-next-line import/no-unresolved
import workerSource from "pdfjs-dist/build/pdf.worker.min.mjs?raw";

import utilsJs from "./jcmpagel-js/utils.js?raw";
import parserJs from "./jcmpagel-js/parser.js?raw";
import tradingJs from "./jcmpagel-js/trading.js?raw";
import statisticsJs from "./jcmpagel-js/statistics.js?raw";
import exportJs from "./jcmpagel-js/export.js?raw";

// ─── pdf.js setup ─────────────────────────────────────────────────────
// Build the Blob URL lazily on first use so import side-effects stay cheap.
let workerBlobUrl: string | null = null;
function getWorkerUrl(): string {
  if (workerBlobUrl) return workerBlobUrl;
  const blob = new Blob([workerSource], { type: "application/javascript" });
  workerBlobUrl = URL.createObjectURL(blob);
  return workerBlobUrl;
}
pdfjsLib.GlobalWorkerOptions.workerSrc = getWorkerUrl();

// The vendored scripts reference `pdfjsLib` as a global (loaded from CDN
// in the original site). We expose it from the npm module so they work.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).pdfjsLib = pdfjsLib;

// ─── Stub DOM helpers used by the vendored scripts ────────────────────
// statistics.js and trading.js call `feather.replace()` and build DOM
// nodes for charts; we stub them to no-ops so pure parsing code still
// runs. Chart rendering itself is skipped (we do our own in React).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any;
if (!w.feather) w.feather = { replace: () => {} };
if (!w.Chart) {
  // Minimal Chart constructor stub — we don't render charts in native mode,
  // but statistics.js/trading.js sometimes reference `new Chart(...)` at
  // module level. Returning a no-op object keeps them from throwing.
  w.Chart = function () {
    return { destroy: () => {} };
  };
}

// ─── Load vendored modules in dependency order ────────────────────────
// utils.js → parser.js → statistics.js → trading.js → export.js
//
// parser.js + utils.js attach their public API to `window.*` themselves,
// but trading.js/statistics.js/export.js only declare local functions
// (they're called from ui.js/app.js in the original, which we don't load).
// We append explicit `window.*` assignments so the React layer can call
// them via the re-exports at the bottom of this file.
const EXPOSE_GLOBALS = `
try { window.parseTradingTransactions = parseTradingTransactions; } catch (_) {}
try { window.calculatePnL = calculatePnL; } catch (_) {}
try { window.computeCashSanityChecks = computeCashSanityChecks; } catch (_) {}
try { window.buildGenericCsv = buildGenericCsv; } catch (_) {}
try { window.buildLexwareCsv = buildLexwareCsv; } catch (_) {}
try { window.createStatsSummary = createStatsSummary; } catch (_) {}
try { window.enrichTradingDataWithSecurities = enrichTradingDataWithSecurities; } catch (_) {}
`;

const concatenated =
  [utilsJs, parserJs, statisticsJs, tradingJs, exportJs].join(
    "\n\n/* ═════════════════ next module ═════════════════ */\n\n",
  ) +
  "\n\n/* ═════════════════ expose locals to window ═════════════════ */\n" +
  EXPOSE_GLOBALS;

let loaded = false;
function ensureLoaded() {
  if (loaded) return;
  try {
    // `new Function` runs the code with implicit `window` as the global
    // object in browsers. Not the cleanest isolation but avoids
    // concatenating into the actual <script> context.
    new Function(concatenated)();
    loaded = true;
  } catch (err) {
    console.error("[tr-parser] Failed to bootstrap vendored scripts:", err);
    throw err;
  }
}

// ─── Public API — pure functions we re-export ─────────────────────────

export interface CashTransaction {
  datum: string;
  typ: string;
  beschreibung: string;
  zahlungseingang: string;
  zahlungsausgang: string;
  saldo: string;
  _sanityCheckOk?: boolean;
}

export interface InterestTransaction {
  datum: string;
  zahlungsart: string;
  geldmarktfonds: string;
  stueck: string;
  kurs: string;
  betrag: string;
}

export interface ParseResult {
  cash: CashTransaction[];
  interest: InterestTransaction[];
}

export interface TradingTransaction {
  date: string;
  isin: string;
  stockName: string;
  action: string;
  isBuy: boolean;
  amount: number;
  tradeId: string;
  balance: string;
}

export interface PnLPosition {
  isin: string;
  stockName: string;
  totalBought: number;
  totalSold: number;
  netCashFlow: number;
  realizedGainLoss: number;
  costBasis: number;
  status: string;
  statusIcon: string;
  isOpen: boolean;
  numBuys: number;
  numSells: number;
  totalTransactions: number;
  firstTrade?: string;
  lastTrade?: string;
}

export interface PnLResult {
  positions: Record<string, unknown>;
  pnlSummary: PnLPosition[];
  totalInvested: number;
  totalRealized: number;
  totalNetCashFlow: number;
  totalTrades: number;
  totalVolume: number;
  openPositions: number;
  closedPositions: number;
}

/** Parse a TR PDF → cash + interest transactions. */
export async function parsePDF(
  arrayBuffer: ArrayBuffer,
  onProgress?: (page: number, total: number) => void,
): Promise<ParseResult> {
  ensureLoaded();
  // utils.js's own pdf worker IIFE may have overwritten workerSrc with a
  // broken relative path. Force-reset to our blob URL before parsing.
  pdfjsLib.GlobalWorkerOptions.workerSrc = getWorkerUrl();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (window as any).parsePDF as (
    pdf: unknown,
    options: {
      updateStatus?: (msg: string) => void;
      updateProgress?: (v: number, t: number) => void;
    },
  ) => Promise<ParseResult>;
  return fn(doc, {
    updateProgress: (v, t) => onProgress?.(v, t),
  });
}

/** Extract trading (buy/sell) transactions from cash transactions. */
export function parseTradingTransactions(cashTransactions: unknown[]): TradingTransaction[] {
  ensureLoaded();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).parseTradingTransactions(cashTransactions);
}

/** Calculate P&L per position from trading transactions. */
export function calculatePnL(tradingTransactions: TradingTransaction[]): PnLResult {
  ensureLoaded();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).calculatePnL(tradingTransactions);
}

/** Add sanity check flag to cash transactions (verifies balance math). */
export function computeCashSanityChecks(cashTransactions: CashTransaction[]): {
  transactions: CashTransaction[];
  failedChecks: number;
} {
  ensureLoaded();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).computeCashSanityChecks(cashTransactions);
}

/** Generic CSV generator (;-separated, German format). */
export function buildGenericCsv(rows: Record<string, unknown>[]): string {
  ensureLoaded();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).buildGenericCsv(rows);
}

/** Lexware/FinanzManager CSV (headerless, dd.MM.yyyy, signed amount). */
export function buildLexwareCsv(rows: Record<string, unknown>[]): string {
  ensureLoaded();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).buildLexwareCsv(rows);
}
