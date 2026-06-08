/**
 * EUR-aligned holdings computation (v4.7.0).
 *
 * Pure function: takes the holdings + activities + FX map already loaded
 * elsewhere and produces a per-asset table where every monetary column
 * is in EUR (the user's base currency).
 *
 * Why we don't just trust `Holding.costBasis.base` from the SDK:
 *   Wealthfolio's cost basis is computed from the activity amounts in
 *   the asset's `localCurrency`. For an asset like ABCL (USD-quoted via
 *   NASDAQ) bought through TR with EUR settlements, the activity rows
 *   carry `currency=EUR, amount=-€20.00`, but Wealthfolio internally
 *   converts each row to USD using the per-row `fxRate` before summing.
 *   The result loses the user's actual EUR spend.
 *
 *   Here we sum BUY/SELL `amount` strictly in their original `currency`,
 *   then convert to EUR using the live FX rate from the SDK. This makes
 *   `Book Cost` and `Avg Cost` match what the user sees in the TR app.
 *
 * No hardcoded currencies, no hardcoded asset rules. Pure data flow.
 */
import type { ActivityDetails, Holding } from "@wealthfolio/addon-sdk";

import { convert, getRate, type FxRateMap } from "./tr-fx-rates";

const BASE_CURRENCY = "EUR";

export interface EurHoldingRow {
  symbol: string;
  name: string;
  quantity: number;
  /** Currency the asset is quoted in (USD/CAD/EUR/...). */
  localCurrency: string;
  /** Today's price in EUR (= native price × FX). */
  todayPriceEur: number | null;
  /** Today's price as quoted by Yahoo, in the asset's native currency. */
  todayPriceLocal: number | null;
  /** Sum of the user's actual EUR spend (or other-ccy spend converted at
   *  current FX) — matches what TR shows. */
  bookCostEur: number;
  /** bookCostEur / quantity. */
  avgCostEur: number;
  /** quantity × todayPriceEur. */
  totalValueEur: number | null;
  /** totalValueEur − bookCostEur. */
  unrealizedGainEur: number | null;
  /** unrealizedGainEur / bookCostEur. */
  unrealizedGainPct: number | null;
  /** True when at least one BUY/SELL was in a currency for which we
   *  couldn't find an FX rate — caller surfaces this in the UI. */
  fxIncomplete: boolean;
}

interface CcyAccumulator {
  /** Net cash spent (positive = money out) per source currency. */
  netByCcy: Map<string, number>;
}

/**
 * Compute the EUR-aligned table.
 *
 * @param holdings   Output of `ctx.api.portfolio.getHoldings(accountId)`.
 *                   Drives quantity + today's price + asset identity.
 * @param activities Output of `ctx.api.activities.getAll(accountId)`.
 *                   Drives the cost basis (sum of BUY amounts in the
 *                   user's actual pay currency).
 * @param fx         Map from `loadFxRates(ctx)`.
 */
export function computeEurHoldings(
  holdings: Holding[],
  activities: ActivityDetails[],
  fx: FxRateMap,
): EurHoldingRow[] {
  // 1) Bucket BUY/SELL amounts per asset, per source currency.
  //    SELL reduces the cost basis (cash in = subtract from spent).
  const perAsset = new Map<string, CcyAccumulator>();
  for (const a of activities) {
    if (a.activityType !== "BUY" && a.activityType !== "SELL") continue;
    const symbol = a.assetSymbol;
    if (!symbol) continue;
    const amt = parseFloat(a.amount ?? "0");
    if (!isFinite(amt) || amt === 0) continue;
    const ccy = a.currency || BASE_CURRENCY;

    let bag = perAsset.get(symbol);
    if (!bag) {
      bag = { netByCcy: new Map() };
      perAsset.set(symbol, bag);
    }
    // amount is signed: BUY is negative (cash out), SELL is positive
    // (cash in). Invert sign so `netByCcy` accumulates "net cost".
    const cost = -amt;
    bag.netByCcy.set(ccy, (bag.netByCcy.get(ccy) ?? 0) + cost);
  }

  // 2) Walk holdings and merge with the cost-basis accumulator.
  //    When the same symbol appears in multiple accounts (which happens
  //    when this view aggregates across the full portfolio), accumulate
  //    quantities into a single row keyed by symbol. Today's Price
  //    stays the same (it's the spot price, not a per-account thing).
  const byKey = new Map<string, EurHoldingRow>();
  for (const h of holdings) {
    if (h.holdingType !== "security" && h.holdingType !== "AlternativeAsset") continue;
    const symbol = h.instrument?.symbol;
    if (!symbol) continue;

    const localCurrency = h.localCurrency || BASE_CURRENCY;
    const localPrice = h.price ?? null;

    // Today's price → EUR via current FX.
    let todayPriceEur: number | null = null;
    let fxIncomplete = false;
    if (localPrice != null) {
      const converted = convert(fx, localPrice, localCurrency, BASE_CURRENCY);
      if (converted == null) {
        fxIncomplete = true;
      } else {
        todayPriceEur = converted;
      }
    }

    // Cost basis → EUR by summing each currency's net cost converted at
    // current FX. If the asset wasn't traded (no BUY/SELL — pure transfer
    // in), default to 0.
    const bag = perAsset.get(symbol);
    let bookCostEur = 0;
    if (bag) {
      for (const [ccy, cost] of bag.netByCcy) {
        const converted = convert(fx, cost, ccy, BASE_CURRENCY);
        if (converted == null) {
          fxIncomplete = true;
          continue;
        }
        bookCostEur += converted;
      }
    }

    // Same symbol may appear in multiple accounts (when this view runs
    // across the whole portfolio). Sum quantities into the existing
    // row; book cost was already aggregated per-symbol at step 1.
    const existing = byKey.get(symbol);
    if (existing) {
      existing.quantity += h.quantity;
      if (existing.fxIncomplete || fxIncomplete) existing.fxIncomplete = true;
    } else {
      byKey.set(symbol, {
        symbol,
        name: h.instrument?.name ?? symbol,
        quantity: h.quantity,
        localCurrency,
        todayPriceLocal: localPrice,
        todayPriceEur,
        bookCostEur,
        avgCostEur: 0, // recomputed after aggregation below
        totalValueEur: null, // recomputed after aggregation below
        unrealizedGainEur: null,
        unrealizedGainPct: null,
        fxIncomplete,
      });
    }
  }

  // Recompute derived fields after quantity aggregation.
  const out: EurHoldingRow[] = [];
  for (const r of byKey.values()) {
    const totalValueEur =
      r.todayPriceEur != null && r.quantity > 0 ? r.quantity * r.todayPriceEur : null;
    const unrealizedGainEur =
      totalValueEur != null && r.bookCostEur > 0 ? totalValueEur - r.bookCostEur : null;
    const unrealizedGainPct =
      unrealizedGainEur != null && r.bookCostEur > 0 ? unrealizedGainEur / r.bookCostEur : null;
    const avgCostEur = r.quantity > 0 ? r.bookCostEur / r.quantity : 0;
    out.push({
      ...r,
      avgCostEur,
      totalValueEur,
      unrealizedGainEur,
      unrealizedGainPct,
    });
  }

  // Sort by total value desc (largest position first).
  out.sort((a, b) => (b.totalValueEur ?? 0) - (a.totalValueEur ?? 0));
  return out;
}

export interface EurHoldingsTotals {
  bookCostEur: number;
  totalValueEur: number;
  unrealizedGainEur: number;
  unrealizedGainPct: number;
  positionsWithFxGap: number;
}

/** Roll-up the per-row figures for a header KPI strip. */
export function summariseEurHoldings(rows: EurHoldingRow[]): EurHoldingsTotals {
  let bookCostEur = 0;
  let totalValueEur = 0;
  let positionsWithFxGap = 0;
  for (const r of rows) {
    bookCostEur += r.bookCostEur;
    if (r.totalValueEur != null) totalValueEur += r.totalValueEur;
    if (r.fxIncomplete) positionsWithFxGap++;
  }
  const unrealizedGainEur = totalValueEur - bookCostEur;
  const unrealizedGainPct = bookCostEur > 0 ? unrealizedGainEur / bookCostEur : 0;
  return { bookCostEur, totalValueEur, unrealizedGainEur, unrealizedGainPct, positionsWithFxGap };
}

/** Diagnostic helper for the UI: missing-rate hints. */
export function listMissingRates(rows: EurHoldingRow[], fx: FxRateMap): string[] {
  const missing = new Set<string>();
  for (const r of rows) {
    if (!r.fxIncomplete) continue;
    if (getRate(fx, r.localCurrency, BASE_CURRENCY) == null) {
      missing.add(`${r.localCurrency} → ${BASE_CURRENCY}`);
    }
  }
  return [...missing].sort();
}
