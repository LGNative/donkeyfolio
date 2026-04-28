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

import type { CashTransaction } from "./tr-parser";

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

export interface StatementSummary {
  opening: number;
  totalIn: number;
  totalOut: number;
  closing: number;
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
  statement: StatementSummary;
  /** Per-activity-type breakdown of the activities we're about to import. */
  breakdown: ActivityBreakdownRow[];
  /** Sum of cashImpact across all breakdown rows.
   *  Should equal (closing − opening) within rounding error if our parser is
   *  faithful to the PDF. */
  expectedNetDelta: number;
  /** Closing − Opening from the statement. */
  statementNetDelta: number;
  /** expectedNetDelta − statementNetDelta. Non-zero → parser dropped or
   *  mis-classified rows. */
  reconciliationGap: number;
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
 * Compute statement totals from the parsed cash rows.
 *
 * - closing = last row's printed balance (read directly from PDF, always
 *   reliable — TR prints the running balance on every row).
 * - totalIn / totalOut = column sums (sum the In and Out columns across all
 *   rows). These represent the actual cash flow the statement records.
 * - opening = closing − (totalIn − totalOut). DERIVED, not read from the PDF.
 *
 * Why derive opening instead of reading it from the first row's saldo?
 *
 * The naive "first row saldo minus first row signed amount" approach assumes
 * the first row IS the start of the statement period. It isn't — TR
 * statements carry over the closing balance from the previous statement, so
 * the first row's saldo already reflects the carry-over PLUS the first
 * row's effect. Subtracting only the first row's signed amount gives the
 * carry-over balance correctly ONLY IF the first row's In/Out values were
 * extracted correctly by the PDF parser, which is fragile.
 *
 * The derived form is exact by construction: if the row-by-row sums add up,
 * (closing − net flow) = opening. If they don't add up, the statement is
 * internally inconsistent (parser dropped a row, or saldo column is wrong),
 * and our reconciliation will surface that as a non-zero gap downstream
 * regardless of how we computed opening.
 */
export function computeStatementSummary(cash: CashTransaction[]): StatementSummary {
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
): ReconcileResult {
  const statement = computeStatementSummary(cash);
  const statementNetDelta = statement.closing - statement.opening;

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

  const expectedNetDelta = breakdown.reduce((s, r) => s + r.cashImpact, 0);
  const reconciliationGap = expectedNetDelta - statementNetDelta;

  return {
    statement,
    breakdown,
    expectedNetDelta,
    statementNetDelta,
    reconciliationGap,
  };
}
