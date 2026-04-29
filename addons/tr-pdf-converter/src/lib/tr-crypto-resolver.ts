/**
 * Crypto direct-buy quantity resolver. (v2.9)
 *
 * Background:
 *   TR statements list crypto trades in two flavours:
 *
 *     1. Savings plan:  "Savings plan execution XF000BTC0017 Bitcoin,
 *                        quantity: 0.000131"
 *        — qty is right there inline; our parser handles these fine.
 *
 *     2. Direct buy:    "Execução Compra direta XF000BTC0017 C1012834545"
 *        — order ID instead of quantity. The PDF DOES NOT include the
 *        qty for these rows, only the cash amount and saldo.
 *
 *   On a real user's statement we found 24 BTC direct buys, plus similar
 *   counts for ETH/SOL/ADA/XRP — totalling ~€4,500 of crypto value that
 *   never imported because the addon couldn't infer qty from the PDF.
 *
 * Strategy:
 *   For each direct-buy crypto trade (XF000... ISIN, qty undefined),
 *   look up the asset's price on the trade date from Yahoo Finance
 *   (BTC-EUR, ETH-EUR, etc.) and compute qty = amount / price.
 *
 *   We batch by ticker: one Yahoo chart-API call per crypto covering
 *   the full date range of all direct buys for that crypto. Yahoo's
 *   chart endpoint returns a daily timeseries; we build a {date→price}
 *   map and resolve each trade against it.
 *
 *   Network footprint: 1 API call per crypto (typically 5 tickers
 *   total = 5 calls, ~2 seconds added to import).
 *
 * Caveats:
 *   - Yahoo's daily price is the CLOSE — actual trade execution price
 *     may differ by spread/slippage (typically <0.5%). Acceptable
 *     reconstruction error.
 *   - If Yahoo doesn't have a price for the trade date (weekend for
 *     non-crypto, but crypto trades 24/7 so this rarely happens),
 *     we fall back to the nearest preceding close.
 *   - Best-effort: any network/parse failure leaves qty undefined and
 *     the trade still imports as a cash flow (no shares added).
 */
import type { CashTransaction, TradingTransaction } from "./tr-parser";

/** German "1.234,56 €" → 1234.56. Tolerant of EN format too. */
function parseAmount(s: string | undefined): number {
  if (!s) return 0;
  const cleaned = String(s).replace(/[^\d,.\-]/g, "");
  // If both . and , present, the LAST one is the decimal separator.
  if (cleaned.includes(",") && cleaned.includes(".")) {
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) {
      return parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
    }
    return parseFloat(cleaned.replace(/,/g, ""));
  }
  if (cleaned.includes(",")) return parseFloat(cleaned.replace(",", "."));
  return parseFloat(cleaned);
}

/** TR pseudo-ISIN → Yahoo Finance ticker. Mirrors the entries in the
 *  CRYPTO map in tr-isin-tickers.ts but kept independent here so the
 *  resolver can run before the activity-builder phase.
 *
 *  (v2.10.1) Verified against a real user's TR statement: SOL/ADA/XRP
 *  pseudo-ISINs in v2.9 were INCORRECT — TR uses the codes below.
 *  Wrong codes meant 18 SOL + 19 ADA + 14 XRP direct buys (~€4,469)
 *  silently flowed through as WITHDRAWAL instead of BUY. */
const CRYPTO_PSEUDO_TO_YAHOO: Record<string, string> = {
  XF000BTC0017: "BTC-EUR",
  XF000ETH0019: "ETH-EUR",
  XF000SOL0012: "SOL-EUR", // was 0027 in v2.9 (wrong)
  XF000ADA0018: "ADA-EUR", // was 0021 in v2.9 (wrong)
  XF000XRP0018: "XRP-EUR", // was 0028 in v2.9 (wrong)
  XF000DOT0024: "DOT-EUR",
  XF000DOG0026: "DOGE-EUR",
  XF000LTC0031: "LTC-EUR",
  // Defensive: keep the old (wrong) codes as fallback in case some
  // older TR statements use them. Yahoo will fail-noop if not real.
  XF000SOL0027: "SOL-EUR",
  XF000ADA0021: "ADA-EUR",
  XF000XRP0028: "XRP-EUR",
};

interface YahooChartTimeseries {
  chart: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ close?: (number | null)[] }>;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
}

const MS_PER_DAY = 86_400_000;

function parseTradeDateMs(s: string): number {
  if (!s) return NaN;
  const dot = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s.trim());
  if (dot) return new Date(+dot[3], +dot[2] - 1, +dot[1]).getTime();
  const months: Record<string, number> = {
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
  const mon = /^(\d{1,2})\s+([A-Za-zçÇ]{3,})\.?\s+(\d{4})$/.exec(s.trim());
  if (mon) {
    const m = months[mon[2].slice(0, 3).toLowerCase()];
    if (m !== undefined) return new Date(+mon[3], m, +mon[1]).getTime();
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]).getTime();
  return NaN;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchYahooDailyCloses(
  ticker: string,
  fromMs: number,
  toMs: number,
): Promise<Map<string, number> | null> {
  // Pad ±5 days so we always have nearest-preceding fallback data.
  const fromSec = Math.floor((fromMs - 5 * MS_PER_DAY) / 1000);
  const toSec = Math.floor((toMs + 5 * MS_PER_DAY) / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${fromSec}&period2=${toSec}&interval=1d`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as YahooChartTimeseries;
    if (json.chart?.error) return null;
    const result = json.chart?.result?.[0];
    if (!result?.timestamp || !result.indicators?.quote?.[0]?.close) return null;
    const map = new Map<string, number>();
    const ts = result.timestamp;
    const closes = result.indicators.quote[0].close;
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === "number" && Number.isFinite(c) && c > 0) {
        map.set(isoDate(ts[i] * 1000), c);
      }
    }
    return map;
  } catch {
    return null;
  }
}

/** Find the closing price on `date`. Fall back to nearest preceding
 *  close (within 5 days) when the exact date is missing. */
function priceOnOrBefore(prices: Map<string, number>, dateIso: string): number | null {
  if (prices.has(dateIso)) return prices.get(dateIso)!;
  // Walk back up to 5 days for a fallback close.
  for (let i = 1; i <= 5; i++) {
    const d = new Date(dateIso);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (prices.has(key)) return prices.get(key)!;
  }
  return null;
}

export interface ResolverResult {
  /** Trades with quantity now filled in. Trades that already had quantity
   *  pass through unchanged. */
  trading: TradingTransaction[];
  /** Number of crypto direct buys we successfully resolved. */
  resolved: number;
  /** Number of crypto direct buys we could NOT resolve (network error,
   *  no price for date, etc.). They keep quantity=undefined. */
  failed: number;
}

/**
 * Resolve qty for crypto direct-buy trades by fetching daily prices
 * from Yahoo and computing qty = amount / price.
 *
 * Idempotent: trades with qty already set are passed through unchanged.
 * Best-effort: returns the input array unmodified on any catastrophic
 * failure rather than throwing.
 */
/**
 * Minimal subset of the addon SDK we need to read cached crypto quotes from
 * Donkeyfolio's local DB. Inlined as `unknown`-typed to avoid pulling SDK
 * type-deps into this pure module.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SdkLike = any;

/**
 * (v2.13.0) Build {date → close price} map from Donkeyfolio's cached quotes
 * for the symbols we know map to a crypto pseudo-ISIN. Falls back to Yahoo
 * only when the cache is empty or the symbol isn't in DB.
 *
 * Why: Yahoo's chart endpoint is rate-limited (HTTP 429). On any active
 * import session we may already have ETH-EUR / BTC-EUR / SOL-EUR data in
 * Donkeyfolio's quotes table from earlier market.syncHistory() runs.
 * Reading those is instant + offline + zero rate-limit risk.
 */
async function loadCachedCryptoPrices(
  ctxLike: SdkLike | undefined,
  yahooTickers: string[],
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!ctxLike?.api?.assets?.getAll || !ctxLike?.api?.quotes?.getHistory) {
    return out;
  }
  try {
    const assets: Array<{ id: string; symbol?: string; name?: string }> =
      await ctxLike.api.assets.getAll();
    // Donkeyfolio's crypto assets store the bare ticker ("BTC") not the
    // Yahoo-style "BTC-EUR". Strip "-EUR" / "-USD" before matching.
    const symbolToTicker = new Map<string, string>();
    for (const ticker of yahooTickers) {
      const stripped = ticker.replace(/-(EUR|USD|USDT)$/i, "");
      symbolToTicker.set(stripped.toUpperCase(), ticker);
    }
    for (const a of assets) {
      const sym = (a.symbol || "").toUpperCase();
      const ticker = symbolToTicker.get(sym);
      if (!ticker) continue;
      try {
        const quotes: Array<{ day?: string; close?: number | string }> =
          await ctxLike.api.quotes.getHistory(a.id);
        if (!quotes?.length) continue;
        const map = new Map<string, number>();
        for (const q of quotes) {
          if (!q.day) continue;
          const c = typeof q.close === "string" ? parseFloat(q.close) : q.close;
          if (typeof c === "number" && Number.isFinite(c) && c > 0) {
            map.set(String(q.day).slice(0, 10), c);
          }
        }
        if (map.size > 0) out.set(ticker, map);
      } catch {
        // Per-asset failures don't break the rest.
      }
    }
  } catch {
    // SDK-level failure → silently fall through to Yahoo.
  }
  return out;
}

export async function resolveCryptoDirectBuys(
  trading: TradingTransaction[],
  onProgress?: (done: number, total: number) => void,
  ctxLike?: SdkLike,
): Promise<ResolverResult> {
  // Bucket trades-needing-resolve by Yahoo ticker.
  const buckets = new Map<string, TradingTransaction[]>();
  for (const t of trading) {
    if (!t.isin || !t.isin.startsWith("XF000")) continue;
    if (t.quantity && t.quantity > 0) continue;
    const yahoo = CRYPTO_PSEUDO_TO_YAHOO[t.isin];
    if (!yahoo) continue;
    const arr = buckets.get(yahoo) ?? [];
    arr.push(t);
    buckets.set(yahoo, arr);
  }

  if (buckets.size === 0) return { trading, resolved: 0, failed: 0 };

  // (v2.13.0) Try cached quotes from Donkeyfolio's quotes table FIRST.
  // Yahoo rate-limits aggressively (HTTP 429) on the chart endpoint after
  // a few dozen requests. Donkeyfolio's market.syncHistory() already pulled
  // BTC-EUR / ETH-EUR / SOL-EUR / ADA-EUR / XRP-EUR daily closes via its
  // own internal throttler — using those is faster, offline, and immune.
  const tickerList = [...buckets.keys()];
  const priceMaps = await loadCachedCryptoPrices(ctxLike, tickerList);
  const cachedTickers = new Set(priceMaps.keys());

  // Hit Yahoo only for tickers that aren't in the local cache.
  const tickersNeedingYahoo = tickerList.filter((t) => !cachedTickers.has(t));
  type FetchResult = { ticker: string; prices: Map<string, number> | null };
  if (tickersNeedingYahoo.length > 0) {
    const fetches = await Promise.all<FetchResult>(
      tickersNeedingYahoo.map(async (ticker) => {
        const ts = buckets.get(ticker) || [];
        const dateMs = ts.map((t) => parseTradeDateMs(t.date)).filter(Number.isFinite);
        if (dateMs.length === 0) return { ticker, prices: null };
        const fromMs = Math.min(...dateMs);
        const toMs = Math.max(...dateMs);
        const prices = await fetchYahooDailyCloses(ticker, fromMs, toMs);
        return { ticker, prices };
      }),
    );
    for (const f of fetches) {
      if (f.prices) priceMaps.set(f.ticker, f.prices);
    }
  }

  // Resolve each trade and produce a fresh trading array (non-mutating).
  let resolved = 0;
  let failed = 0;
  let processed = 0;
  const totalToResolve = [...buckets.values()].reduce((s, a) => s + a.length, 0);

  const fixed = trading.map((t) => {
    if (!t.isin || !t.isin.startsWith("XF000")) return t;
    if (t.quantity && t.quantity > 0) return t;
    const yahoo = CRYPTO_PSEUDO_TO_YAHOO[t.isin];
    if (!yahoo) return t;
    const prices = priceMaps.get(yahoo);
    if (!prices) {
      failed += 1;
      processed += 1;
      onProgress?.(processed, totalToResolve);
      return t;
    }
    const dateMs = parseTradeDateMs(t.date);
    if (!Number.isFinite(dateMs)) {
      failed += 1;
      processed += 1;
      onProgress?.(processed, totalToResolve);
      return t;
    }
    const price = priceOnOrBefore(prices, isoDate(dateMs));
    if (!price || price <= 0) {
      failed += 1;
      processed += 1;
      onProgress?.(processed, totalToResolve);
      return t;
    }
    const cashAmount = Math.abs(t.amount);
    if (cashAmount <= 0) {
      failed += 1;
      processed += 1;
      onProgress?.(processed, totalToResolve);
      return t;
    }
    const qty = cashAmount / price;
    resolved += 1;
    processed += 1;
    onProgress?.(processed, totalToResolve);
    return {
      ...t,
      quantity: qty,
      unitPrice: price,
    };
  });

  return { trading: fixed, resolved, failed };
}

/**
 * (v2.10.1) Scan cash[] for crypto direct-buy rows that were never picked
 * up by the trading-section parser. Build synthetic TradingTransactions so
 * the standard resolver can fill in qty + the activity-builder can emit
 * BUYs (instead of leaving them as WITHDRAWAL cash legs).
 *
 * Detection rule: row description contains an XF000* pseudo-ISIN AND has
 * a non-zero `zahlungsausgang` (cash out). We DON'T require "Compra
 * direta" / "direct buy" / etc. text because TR localises differently per
 * user — the pseudo-ISIN + outflow is sufficient signal.
 *
 * Returned `skipKeys` are the same `${date}|${isin}` keys that
 * tr-to-activities.ts already uses to skip cash legs of trades. Adding
 * these to the upstream skipCashKeys set prevents the cash-side
 * WITHDRAWAL from being created in parallel with the new BUY.
 */
export function extractCryptoDirectBuysFromCash(cash: CashTransaction[]): {
  cryptoTrading: TradingTransaction[];
  skipKeys: Set<string>;
} {
  const cryptoTrading: TradingTransaction[] = [];
  const skipKeys = new Set<string>();
  for (const c of cash) {
    if (!c.beschreibung) continue;
    const m = c.beschreibung.match(/\b(XF000[A-Z0-9]{6,7})\b/);
    if (!m) continue;
    const isin = m[1];
    if (!CRYPTO_PSEUDO_TO_YAHOO[isin]) continue;
    const out = parseAmount(c.zahlungsausgang);
    if (out <= 0) continue;
    const tradeIdMatch = c.beschreibung.match(/\b(C\d{8,})\b/);
    cryptoTrading.push({
      date: c.datum,
      isin,
      stockName: c.beschreibung.slice(0, 200),
      action: "Buy",
      isBuy: true,
      amount: out,
      tradeId: tradeIdMatch ? tradeIdMatch[1] : "",
      balance: c.saldo || "",
      // qty undefined → resolver will fill via Yahoo price.
      cleanStockName: c.beschreibung
        .replace(/Execução\s+Compra\s+direta\s+/i, "")
        .replace(/Direct\s+buy\s+/i, "")
        .replace(/\bC\d{8,}\b/, "")
        .replace(/\b(XF000[A-Z0-9]{6,7})\b/, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80),
    });
    skipKeys.add(`${c.datum}|${isin}`);
  }
  return { cryptoTrading, skipKeys };
}
