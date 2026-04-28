/**
 * Cash reconciliation — compare what's IN the TR PDF vs. what we'll import
 * vs. what actually landed in Donkeyfolio.
 *
 * Three views:
 *   1. **Statement totals** (from the PDF): opening / in / out / closing.
 *      Computed in tr-converter-page.tsx as `computeStatementSummary`.
 *
 *   2. **Expected from activities** (what we plan to import): breakdown by
 *      activityType, with a "net cash impact" that should approximate
 *      (closing − opening). Discrepancies here flag a parser bug or a TR
 *      classification we didn't handle.
 *
 *   3. **Actual from DB** (what landed): sum cash-affecting activities the
 *      backend has stored for the target account in the statement's date
 *      range. Run on demand AFTER an import (button click), so we don't pay
 *      for it on every parse.
 *
 * The "delta" is the headline metric the user cares about — if expected ≠
 * statement-delta within €0.01, something in the parsing pipeline lost a
 * row. If actual ≠ expected, something in the import pipeline (validation,
 * dedup) silently dropped rows.
 */
import type { ActivityImport, ActivityType } from "@wealthfolio/addon-sdk";

import type { CashTransaction, StatementSummary } from "./tr-parser";

// Format-aware EUR parser (mirrors the one in tr-parser/tr-to-activities).
function parseEuroAmount(raw: string): number {
  if (!raw) return 0;
  const s = String(raw).replace(/[€\s]/g, "");
  if (!s) return 0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let normalized: string = s;
  if (hasComma && hasDot) {
    normalized =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (hasComma) {
    const parts = s.split(",");
    normalized =
      parts.length === 2 && parts[1].length === 3 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (hasDot) {
    const parts = s.split(".");
    if (
      parts.length > 2 ||
      (parts.length === 2 && parts[1].length === 3 && !/^0+$/.test(parts[0]))
    ) {
      normalized = s.replace(/\./g, "");
    }
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

/** Numeric totals derived from the parsed cash rows (row-by-row sum).
 *  Renamed from StatementSummary to avoid clashing with the PDF-summary
 *  type re-exported from tr-parser. */
export interface RowDerivedTotals {
  opening: number;
  totalIn: number;
  totalOut: number;
  closing: number;
}

/** Authoritative totals lifted directly from the PDF's "ACCOUNT STATEMENT
 *  SUMMARY" block on page 1. Numeric form, ready for arithmetic. */
export interface PdfSummaryTotals {
  opening: number;
  moneyIn: number;
  moneyOut: number;
  ending: number;
}

export interface ActivityBreakdownRow {
  activityType: ActivityType;
  /** How many activities of this type are in our import set. */
  count: number;
  /** Total absolute € (always positive — direction comes from cashImpact). */
  total: number;
  /** Net effect on the cash balance: +1 for IN-flows, −1 for OUT-flows.
   *  BUY decreases cash (−), SELL increases (+), DEPOSIT (+), WITHDRAWAL (−),
   *  DIVIDEND (+), INTEREST (+), TAX (−), FEE (−), CREDIT (+). */
  cashImpact: number;
}

export interface ReconcileResult {
  /** Row-by-row sum of the parsed cash data (what our parser sees). */
  rowDerived: RowDerivedTotals;
  /** Authoritative totals from the PDF's summary block. null when the
   *  parser couldn't locate it. */
  pdfSummary: PdfSummaryTotals | null;
  /** Per-activity-type breakdown of the activities we're about to import. */
  breakdown: ActivityBreakdownRow[];
  /** Sum of cashImpact across all breakdown rows. */
  activitiesNetDelta: number;
  /** ending − opening from the PDF summary (preferred), or
   *  closing − opening from row-derived totals (fallback). */
  authoritativeNetDelta: number;
  /** activitiesNetDelta − authoritativeNetDelta. Non-zero → parser drift. */
  reconciliationGap: number;
  /** Drift between row-by-row totals and PDF summary totals. Per direction:
   *  positive = row-by-row counted MORE than the summary says.
   *  null when summary is unavailable. */
  parserDrift: {
    inDrift: number;
    outDrift: number;
    closingDrift: number;
  } | null;
}

/** Cash-impact sign by activity type. */
const CASH_SIGN: Partial<Record<ActivityType, 1 | -1>> = {
  DEPOSIT: 1,
  WITHDRAWAL: -1,
  DIVIDEND: 1,
  INTEREST: 1,
  CREDIT: 1,
  TAX: -1,
  FEE: -1,
  BUY: -1,
  SELL: 1,
};

/**
 * Row-by-row sum of the parsed cash data — what OUR parser sees.
 *
 * This is the side of the equation we control. Compare it against the
 * PDF SUMMARY block (parsePdfSummary) to detect parser drift: if the row
 * sum disagrees with the summary, our parser is dropping rows, double-
 * counting them, or putting amounts in the wrong column.
 *
 * - closing = last row's printed balance (read directly from PDF).
 * - totalIn / totalOut = column sums across all parsed rows.
 * - opening = closing − (totalIn − totalOut). Derived for self-consistency
 *   so we can compare a like-for-like against PDF summary's openingBalance.
 */
export function computeRowDerivedTotals(cash: CashTransaction[]): RowDerivedTotals {
  if (cash.length === 0) return { opening: 0, totalIn: 0, totalOut: 0, closing: 0 };
  let totalIn = 0;
  let totalOut = 0;
  for (const c of cash) {
    totalIn += parseEuroAmount(c.zahlungseingang);
    totalOut += parseEuroAmount(c.zahlungsausgang);
  }
  const closing = parseEuroAmount(cash[cash.length - 1].saldo);
  const opening = closing - (totalIn - totalOut);
  return { opening, totalIn, totalOut, closing };
}

/** Convert the raw PDF-summary strings into numeric totals. */
export function parsePdfSummary(s: StatementSummary | null): PdfSummaryTotals | null {
  if (!s) return null;
  return {
    opening: parseEuroAmount(s.openingBalance),
    moneyIn: parseEuroAmount(s.moneyIn),
    moneyOut: parseEuroAmount(s.moneyOut),
    ending: parseEuroAmount(s.endingBalance),
  };
}

/** Backwards-compat shim — older callers may import computeStatementSummary.
 *  It now returns a RowDerivedTotals, structurally the same as before. */
export const computeStatementSummary = computeRowDerivedTotals;

/**
 * Build the reconciliation: statement totals + expected breakdown from the
 * activities we're about to import.
 *
 * Special cases:
 *   - BUY/SELL: cash impact = amount + fee (BUY pays both, SELL nets fee).
 *     We use `amount + fee` for BUY (out-flow) and `amount − fee` for SELL
 *     (in-flow) so the breakdown matches what TR took out / paid in for the
 *     trade row.
 *   - Crypto-pseudo-ISIN trades: same logic as equities.
 *   - Activities with subtype STAKING_REWARD: aggregated under INTEREST.
 */
export function buildReconciliation(
  cash: CashTransaction[],
  activities: ActivityImport[],
  summary: StatementSummary | null = null,
): ReconcileResult {
  const rowDerived = computeRowDerivedTotals(cash);
  const pdfSummary = parsePdfSummary(summary);

  // Use PDF summary as authoritative when available; fall back to row-derived.
  const authoritativeNetDelta = pdfSummary
    ? pdfSummary.ending - pdfSummary.opening
    : rowDerived.closing - rowDerived.opening;

  // Detect parser drift: how far off are our row-by-row sums from the
  // ground truth in the PDF summary?
  const parserDrift = pdfSummary
    ? {
        inDrift: rowDerived.totalIn - pdfSummary.moneyIn,
        outDrift: rowDerived.totalOut - pdfSummary.moneyOut,
        closingDrift: rowDerived.closing - pdfSummary.ending,
      }
    : null;

  // Group activities by type.
  const byType = new Map<ActivityType, { count: number; total: number; cashImpact: number }>();
  for (const a of activities) {
    const sign = CASH_SIGN[a.activityType] ?? 0;
    if (sign === 0) continue;
    // ActivityImport types `amount`/`fee` as `string | number` (the SDK
    // accepts both forms — strings come from CSV import paths). Coerce.
    const toNum = (v: string | number | undefined | null): number =>
      typeof v === "number" ? v : v ? parseFloat(v) || 0 : 0;
    const amount = Math.abs(toNum(a.amount));
    const fee = Math.abs(toNum(a.fee));
    // Trade-row gross cash impact = amount ± fee (cf. tr-to-activities).
    let impact: number;
    if (a.activityType === "BUY") impact = -(amount + fee);
    else if (a.activityType === "SELL") impact = amount - fee;
    else impact = sign * amount;

    const cur = byType.get(a.activityType) ?? { count: 0, total: 0, cashImpact: 0 };
    cur.count += 1;
    cur.total += amount;
    cur.cashImpact += impact;
    byType.set(a.activityType, cur);
  }

  const breakdown: ActivityBreakdownRow[] = [...byType.entries()]
    .map(([activityType, v]) => ({
      activityType,
      count: v.count,
      total: v.total,
      cashImpact: v.cashImpact,
    }))
    // Order: IN-flows first, then OUT-flows; within each, biggest impact first.
    .sort((a, b) => {
      const sa = Math.sign(a.cashImpact);
      const sb = Math.sign(b.cashImpact);
      if (sa !== sb) return sb - sa;
      return Math.abs(b.cashImpact) - Math.abs(a.cashImpact);
    });

  const activitiesNetDelta = breakdown.reduce((s, r) => s + r.cashImpact, 0);
  const reconciliationGap = activitiesNetDelta - authoritativeNetDelta;

  return {
    rowDerived,
    pdfSummary,
    breakdown,
    activitiesNetDelta,
    authoritativeNetDelta,
    reconciliationGap,
    parserDrift,
  };
}
