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

import { getParseStats, parseEuroAmount as parseEuroAmountShared } from "./tr-amount";
import {
  getDetectedLocale,
  type CashTransaction,
  type InterestTransaction,
  type StatementSummary,
  type TradingTransaction,
} from "./tr-parser";
import { buildEurHoldings, summarizeEurHoldings, type EurHoldingRow } from "./tr-eur-holdings";

/** Bump when the snapshot schema changes shape. Cache keys include this.
 *  v2 (3.1.1): added cashflow.internalTransfers / earnings / rewards;
 *  switched dateRange to ISO-compare. */
export const SNAPSHOT_VERSION = "v2";

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
  /** External deposits (TRANSFER_IN from another bank, salary, etc.). EXCLUDES
   *  internal transfers between TR sub-accounts (Save & Invest etc.). */
  deposits: number;
  /** Total withdrawals to external accounts (always positive). */
  withdrawals: number;
  /** Internal transfers between TR sub-accounts (Save & Invest, SECURITIES).
   *  Tracked separately so the cashflow row doesn't double-count moves
   *  between accounts the user already owns. */
  internalTransfers: number;
  /** Money-market / savings-account interest credited. NOTE: TR labels
   *  staking/dividend rewards as "Earnings" or "Rewards" — those go into
   *  `earnings` and `rewards`, not here. */
  interestIn: number;
  /** Earnings (staking rewards, dividend-like distributions). */
  earnings: number;
  /** Rewards (referral bonuses, "Premio", "Bonus"). */
  rewards: number;
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
    parseStrictHits: number;
    parseHeuristicHits: number;
    parseHeuristicSamples: string[];
  };
  /** (v3.2.5) Per-year breakdown for cross-checking against the fiscal
   *  report. Each entry is keyed by year (YYYY) and reports orders that
   *  PARSED IN THE PERIOD with their fees split BUY/SELL. The fiscal
   *  report's Tabela 9.2A Despesas e Encargos (€58.93 for 2024) covers
   *  closed positions only — comparable to (buyFees + sellFees) restricted
   *  to that year's CLOSED trades, but as a quick sanity check the totals
   *  here help spot 10× / 100× drifts. */
  perYear: Array<{
    year: string;
    buyOrders: number;
    sellOrders: number;
    buyFees: number;
    sellFees: number;
    totalFees: number;
    invested: number;
    divested: number;
  }>;
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

/** (v3.1.1) Use the shared locale-aware parser so the snapshot tile and the
 *  cash-flow summary table can never disagree again. */
function parseAmount(raw: string | null | undefined): number {
  return parseEuroAmountShared(raw, getDetectedLocale());
}

/**
 * Convert a date string to ISO YYYY-MM-DD for stable string-comparison.
 * Handles formats TR emits: "2024-06-20" (already ISO), "20.06.2024" (DE),
 * "20/06/2024" (PT/EN), "20 Jun 2024" (display). Falls back to original
 * string when format unrecognised — caller's comparison still won't crash,
 * just may produce stale boundary values.
 */
function toIsoCompare(raw: string): string {
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  let m = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = raw.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]{3,})\.?\s+(\d{4})/);
  if (m) {
    const months: Record<string, string> = {
      jan: "01",
      fev: "02",
      feb: "02",
      mar: "03",
      mär: "03",
      abr: "04",
      apr: "04",
      mai: "05",
      may: "05",
      jun: "06",
      giu: "06",
      jul: "07",
      lug: "07",
      ago: "08",
      aug: "08",
      set: "09",
      sep: "09",
      out: "10",
      okt: "10",
      oct: "10",
      nov: "11",
      dez: "12",
      dec: "12",
      dic: "12",
    };
    const mm = months[m[2].toLowerCase().slice(0, 3)];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  return raw;
}

/**
 * Classify a cash row into a cashflow bucket using its `typ` (multilingual)
 * and optional description for sub-type hints. Order matters: more specific
 * rules first (e.g. "internal transfer" must beat plain "transfer").
 *
 * v3.1.1 separates Earnings and Rewards from Interest (was lumped together
 * pre-v3.1.1 and produced a misleading "Juros IN" total in the snapshot
 * tile that disagreed with the per-type breakdown table).
 */
function classifyCash(typ: string, desc: string = ""): keyof CashflowBucket | null {
  const t = typ.toLowerCase();
  const d = desc.toLowerCase();

  // Internal transfer: TR moves between Cash / Save & Invest / SECURITIES.
  // Match BEFORE plain transfer/deposit since description is the giveaway.
  if (
    t.includes("internal") ||
    d.includes("save & invest") ||
    d.includes("save and invest") ||
    d.includes("rebalance") ||
    d.includes("transferência interna") ||
    d.includes("transferencia interna")
  )
    return "internalTransfers";

  // Earnings: staking rewards, dividend-like distributions. Match before
  // generic "deposit"/"transfer" because TR sometimes nests these under a
  // generic typ but with a clear description.
  if (
    t.includes("earning") ||
    t.includes("rendiment") ||
    t.includes("ertrag") ||
    t.includes("staking")
  )
    return "earnings";

  // Rewards / bonus / referral / cashback — distinct from refund of money paid.
  if (
    t.includes("reward") ||
    t.includes("bonus") ||
    t.includes("recompens") ||
    t.includes("premio") ||
    t.includes("empfehlung") ||
    t.includes("referral")
  )
    return "rewards";

  if (
    t.includes("interest") ||
    t.includes("zins") ||
    t.includes("juros") ||
    t.includes("intereses") ||
    t.includes("interessi") ||
    t.includes("intéret") ||
    t.includes("intéres")
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
    internalTransfers: 0,
    interestIn: 0,
    earnings: 0,
    rewards: 0,
    refunds: 0,
    tradingFees: 0,
    taxes: 0,
    invested: 0,
    divested: 0,
  };
  for (const c of input.cash) {
    const inAmt = parseAmount(c.zahlungseingang);
    const outAmt = parseAmount(c.zahlungsausgang);
    const bucket = classifyCash(c.typ, c.beschreibung);
    if (bucket === "deposits") cashflow.deposits += inAmt;
    else if (bucket === "withdrawals") cashflow.withdrawals += outAmt;
    else if (bucket === "internalTransfers") {
      // Either side counts the same magnitude — we only record absolute volume
      // (it's a wash for the user's net cashflow).
      cashflow.internalTransfers += inAmt || outAmt;
    } else if (bucket === "interestIn") cashflow.interestIn += inAmt;
    else if (bucket === "earnings") cashflow.earnings += inAmt;
    else if (bucket === "rewards") cashflow.rewards += inAmt;
    else if (bucket === "refunds") cashflow.refunds += inAmt;
    else if (bucket === "taxes") cashflow.taxes += outAmt || inAmt;
  }

  // ─── Trading totals + per-currency + per-ISIN (via FIFO) ────────────
  const perCurMap = new Map<string, PerCurrencyFigure>();
  const dateRange: { min: string | null; max: string | null } = { min: null, max: null };
  const perIsinFirstLastDate = new Map<string, { first: string; last: string }>();

  // (v3.2.3) Fee aggregation matches the TR rule: €1 once per ORDER, where
  // an order is the unique (date, ISIN, direction, savings-plan) tuple.
  // Multiple partial-fill rows for the same order share a single €1 fee,
  // confirmed by TR's official docs:
  //   "partial fills are charged only once per trading day, multiple
  //    partial fills on the same day incur just the single 1 EUR fee"
  // The previous per-row sum overcounted fees on partial fills (the very
  // bug v3.2.3 fixed in the activity emitter).
  const seenOrderKeys = new Set<string>();
  // (v3.2.5) Per-year breakdown for fiscal cross-check.
  type YearAcc = {
    buyOrders: number;
    sellOrders: number;
    buyFees: number;
    sellFees: number;
    invested: number;
    divested: number;
  };
  const perYearMap = new Map<string, YearAcc>();
  const ensureYear = (yyyy: string): YearAcc => {
    let y = perYearMap.get(yyyy);
    if (!y) {
      y = { buyOrders: 0, sellOrders: 0, buyFees: 0, sellFees: 0, invested: 0, divested: 0 };
      perYearMap.set(yyyy, y);
    }
    return y;
  };
  for (const t of input.trades) {
    const cash = Math.abs(t.amount);
    const orderKey = `${t.date}|${t.isin}|${t.isBuy ? "B" : "S"}|${t.isSavingsPlan ? "SP" : "M"}`;
    const isFirstFragment = !seenOrderKeys.has(orderKey);
    seenOrderKeys.add(orderKey);
    const iso = toIsoCompare(t.date);
    const year = iso.slice(0, 4) || "unknown";
    const yAcc = ensureYear(year);
    if (t.isBuy) {
      cashflow.invested += cash;
      yAcc.invested += cash;
    } else {
      cashflow.divested += cash;
      yAcc.divested += cash;
    }
    if (isFirstFragment) {
      const fee = t.pdfFee ?? (t.isSavingsPlan ? 0 : 1);
      cashflow.tradingFees += fee;
      if (t.isBuy) {
        yAcc.buyOrders += 1;
        yAcc.buyFees += fee;
      } else {
        yAcc.sellOrders += 1;
        yAcc.sellFees += fee;
      }
    }

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
      // (v3.1.1) Convert to ISO before comparing — TR `t.date` may be in
      // "DD.MM.YYYY" or "DD MMM YYYY" format which sorts wrong as raw string
      // (e.g. "31.10.2024" > "01.04.2025" lexicographically reversed the
      // period to "01 Apr 2025 → 31 Oct 2024" in the snapshot tile).
      const iso = toIsoCompare(t.date);
      if (!dateRange.min || iso < dateRange.min) dateRange.min = iso;
      if (!dateRange.max || iso > dateRange.max) dateRange.max = iso;
      const fl = perIsinFirstLastDate.get(t.isin) ?? { first: iso, last: iso };
      if (iso < fl.first) fl.first = iso;
      if (iso > fl.last) fl.last = iso;
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
      internalTransfers: r2(cashflow.internalTransfers),
      interestIn: r2(cashflow.interestIn),
      earnings: r2(cashflow.earnings),
      rewards: r2(cashflow.rewards),
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
      // (v3.1.2) Parse quality telemetry — strict-hit ratio shows how many
      // values went through the regex-only path vs the lenient heuristic
      // fallback. 100% strict = trustworthy numbers; lower = some rows have
      // unusual formatting and may need attention.
      // (v3.1.4) Plus a sample of escaping raw strings for debugging.
      parseStrictHits: getParseStats().strictHits,
      parseHeuristicHits: getParseStats().heuristicHits,
      parseHeuristicSamples: getParseStats().heuristicSamples,
    },
    perIsin,
    perCurrency,
    unresolved,
    perYear: Array.from(perYearMap.entries())
      .map(([year, y]) => ({
        year,
        buyOrders: y.buyOrders,
        sellOrders: y.sellOrders,
        buyFees: r2(y.buyFees),
        sellFees: r2(y.sellFees),
        totalFees: r2(y.buyFees + y.sellFees),
        invested: r2(y.invested),
        divested: r2(y.divested),
      }))
      .sort((a, b) => (a.year < b.year ? -1 : 1)),
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
