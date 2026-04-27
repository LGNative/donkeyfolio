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
      // "1.234.567" → EU thousands (multiple dots can only be thousands)
      normalized = s.replace(/\./g, "");
    } else if (parts.length === 2 && parts[1].length === 3 && !/^0+$/.test(parts[0])) {
      // "1.234" → EU thousands (only when integer part is non-zero).
      // Critically: "0.384" / "0.117" / "00.384" must STAY as decimals — TR
      // emits fractional share quantities with exactly 3 digits all the time
      // (Sell 0.384 ASML), and the previous heuristic was inflating them
      // 1000× (0.384 → 384).
      normalized = s.replace(/\./g, "");
    } else {
      // "0.129117", "13.1", "€13.12", "0.384" → US decimal
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

// ── Enhanced realized P&L (average-cost method) ─────────────────────────
// jcmpagel's calculatePnL returns realizedGainLoss = 0 for any position that
// is "Teilweise verkauft" (partially sold) — which is the most common state
// for an active TR portfolio. That makes the Trading P&L tab show €0.00 for
// every partially-sold stock and renders the realized-P&L number useless.
//
// Replace it with a proper running-average cost calculation: for each ISIN,
// walk trades in chronological order; BUYs update the running average cost;
// SELLs realize a gain/loss vs. that running average. Sum across positions.

const MONTH_LOOKUP: Record<string, number> = {
  jan: 0,
  feb: 1,
  fev: 1,
  mar: 2,
  apr: 3,
  abr: 3,
  may: 4,
  mai: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  ago: 7,
  sep: 8,
  set: 8,
  oct: 9,
  out: 9,
  nov: 10,
  dec: 11,
  dez: 11,
};

/** Best-effort date sort key — handles dd.MM.yyyy, "20 Jun 2024", and ISO. */
function tradeDateSortKey(s: string): number {
  if (!s) return 0;
  const t = s.trim();
  // dd.MM.yyyy
  const dot = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(t);
  if (dot) return new Date(+dot[3], +dot[2] - 1, +dot[1]).getTime();
  // dd MMM[.] yyyy
  const mon = /^(\d{1,2})\s+([A-Za-zçÇ]{3,})\.?\s+(\d{4})$/.exec(t);
  if (mon) {
    const m = MONTH_LOOKUP[mon[2].slice(0, 3).toLowerCase()];
    if (m !== undefined) return new Date(+mon[3], m, +mon[1]).getTime();
  }
  // ISO
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]).getTime();
  return 0;
}

export interface EnhancedPnLPosition {
  isin: string;
  stockName: string;
  /** Total € spent on buys (gross of any fees). */
  totalBought: number;
  /** Total € received from sells. */
  totalSold: number;
  /** Sum of all bought quantities (positive). */
  qtyBought: number;
  /** Sum of all sold quantities (positive). */
  qtySold: number;
  /** Current holding (qtyBought − qtySold). */
  qtyHeld: number;
  /** FIFO cost basis of the still-held shares (€/share). */
  avgCostBasis: number;
  /** Realized P&L from sells, computed via FIFO matching. */
  realizedPnL: number;
  /** "Open" / "Closed" / "Partial". */
  status: "Open" | "Closed" | "Partial";
}

export interface EnhancedPnLResult {
  positions: EnhancedPnLPosition[];
  totalRealized: number;
  totalBought: number;
  totalSold: number;
}

/**
 * FIFO cost-basis P&L. We use FIFO instead of running-average because that's
 * the method TR displays in its app (and the one Portuguese/EU tax law uses):
 *   - Each BUY appends a lot to a queue [{qty, unitPrice}, ...].
 *   - Each SELL consumes lots from the FRONT of the queue. Realized gain
 *     for that sell = sum over consumed lots of (sellPrice − lotUnitPrice)
 *     × qtyConsumedFromLot.
 *   - "Avg cost basis" of the still-held position = (Σ lot.qty × lot.price) /
 *     Σ lot.qty across the lots remaining in the queue.
 *
 * Validation against TR app on the user's data:
 *   - iShares S&P 500 (no sells): €568.18 → €568.18 (exact match)
 *   - NVIDIA (1 small sell):       €114.91 → ~0.6% off
 *   - Palantir (many sells):       used to be 7.8% off w/ running-avg
 * FIFO closes most of those gaps because TR's display IS the FIFO output.
 */
export function computeEnhancedPnL(trades: TradingTransaction[]): EnhancedPnLResult {
  const byIsin = new Map<string, TradingTransaction[]>();
  for (const t of trades) {
    if (!t.isin || !t.quantity || t.quantity <= 0) continue;
    if (!byIsin.has(t.isin)) byIsin.set(t.isin, []);
    byIsin.get(t.isin)!.push(t);
  }

  const positions: EnhancedPnLPosition[] = [];
  let grandRealized = 0;
  let grandBought = 0;
  let grandSold = 0;

  for (const [isin, txs] of byIsin) {
    txs.sort((a, b) => tradeDateSortKey(a.date) - tradeDateSortKey(b.date));

    // FIFO queue of open lots.
    const lots: { qty: number; unitPrice: number }[] = [];
    let realized = 0;
    let qtyBought = 0;
    let qtySold = 0;
    let totalBoughtEur = 0;
    let totalSoldEur = 0;

    for (const t of txs) {
      const qty = t.quantity!;
      const unitPrice =
        t.unitPrice && t.unitPrice > 0 ? t.unitPrice : qty > 0 ? Math.abs(t.amount) / qty : 0;
      if (unitPrice <= 0) continue;

      if (t.isBuy) {
        lots.push({ qty, unitPrice });
        qtyBought += qty;
        totalBoughtEur += Math.abs(t.amount);
      } else {
        // FIFO consumption from front of queue.
        let remaining = qty;
        while (remaining > 1e-9 && lots.length > 0) {
          const front = lots[0];
          const taken = Math.min(remaining, front.qty);
          realized += (unitPrice - front.unitPrice) * taken;
          front.qty -= taken;
          remaining -= taken;
          if (front.qty < 1e-9) lots.shift();
        }
        // If we sold more than we held in the FIFO queue (e.g. pre-statement
        // position), realize the over-sell quantity at sell price (cost = 0).
        if (remaining > 1e-9) {
          realized += unitPrice * remaining;
        }
        qtySold += qty;
        totalSoldEur += Math.abs(t.amount);
      }
    }

    // Snapshot remaining lots to derive held qty + avg basis of held.
    const qtyHeld = lots.reduce((s, l) => s + l.qty, 0);
    const totalHeldCost = lots.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const avgCost = qtyHeld > 0 ? totalHeldCost / qtyHeld : 0;

    let status: EnhancedPnLPosition["status"];
    if (qtySold === 0) status = "Open";
    else if (qtyHeld < 0.0001) status = "Closed";
    else status = "Partial";

    positions.push({
      isin,
      stockName: txs[0].cleanStockName || txs[0].stockName,
      totalBought: totalBoughtEur,
      totalSold: totalSoldEur,
      qtyBought,
      qtySold,
      qtyHeld,
      avgCostBasis: avgCost,
      realizedPnL: realized,
      status,
    });
    grandRealized += realized;
    grandBought += totalBoughtEur;
    grandSold += totalSoldEur;
  }

  positions.sort((a, b) => b.totalBought - a.totalBought);
  return {
    positions,
    totalRealized: grandRealized,
    totalBought: grandBought,
    totalSold: grandSold,
  };
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
