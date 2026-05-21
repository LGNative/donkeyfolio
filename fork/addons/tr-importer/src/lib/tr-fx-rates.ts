/**
 * FX rate helpers for the EUR View panel (v4.7.0).
 *
 * Strategy: read FX rates from Wealthfolio's internal `exchange-rates`
 * table via the SDK. This is the same source the core app uses to
 * convert Total Value into the user's base currency, so we stay
 * consistent with the rest of the UI and avoid introducing a new
 * external dependency.
 *
 * No hardcoded rates, no fallback API. If the user's Wealthfolio DB
 * doesn't have the rate we need, the helper returns `null` and the
 * caller surfaces that explicitly in the UI ("FX rate em falta — total
 * pode estar incompleto").
 */
import type { AddonContext, ExchangeRate } from "@wealthfolio/addon-sdk";

export type FxRateMap = Map<string, number>;

/**
 * Build a (from→to) keyed lookup map. Includes both directions for each
 * pair (1/rate for the inverse) and an identity entry per currency
 * (CCY→CCY = 1) so callers can call `getRate(map, "EUR", "EUR")` safely.
 */
export async function loadFxRates(ctx: AddonContext): Promise<FxRateMap> {
  const rates = (await ctx.api.exchangeRates.getAll()) as ExchangeRate[];
  const map: FxRateMap = new Map();

  // Collect all distinct currencies first to seed identity rates.
  const currencies = new Set<string>();
  for (const r of rates) {
    currencies.add(r.fromCurrency);
    currencies.add(r.toCurrency);
  }
  for (const c of currencies) map.set(`${c}→${c}`, 1);

  for (const r of rates) {
    if (!isFinite(r.rate) || r.rate <= 0) continue;
    map.set(`${r.fromCurrency}→${r.toCurrency}`, r.rate);
    // Set the inverse only if the explicit pair didn't ship one.
    const inverseKey = `${r.toCurrency}→${r.fromCurrency}`;
    if (!map.has(inverseKey)) map.set(inverseKey, 1 / r.rate);
  }

  return map;
}

/**
 * Lookup `from→to`. Returns null when the pair (and its inverse) are
 * absent. Caller decides how to surface the gap.
 */
export function getRate(map: FxRateMap, from: string, to: string): number | null {
  if (from === to) return 1;
  const r = map.get(`${from}→${to}`);
  if (r != null) return r;
  return null;
}

/**
 * Convert `amount` from `from` currency to `to` currency. Returns null
 * if no rate is available — caller must handle the gap explicitly.
 */
export function convert(map: FxRateMap, amount: number, from: string, to: string): number | null {
  const r = getRate(map, from, to);
  if (r == null) return null;
  return amount * r;
}
