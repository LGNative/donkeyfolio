/**
 * Create the missing FX-rate assets so the core can value non-base holdings.
 *
 * Why this is all that's needed
 * -----------------------------
 * The v3.5 core ALREADY handles a holding whose asset currency differs from its
 * quote currency — the valuation log says:
 *   "Holding currency (EUR) differs from quote currency (USD).
 *    Using quote currency FX for market value conversion."
 * i.e. it converts the quote (USD) to the holding currency (EUR) via an FX
 * rate — it just needs `FX:USD/EUR` to exist. There is no need to touch the
 * asset's quote_ccy; we only create the missing FX pairs.
 *
 * For every distinct non-base currency the HELD quotes are actually in (read
 * from the quotes, not the asset label), create an `FX:<ccy>/<base>` asset with
 * source YAHOO, seeded live from the ECB, then sync + recalculate so the core's
 * daily Yahoo rates land and the valuations convert.
 *
 * Constraints honoured: SDK-only (no DB surgery, no base-code change), no
 * hardcoded rates or currency lists, reversible (delete the rate).
 */
import type { AddonContext, ExchangeRate, Holding, Quote } from "@wealthfolio/addon-sdk";

/** The only provider the core syncs daily for FX assets. */
const FX_SOURCE = "YAHOO";
/** ECB reference rates, open + CORS-friendly. Seed only; Yahoo owns the daily history. */
const ECB_URL = "https://api.frankfurter.dev/v1/latest";
const CONCURRENCY = 6;

export interface FxPairResult {
  base: string;
  /** Distinct non-base quote currencies found among the held assets. */
  currencies: string[];
  /** FX pairs created this run, e.g. "USD→EUR". */
  created: string[];
  /** FX pairs that already existed. */
  skipped: string[];
  /** FX pairs we could not seed (no rate invented). */
  failed: { pair: string; reason: string }[];
  synced: boolean;
  recalculated: boolean;
}

/** 1 unit of `from` expressed in `to`, fetched live from the ECB. No hardcoded value. */
async function fetchEcbRate(from: string, to: string): Promise<number> {
  const url = `${ECB_URL}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ECB HTTP ${res.status}`);
  const data = (await res.json()) as { rates?: Record<string, number> };
  const rate = data?.rates?.[to];
  if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) {
    throw new Error("sem taxa na resposta do ECB");
  }
  return rate;
}

/** Currency of the asset's most recent quote, or "" when it has none. */
async function quoteCurrencyOf(ctx: AddonContext, assetId: string): Promise<string> {
  try {
    const quotes = (await ctx.api.quotes.getHistory(assetId)) as Quote[];
    if (!quotes?.length) return "";
    const latest = quotes.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
    return latest.currency || "";
  } catch {
    return "";
  }
}

/**
 * Distinct non-base currencies the HELD quotes are actually in. Read from the
 * quotes (the source of truth) rather than the asset label, which a past import
 * may have force-set to the base currency. Minor-unit codes (e.g. "ZAc") are
 * skipped — they have no Yahoo FX pair. No hardcoded currency list.
 */
async function collectForeignQuoteCurrencies(
  ctx: AddonContext,
  onProgress?: (msg: string) => void,
): Promise<{ base: string; foreign: string[] }> {
  const accounts = await ctx.api.accounts.getAll();
  const holdings: Holding[] = [];
  for (const acc of accounts) {
    holdings.push(...((await ctx.api.portfolio.getHoldings(acc.id)) as Holding[]));
  }
  const base = holdings.find((h) => h.baseCurrency)?.baseCurrency ?? "EUR";

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const h of holdings) {
    const id = h.instrument?.id;
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  const foreign = new Set<string>();
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      const ccy = await quoteCurrencyOf(ctx, ids[cursor++]);
      if (ccy && ccy !== base && /^[A-Z]{3}$/.test(ccy)) foreign.add(ccy);
    }
  }
  onProgress?.("Analysing quote currencies…");
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));
  return { base, foreign: [...foreign].sort() };
}

/**
 * Create the missing `FX:<ccy>/<base>` pairs (source YAHOO, ECB-seeded) for the
 * currencies the held quotes are in, then sync + recalculate.
 */
export async function ensureEurFxPairs(
  ctx: AddonContext,
  onProgress?: (msg: string) => void,
): Promise<FxPairResult> {
  const { base, foreign } = await collectForeignQuoteCurrencies(ctx, onProgress);
  const result: FxPairResult = {
    base,
    currencies: foreign,
    created: [],
    skipped: [],
    failed: [],
    synced: false,
    recalculated: false,
  };
  if (!base) throw new Error("Could not determine the base currency.");

  const existing = new Set(
    ((await ctx.api.exchangeRates.getAll()) as ExchangeRate[]).map(
      (r) => `${r.fromCurrency}→${r.toCurrency}`,
    ),
  );

  for (const ccy of foreign) {
    const pair = `${ccy}→${base}`;
    if (existing.has(pair)) {
      result.skipped.push(pair);
      continue;
    }
    try {
      onProgress?.(`Creating ${pair}…`);
      const rate = await fetchEcbRate(ccy, base);
      await ctx.api.exchangeRates.add({
        fromCurrency: ccy,
        toCurrency: base,
        rate,
        source: FX_SOURCE,
        timestamp: new Date().toISOString(),
      });
      result.created.push(pair);
    } catch (e) {
      result.failed.push({ pair, reason: (e as Error).message });
    }
  }

  // The core converts quote→holding currency once the FX pair exists. Sync so
  // Yahoo fills the daily rate, then recalculate so the valuations update.
  onProgress?.("Syncing and recalculating…");
  try {
    await ctx.api.market.syncHistory();
    result.synced = true;
  } catch (e) {
    ctx.api.logger.warn(`[TR fx] syncHistory failed: ${(e as Error).message}`);
  }
  try {
    await ctx.api.portfolio.recalculate();
    result.recalculated = true;
  } catch (e) {
    ctx.api.logger.warn(`[TR fx] recalculate failed: ${(e as Error).message}`);
  }

  return result;
}
