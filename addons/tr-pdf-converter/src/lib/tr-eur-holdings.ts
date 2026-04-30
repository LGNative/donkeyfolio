/**
 * EUR Holdings preview — FIFO cost-basis aggregation in account currency.
 * (v2.20.1)
 *
 * Why this exists:
 *   Wealthfolio core has known open issues (#474, #181, #537, #590) where
 *   the asset detail page displays cost basis in the asset's quote
 *   currency (USD for NASDAQ stocks) instead of the account/base currency
 *   (EUR for TR users). The DATA is correct — every imported activity has
 *   amount + currency=EUR — but the UI surfaces it in USD on detail pages,
 *   forcing the user to mentally divide by fxRate to compare with the TR
 *   app's "Investido" view.
 *
 *   Rather than wait for upstream to fix this, the addon computes the EUR
 *   ground-truth itself directly from the trading transactions it just
 *   imported. The math is identical to what TR app shows — sum of EUR you
 *   actually paid, minus FIFO cost of what you sold.
 *
 * Algorithm:
 *   For each ISIN, walk the trades chronologically and maintain a FIFO
 *   queue of open lots. Each BUY pushes a lot. Each SELL consumes lots
 *   from the head, scaling the lot's EUR amount by the consumed fraction.
 *   After all trades are processed, the remaining lots aggregate to the
 *   current holding: qty + EUR cost basis + avg cost per share.
 *
 *   This matches TR app's "Custo médio" / "Investido total" exactly when
 *   no corporate actions occurred. With splits, the user adds a SPLIT
 *   activity which the holdings calculator handles separately — for our
 *   preview we ignore splits since they don't change EUR amounts (just
 *   the qty distribution across lots, which doesn't affect total cost).
 */

import { lookupTicker } from "./tr-isin-tickers";
import type { TradingTransaction } from "./tr-parser";

export interface EurHoldingRow {
  isin: string;
  symbol: string;
  name: string;
  /** Net qty currently held (positive = long, 0 = closed). */
  qty: number;
  /** Total EUR paid for the qty currently held (FIFO cost basis). */
  costBasisEur: number;
  /** = costBasisEur / qty when qty > 0. */
  avgCostEur: number;
  /** Total EUR paid across all BUYs (informational, ignores SELLs). */
  totalBoughtEur: number;
  /** Total EUR received across all SELLs (informational). */
  totalSoldEur: number;
  /** Net realized P&L from FIFO closes (informational). */
  realizedPnlEur: number;
  /** Number of BUY activities aggregated. */
  buyCount: number;
  /** Number of SELL activities aggregated. */
  sellCount: number;
}

interface Lot {
  qty: number;
  amountEur: number;
}

/**
 * Resolve the EUR amount + fee for a trading transaction the same way
 * tr-to-activities.ts does — so this preview always matches what was
 * actually imported.
 */
function resolveEurAmount(t: TradingTransaction): number {
  const totalCash = Math.abs(t.amount);
  const heuristicFee = t.isSavingsPlan ? 0 : 1;
  const resolvedFee = t.pdfFee ?? heuristicFee;
  // For BUY: gross = cash_out - fee  (€150 paid - €1 fee = €149 invested)
  // For SELL: gross = cash_in + fee  (€2,000 received + €1 fee = €2,001 received gross)
  const gross = t.isBuy ? totalCash - resolvedFee : totalCash + resolvedFee;
  return gross > 0 ? gross : totalCash;
}

/**
 * Aggregate trading transactions by ISIN with FIFO cost-basis tracking.
 * Returns one row per UNIQUE ISIN that had any activity, sorted
 * descending by current EUR cost basis (biggest positions first).
 */
export function buildEurHoldings(trades: TradingTransaction[]): EurHoldingRow[] {
  // Group trades by ISIN, keep them sorted chronologically WITHIN each
  // ISIN (FIFO needs date order to be meaningful).
  const byIsin = new Map<string, TradingTransaction[]>();
  for (const t of trades) {
    if (!t.isin || !t.date || !t.quantity || t.quantity <= 0) continue;
    const arr = byIsin.get(t.isin) ?? [];
    arr.push(t);
    byIsin.set(t.isin, arr);
  }

  const rows: EurHoldingRow[] = [];
  for (const [isin, isinTrades] of byIsin) {
    isinTrades.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const lots: Lot[] = [];
    let totalBoughtEur = 0;
    let totalSoldEur = 0;
    let realizedPnlEur = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (const t of isinTrades) {
      const qty = t.quantity ?? 0;
      const grossEur = resolveEurAmount(t);
      if (t.isBuy) {
        lots.push({ qty, amountEur: grossEur });
        totalBoughtEur += grossEur;
        buyCount += 1;
      } else {
        // Consume lots FIFO. Track the EUR cost of the qty being sold so
        // realized P&L = sale proceeds (grossEur) - cost of those shares.
        let remaining = qty;
        let costOfSold = 0;
        while (remaining > 1e-9 && lots.length > 0) {
          const lot = lots[0];
          if (lot.qty <= remaining + 1e-9) {
            // Whole lot consumed
            remaining -= lot.qty;
            costOfSold += lot.amountEur;
            lots.shift();
          } else {
            // Partial lot: scale the lot's EUR proportionally
            const ratio = remaining / lot.qty;
            const consumed = lot.amountEur * ratio;
            costOfSold += consumed;
            lot.amountEur -= consumed;
            lot.qty -= remaining;
            remaining = 0;
          }
        }
        totalSoldEur += grossEur;
        realizedPnlEur += grossEur - costOfSold;
        sellCount += 1;
      }
    }

    const remainingQty = lots.reduce((s, l) => s + l.qty, 0);
    const remainingCostEur = lots.reduce((s, l) => s + l.amountEur, 0);
    if (remainingQty <= 1e-9 && buyCount + sellCount === 0) continue;

    const mapped = lookupTicker(isin);
    rows.push({
      isin,
      symbol: mapped?.symbol ?? isin,
      name:
        mapped?.displayName ?? (isinTrades[0].cleanStockName || isinTrades[0].stockName || isin),
      qty: remainingQty,
      costBasisEur: remainingCostEur,
      avgCostEur: remainingQty > 0 ? remainingCostEur / remainingQty : 0,
      totalBoughtEur,
      totalSoldEur,
      realizedPnlEur,
      buyCount,
      sellCount,
    });
  }

  // Open positions first (qty > 0), sorted by cost basis desc; closed
  // positions last with realized P&L only.
  rows.sort((a, b) => {
    const aOpen = a.qty > 1e-9;
    const bOpen = b.qty > 1e-9;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return b.costBasisEur - a.costBasisEur;
  });

  return rows;
}

/** Aggregate totals for the summary tile (matches TR app's portfolio total). */
export function summarizeEurHoldings(rows: EurHoldingRow[]) {
  let openPositions = 0;
  let closedPositions = 0;
  let totalCostBasisEur = 0;
  let totalRealizedPnlEur = 0;
  for (const r of rows) {
    if (r.qty > 1e-9) {
      openPositions += 1;
      totalCostBasisEur += r.costBasisEur;
    } else {
      closedPositions += 1;
    }
    totalRealizedPnlEur += r.realizedPnlEur;
  }
  return {
    openPositions,
    closedPositions,
    totalCostBasisEur,
    totalRealizedPnlEur,
  };
}
