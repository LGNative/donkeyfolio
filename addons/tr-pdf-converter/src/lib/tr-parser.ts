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
  /** Set by recoverCashAmounts() when we auto-fixed In/Out via description + balance delta. */
  _recovered?: "swapped" | "filled-from-balance";
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
  /** Extracted from description via our post-processing (not in vendored parser). */
  quantity?: number;
  /** Derived: amount / quantity. Undefined when quantity missing. */
  unitPrice?: number;
  /** Cleaned stock name (strip " quantity: X" suffix and trailing commas). */
  cleanStockName?: string;
  /** True when this trade came from a TR "Savings plan execution" (DCA) row. */
  isSavingsPlan?: boolean;
}

/**
 * Format-aware number parser. TR emits statements in multiple locales:
 *   - Portuguese/English layout uses US format: "€13,862.66", "quantity: 0.129117"
 *   - German layout uses EU format:             "€13.862,66", "quantity: 0,129117"
 *
 * Rule: the separator that appears LAST is the decimal point. If only one
 * separator is present, use digit-count heuristics:
 *   - "1.234" / "1,234" with exactly 3 digits after → thousands separator
 *   - any other length → decimal separator
 */
function parseEuroAmount(raw: string): number {
  if (!raw) return 0;
  const s = String(raw).replace(/[€\s]/g, "");
  if (!s) return 0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let normalized: string = s;

  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      // EU: 1.234,56 → 1234.56
      normalized = s.replace(/\./g, "").replace(",", ".");
    } else {
      // US: 1,234.56 → 1234.56
      normalized = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = s.split(",");
    // "1,234" (exactly 3 digits after comma, nothing before > 3 groups) → US thousands
    if (parts.length === 2 && parts[1].length === 3) {
      normalized = s.replace(/,/g, "");
    } else {
      normalized = s.replace(",", ".");
    }
  } else if (hasDot) {
    const parts = s.split(".");
    if (parts.length > 2) {
      // "1.234.567" → EU thousands
      normalized = s.replace(/\./g, "");
    } else if (parts.length === 2 && parts[1].length === 3) {
      // "1.234" → EU thousands (unambiguous: currency never has 3 decimals,
      // and fractional shares with exactly 3 digits are rare enough that
      // this heuristic does more good than harm).
      normalized = s.replace(/\./g, "");
    } else {
      // "0.129117", "13.1", "€13.12" → US decimal
      normalized = s;
    }
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Enrich trading transactions with quantity extracted from the ORIGINAL cash
 * description. jcmpagel's parseTradingTransactions strips the "quantity: X"
 * fragment from stockName, so we have to re-extract from the raw cash data
 * and match back by date + ISIN + amount.
 */
export function enrichTradingWithQuantity(
  trading: TradingTransaction[],
  cash: Array<{ date: string; description: string; incoming: string; outgoing: string }>,
): TradingTransaction[] {
  // Index cash descriptions by a stable key derived from date+ISIN+amount.
  const index = new Map<string, string>();
  for (const c of cash) {
    const desc = c.description || "";
    const isin = desc.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/)?.[1];
    if (!isin) continue;
    const amount = parseEuroAmount(c.outgoing || c.incoming || "");
    if (amount <= 0) continue;
    index.set(`${c.date}|${isin}|${amount.toFixed(2)}`, desc);
  }

  return trading.map((tx) => {
    const key = `${tx.date}|${tx.isin}|${tx.amount.toFixed(2)}`;
    const originalDesc = index.get(key) ?? "";
    const qtyMatch = originalDesc.match(/quantity\s*:\s*([\d.,]+)/i);
    let quantity: number | undefined;
    if (qtyMatch) {
      // Use the format-aware parser — TR descriptions emit "quantity: 0.272851"
      // (US format with dot as decimal). The previous naive replace(/\./g, "")
      // turned 0.272851 into 272851, inflating fractional shares 10^6× and
      // producing absurd Net qty values for stocks with many fractional sells
      // (PALANTIR sample: -11.37M shares vs. real ~63 net).
      const q = parseEuroAmount(qtyMatch[1]);
      if (Number.isFinite(q) && q > 0) quantity = q;
    }
    const unitPrice = quantity && tx.amount > 0 ? Math.abs(tx.amount / quantity) : undefined;
    const cleanStockName = (tx.stockName || "")
      // Strip ISINs that may remain after jcmpagel's extraction.
      .replace(/\s*-?\s*[A-Z]{2}[A-Z0-9]{10}\b/g, "")
      // Strip the "Savings plan execution" marker we injected as "Buy" hint.
      .replace(/\bSavings plan execution\b/i, "")
      // Strip the German bond suffix "DL-,01" etc.
      .replace(/\s+DL-?,?\d+.*$/i, "")
      // Strip the trailing ", quantity: X" fragment.
      .replace(/,\s*quantity\s*:.*$/i, "")
      .replace(/,\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    const isSavingsPlan = /\bSavings plan execution\b/i.test(originalDesc);
    return { ...tx, quantity, unitPrice, cleanStockName, isSavingsPlan };
  });
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

/**
 * Fix PDF-extraction artefacts in trade rows where the amount ended up in
 * the wrong column (or got dropped entirely) because the column-boundary
 * heuristic fell over for certain row geometries.
 *
 * Strategy per "Buy trade"/"Sell trade" row:
 *   1. If the amount sits in the WRONG column for its direction → swap.
 *   2. If BOTH In and Out are empty but we have a usable balance on this
 *      row and the next row → derive amount from the delta.
 *
 * Returns a new array (non-mutating) plus a count of recoveries so the UI
 * can display a friendlier "auto-corrected N" message instead of a scary
 * "N sanity checks failed".
 */
export function recoverCashAmounts(cash: CashTransaction[]): {
  cash: CashTransaction[];
  recovered: number;
} {
  let recovered = 0;
  // We need balance from adjacent rows — convert once up-front.
  const balances = cash.map((r) => parseEuroAmount(r.saldo));

  const fixed = cash.map((row, i): CashTransaction => {
    const desc = row.beschreibung || "";
    const isManualBuy =
      /\bBuy\b|\bKauf\b|\bCompra\b/i.test(desc) && /\btrade\b|\bHandel\b/i.test(desc);
    const isSavingsPlan = /\bSavings plan execution\b/i.test(desc);
    const isBuy = isManualBuy || isSavingsPlan;
    const isSell =
      /\bSell\b|\bVerkauf\b|\bVenta\b/i.test(desc) && /\btrade\b|\bHandel\b/i.test(desc);
    if (!isBuy && !isSell) return row;

    const inc = parseEuroAmount(row.zahlungseingang);
    const out = parseEuroAmount(row.zahlungsausgang);

    // (1) Column swap: Buy should have Out, Sell should have In.
    if (isBuy && inc > 0 && out === 0) {
      recovered += 1;
      return {
        ...row,
        zahlungseingang: "",
        zahlungsausgang: row.zahlungseingang,
        _recovered: "swapped",
      };
    }
    if (isSell && out > 0 && inc === 0) {
      recovered += 1;
      return {
        ...row,
        zahlungseingang: row.zahlungsausgang,
        zahlungsausgang: "",
        _recovered: "swapped",
      };
    }

    // (2) Both columns empty → derive from balance delta with neighbour row.
    if (inc === 0 && out === 0) {
      const thisBal = balances[i];
      // Prefer the previous row (saldo is cumulative; prev - curr = outflow).
      const neighbourBal = i > 0 ? balances[i - 1] : i < cash.length - 1 ? balances[i + 1] : NaN;
      if (Number.isFinite(thisBal) && Number.isFinite(neighbourBal)) {
        const delta = Math.abs(neighbourBal - thisBal);
        if (delta > 0) {
          const formatted =
            delta.toLocaleString("de-DE", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) + " €";
          recovered += 1;
          return isBuy
            ? { ...row, zahlungsausgang: formatted, _recovered: "filled-from-balance" }
            : { ...row, zahlungseingang: formatted, _recovered: "filled-from-balance" };
        }
      }
    }

    // (3) BOTH columns populated → fragment noise on the wrong side.
    // The PDF column-boundary heuristic occasionally lets a piece of the
    // balance text bleed into the opposite column for a trade row.
    //
    // Two passes:
    //   3a) If the value on the EXPECTED side matches the balance delta
    //       within €0.01, clear the OTHER side as junk (most precise).
    //   3b) Otherwise, if the value on the expected side is at least 100×
    //       larger than the value on the wrong side, clear the wrong side
    //       (heuristic — works when prevBalance is itself broken so the
    //        delta doesn't match exactly).
    if (inc > 0 && out > 0) {
      const thisBal = balances[i];
      const prevBal = i > 0 ? balances[i - 1] : NaN;

      // Pass 3a: balance-delta exact match
      if (Number.isFinite(thisBal) && Number.isFinite(prevBal)) {
        const expected = Math.abs(prevBal - thisBal);
        if (expected > 0) {
          if (isBuy && Math.abs(out - expected) < 0.01) {
            recovered += 1;
            return { ...row, zahlungseingang: "", _recovered: "swapped" };
          }
          if (isSell && Math.abs(inc - expected) < 0.01) {
            recovered += 1;
            return { ...row, zahlungsausgang: "", _recovered: "swapped" };
          }
        }
      }

      // Pass 3b: size-direction heuristic
      // For a Buy: expect Out to be the trade amount, In to be junk →
      // if Out is >100× In, In is almost certainly a stray fragment.
      // (Real cases where both columns are non-zero on the same trade row
      // — e.g. partial deposit + buy — would typically be of similar order
      // of magnitude, so the 100× threshold is conservative.)
      const ratioBuy = isBuy && out > inc * 100 && out > 1;
      const ratioSell = isSell && inc > out * 100 && inc > 1;
      if (ratioBuy) {
        recovered += 1;
        return { ...row, zahlungseingang: "", _recovered: "swapped" };
      }
      if (ratioSell) {
        recovered += 1;
        return { ...row, zahlungsausgang: "", _recovered: "swapped" };
      }
    }

    return row;
  });

  return { cash: fixed, recovered };
}
