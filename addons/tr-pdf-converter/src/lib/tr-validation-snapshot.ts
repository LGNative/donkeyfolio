/**
 * Validation snapshot — single source of truth for the AI Wizard. (v3.1.0)
 *
 * Why this exists:
 *   Up to v3.0.x we sent the wizard a small slice of aggregated holdings
 *   and asked Claude to verify everything else by re-deriving math from the
 *   user's pasted text. Result: numbers drifted between runs because the
 *   LLM was doing arithmetic that should have been deterministic on our
 *   side. v3.1.0 inverts the contract:
 *
 *     Claude *validates*. It does not *calculate*.
 *
 *   We pre-compute every total/aggregate/saldo-chain figure here in TS, in
 *   a fully deterministic way (sorted inputs, fixed precision), and ship
 *   it to Claude as one immutable JSON blob. Claude only compares against
 *   the user's TR-app paste and reports drift.
 *
 *   Side effects:
 *     - Same parsed input → same snapshot bytes → same hash → cached LLM
 *       response (localStorage). Re-running the wizard with no PDF change
 *       returns instantly with zero API spend.
 *     - The UI can render from this snapshot too, eliminating the "wizard
 *       sees one thing, preview shows another" class of bug.
 *
 * Stability contract:
 *   The on-the-wire shape of ValidationSnapshot is versioned via
 *   SNAPSHOT_VERSION. Bump the version when fields are added/removed/
 *   renamed so cached responses from older versions get invalidated.
 */

import type {
  CashTransaction,
  InterestTransaction,
  StatementSummary,
  TradingTransaction,
} from "./tr-parser";
import { buildEurHoldings, summarizeEurHoldings, type EurHoldingRow } from "./tr-eur-holdings";

/** Bump when the snapshot schema changes shape. Cache keys include this. */
export const SNAPSHOT_VERSION = "v1";

/**
 * Round to 2 / 6 / 8 decimals. We use fixed precision throughout so
 * floating-point noise can't change a snapshot byte-for-byte across runs.
 * EUR amounts → 2dp. Crypto qty → 8dp. FX rate → 6dp.
 */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function r6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
function r8(n: number): number {
  return Math.round(n * 100_000_000) / 100_000_000;
}

export interface SnapshotMeta {
  /** Schema version of this snapshot blob. */
  schemaVersion: string;
  /** Addon package version producing the snapshot. */
  addonVersion: string;
  /** Account base currency (always EUR for TR PT users). */
  baseCurrency: string;
  /** N PDFs that fed the parser. */
  pdfCount: number;
  /** Inferred period boundaries (min/max date across all activities). */
  period: { from: string | null; to: string | null };
  /** Generated timestamp (UTC ISO). Excluded from cache hash so the
   *  same parsed data hits the cache regardless of when it was built. */
  generatedAt: string;
}

export interface CashflowBucket {
  /** Total deposits (TRANSFER_IN, salary deposits, etc.) — excludes interest/dividends. */
  deposits: number;
  /** Total withdrawals to external accounts (always positive). */
  withdrawals: number;
  /** Money market & savings interest credited. */
  interestIn: number;
  /** Card refunds, cashback, savebacks (always positive). */
  refunds: number;
  /** Trading fees (€1/manual, savings plan = €0). Always positive. */
  tradingFees: number;
  /** Withholding taxes paid (always positive). */
  taxes: number;
  /** Total invested (BUY cash-out, gross). */
  invested: number;
  /** Total realized (SELL cash-in, gross). */
  divested: number;
}

export interface SaldoChain {
  /** From the page-1 summary block (authoritative). null if not parsed. */
  openingFromSummary: number | null;
  /** Computed by walking cash rows from opening. */
  computedClosing: number | null;
  /** From page-1 summary block. */
  closingFromSummary: number | null;
  /** Difference between computed and reported closing. */
  delta: number | null;
  /** True when |delta| ≤ 0.01. */
  reconciles: boolean | null;
}

export interface PerIsinFigure {
  isin: string;
  symbol: string;
  name: string;
  /** Net qty currently held (FIFO). */
  qty: number;
  /** Sum of EUR paid for the qty held (FIFO basis, fees included if pdfFee resolved). */
  costBasisEur: number;
  /** = costBasisEur / qty when qty > 0. */
  avgCostEur: number;
  /** Total bought across all BUYs (EUR, gross). */
  totalBoughtEur: number;
  /** Total sold across all SELLs (EUR, gross). */
  totalSoldEur: number;
  /** Realized P&L from FIFO closes (EUR). */
  realizedPnlEur: number;
  /** Number of BUYs aggregated. */
  buyCount: number;
  /** Number of SELLs aggregated. */
  sellCount: number;
  /** First trade date (YYYY-MM-DD). */
  firstDate: string;
  /** Last trade date (YYYY-MM-DD). */
  lastDate: string;
}

export interface PerCurrencyFigure {
  currency: string;
  /** Trades booked in this currency. */
  tradeCount: number;
  /** Sum of cash-out (BUYs) in this currency, gross. */
  buys: number;
  /** Sum of cash-in (SELLs) in this currency, gross. */
  sells: number;
  /** Sum of fees explicitly extracted from PDF (Fremdkostenzuschlag etc). */
  pdfFees: number;
}

export interface UnresolvedRow {
  rowIdx: number;
  reason: string;
  raw: string;
}

export interface ValidationSnapshot {
  meta: SnapshotMeta;
  cashflow: CashflowBucket;
  saldoChain: SaldoChain;
  totals: {
    holdingsCount: number;
    openPositions: number;
    closedPositions: number;
    totalCostBasisEur: number;
    totalRealizedPnlEur: number;
    tradeCount: number;
    interestRowCount: number;
    cashRowCount: number;
  };
  perIsin: PerIsinFigure[];
  perCurrency: PerCurrencyFigure[];
  unresolved: UnresolvedRow[];
}

/** Inputs the snapshot builder needs. Mirrors what the page already has post-parse. */
export interface SnapshotInputs {
  cash: CashTransaction[];
  interest: InterestTransaction[];
  trades: TradingTransaction[];
  /** Page-1 summary block per PDF, in upload order. Used to derive opening/closing
   *  saldo. When multiple PDFs are present we take the first openingBalance and
   *  the last closingBalance — same convention as tr-multi-pdf.ts uses for the
   *  aggregated summary tile. null entries mean that PDF didn't yield a summary. */
  summaries: Array<StatementSummary | null>;
  baseCurrency: string;
  addonVersion: string;
  pdfCount: number;
}

/** Parse a TR PDF balance string ("€1.234,56" / "€1,234.56" / "1234.56"). */
function parseAmount(raw: string | null | undefined): number {
  if (!raw) return 0;
  const s = String(raw).replace(/[€\s]/g, "");
  if (!s) return 0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let normalized = s;
  if (hasComma && hasDot) {
    normalized =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (hasComma) {
    normalized = s.replace(",", ".");
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

/** Classify a cash row into a cashflow bucket using its `typ` (multilingual). */
function classifyCash(typ: string): keyof CashflowBucket | null {
  const t = typ.toLowerCase();
  if (
    t.includes("deposit") ||
    t.includes("transfer") ||
    t.includes("eingang") ||
    t.includes("dépôt") ||
    t.includes("depósito") ||
    t.includes("ingreso") ||
    t.includes("versement") ||
    t.includes("entrada")
  )
    return "deposits";
  if (
    t.includes("withdraw") ||
    t.includes("auszahlung") ||
    t.includes("retirada") ||
    t.includes("retrait") ||
    t.includes("prelievo") ||
    t.includes("levantament")
  )
    return "withdrawals";
  if (
    t.includes("interest") ||
    t.includes("zins") ||
    t.includes("intéret") ||
    t.includes("intéres") ||
    t.includes("juros") ||
    t.includes("rendiment") ||
    t.includes("earning") ||
    t.includes("intereses")
  )
    return "interestIn";
  if (
    t.includes("refund") ||
    t.includes("cashback") ||
    t.includes("saveback") ||
    t.includes("reembols") ||
    t.includes("erstattung")
  )
    return "refunds";
  if (
    t.includes("tax") ||
    t.includes("steuer") ||
    t.includes("imposto") ||
    t.includes("impuesto") ||
    t.includes("imposta")
  )
    return "taxes";
  return null;
}

/**
 * Build a deterministic snapshot from parsed PDF data.
 * Pure function — no I/O, no clock reads except generatedAt (which is excluded
 * from the cache hash so it's safe).
 */
export function buildValidationSnapshot(input: SnapshotInputs): ValidationSnapshot {
  // ─── Cashflow buckets ───────────────────────────────────────────────
  const cashflow: CashflowBucket = {
    deposits: 0,
    withdrawals: 0,
    interestIn: 0,
    refunds: 0,
    tradingFees: 0,
    taxes: 0,
    invested: 0,
    divested: 0,
  };
  for (const c of input.cash) {
    const inAmt = parseAmount(c.zahlungseingang);
    const outAmt = parseAmount(c.zahlungsausgang);
    const bucket = classifyCash(c.typ);
    if (bucket === "deposits") cashflow.deposits += inAmt;
    else if (bucket === "withdrawals") cashflow.withdrawals += outAmt;
    else if (bucket === "interestIn") cashflow.interestIn += inAmt;
    else if (bucket === "refunds") cashflow.refunds += inAmt;
    else if (bucket === "taxes") cashflow.taxes += outAmt || inAmt;
  }

  // ─── Trading totals + per-currency + per-ISIN (via FIFO) ────────────
  const perCurMap = new Map<string, PerCurrencyFigure>();
  const dateRange: { min: string | null; max: string | null } = { min: null, max: null };
  const perIsinFirstLastDate = new Map<string, { first: string; last: string }>();

  for (const t of input.trades) {
    const cash = Math.abs(t.amount);
    const fee = t.pdfFee ?? (t.isSavingsPlan ? 0 : 1);
    if (t.isBuy) {
      cashflow.invested += cash;
    } else {
      cashflow.divested += cash;
    }
    cashflow.tradingFees += fee;

    const ccy = t.pdfFeeCurrency ?? input.baseCurrency;
    const cur = perCurMap.get(ccy) ?? {
      currency: ccy,
      tradeCount: 0,
      buys: 0,
      sells: 0,
      pdfFees: 0,
    };
    cur.tradeCount += 1;
    if (t.isBuy) cur.buys += cash;
    else cur.sells += cash;
    if (t.pdfFee) cur.pdfFees += t.pdfFee;
    perCurMap.set(ccy, cur);

    if (t.date) {
      if (!dateRange.min || t.date < dateRange.min) dateRange.min = t.date;
      if (!dateRange.max || t.date > dateRange.max) dateRange.max = t.date;
      const fl = perIsinFirstLastDate.get(t.isin) ?? { first: t.date, last: t.date };
      if (t.date < fl.first) fl.first = t.date;
      if (t.date > fl.last) fl.last = t.date;
      perIsinFirstLastDate.set(t.isin, fl);
    }
  }

  // Derive per-ISIN figures from the same FIFO computation the EUR Holdings
  // tab uses — keeps wizard and UI in lock-step.
  const eurRows = buildEurHoldings(input.trades);
  const perIsin: PerIsinFigure[] = eurRows.map((r: EurHoldingRow) => {
    const fl = perIsinFirstLastDate.get(r.isin) ?? { first: "", last: "" };
    return {
      isin: r.isin,
      symbol: r.symbol,
      name: r.name,
      qty: r8(r.qty),
      costBasisEur: r2(r.costBasisEur),
      avgCostEur: r6(r.avgCostEur),
      totalBoughtEur: r2(r.totalBoughtEur),
      totalSoldEur: r2(r.totalSoldEur),
      realizedPnlEur: r2(r.realizedPnlEur),
      buyCount: r.buyCount,
      sellCount: r.sellCount,
      firstDate: fl.first,
      lastDate: fl.last,
    };
  });

  // Sort deterministically: by ISIN ASC. (Display order is the UI's
  // concern — the snapshot wants a stable shape for hashing.)
  perIsin.sort((a, b) => (a.isin < b.isin ? -1 : a.isin > b.isin ? 1 : 0));

  const perCurrency = Array.from(perCurMap.values())
    .map((c) => ({
      ...c,
      buys: r2(c.buys),
      sells: r2(c.sells),
      pdfFees: r2(c.pdfFees),
    }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));

  const summary = summarizeEurHoldings(eurRows);

  // ─── Saldo chain ────────────────────────────────────────────────────
  // Take opening from FIRST summary, closing from LAST summary (matches
  // multi-PDF aggregation convention). Compute closing by walking cash.
  const firstSummary = input.summaries.find((s) => s !== null);
  const lastSummary = [...input.summaries].reverse().find((s) => s !== null);
  const opening = firstSummary ? parseAmount(firstSummary.openingBalance) : null;
  const closingReported = lastSummary ? parseAmount(lastSummary.endingBalance) : null;

  let computedClosing: number | null = null;
  if (opening !== null) {
    let bal = opening;
    for (const c of input.cash) {
      bal += parseAmount(c.zahlungseingang);
      bal -= parseAmount(c.zahlungsausgang);
    }
    computedClosing = r2(bal);
  }
  const delta =
    computedClosing !== null && closingReported !== null
      ? r2(computedClosing - closingReported)
      : null;

  // ─── Unresolved rows (qty missing) ──────────────────────────────────
  const unresolved: UnresolvedRow[] = [];
  input.trades.forEach((t, idx) => {
    if (!t.quantity || t.quantity <= 0) {
      unresolved.push({
        rowIdx: idx,
        reason: "missing_qty",
        raw: `${t.date} ${t.action} ${t.stockName} ${t.amount}€`,
      });
    }
  });

  return {
    meta: {
      schemaVersion: SNAPSHOT_VERSION,
      addonVersion: input.addonVersion,
      baseCurrency: input.baseCurrency,
      pdfCount: input.pdfCount,
      period: { from: dateRange.min, to: dateRange.max },
      generatedAt: new Date().toISOString(),
    },
    cashflow: {
      deposits: r2(cashflow.deposits),
      withdrawals: r2(cashflow.withdrawals),
      interestIn: r2(cashflow.interestIn),
      refunds: r2(cashflow.refunds),
      tradingFees: r2(cashflow.tradingFees),
      taxes: r2(cashflow.taxes),
      invested: r2(cashflow.invested),
      divested: r2(cashflow.divested),
    },
    saldoChain: {
      openingFromSummary: opening !== null ? r2(opening) : null,
      computedClosing,
      closingFromSummary: closingReported !== null ? r2(closingReported) : null,
      delta,
      reconciles: delta !== null ? Math.abs(delta) <= 0.01 : null,
    },
    totals: {
      holdingsCount: eurRows.length,
      openPositions: summary.openPositions,
      closedPositions: summary.closedPositions,
      totalCostBasisEur: r2(summary.totalCostBasisEur),
      totalRealizedPnlEur: r2(summary.totalRealizedPnlEur),
      tradeCount: input.trades.length,
      interestRowCount: input.interest.length,
      cashRowCount: input.cash.length,
    },
    perIsin,
    perCurrency,
    unresolved,
  };
}

/**
 * Stable hash of the snapshot, excluding fields that legitimately vary
 * across runs (generatedAt). Two parses of the same PDFs produce the same
 * hash → cached wizard responses can be reused.
 */
export async function hashSnapshot(snap: ValidationSnapshot): Promise<string> {
  const { generatedAt: _ignored, ...metaRest } = snap.meta;
  void _ignored;
  const stable = { ...snap, meta: metaRest };
  const json = JSON.stringify(stable);
  // Web Crypto SHA-256 — available in browser + Tauri webview.
  const buf = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
