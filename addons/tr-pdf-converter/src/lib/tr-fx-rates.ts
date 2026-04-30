/**
 * EUR-to-foreign-currency FX rate lookup. (v2.20.0)
 *
 * Why this exists:
 *   TR statements are denominated in EUR, but US-listed equities (MSFT, NVDA,
 *   PYPL, AMD, ...) quote in USD on Yahoo. For Donkeyfolio's holdings
 *   calculator to compute correct cost basis in the asset's quote currency,
 *   each EUR-paid trade needs an `fxRate` field representing the EUR→quoteCcy
 *   exchange rate ON THE TRADE DATE. Without it, Donkeyfolio's USD-quoted
 *   holdings show inflated/deflated cost basis vs the TR app.
 *
 * Why Frankfurter:
 *   - Free, no auth, no rate limit
 *   - Backed by official ECB reference rates (the same rates TR's auditors use)
 *   - Returns daily closes for EVERY business day from 1999 onwards
 *   - Spreads-free (mid-rate, perfect for cost-basis attribution)
 *
 * Why not Yahoo:
 *   - Rate-limits at ~30 requests/min
 *   - Some FX pairs return inverted (USDEUR vs EURUSD)
 *   - Daily close at NY 16:00 ET is later than ECB 14:15 CET, doesn't match
 *     when TR settles trades against ECB rates
 *
 * Caching:
 *   localStorage with 30-day TTL per (ccy, date) tuple. Historical FX never
 *   changes, so 30 days is fine — just bounds memory growth across years of
 *   imports.
 */

const CACHE_PREFIX = "tr-pdf-fx:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Number of parallel Frankfurter requests. Conservative because:
 *   - TR statements can have 4000+ trades across hundreds of unique (ccy, date)
 *     tuples; we don't want to flood ECB.
 *   - Frankfurter is free, no SLA — being polite reduces the chance of an
 *     IP-level rate-limit kicking in.
 */
const FX_PARALLELISM = 4;

interface CachedRate {
  rate: number;
  fetchedAt: number;
}

function cacheKey(ccy: string, date: string) {
  return `${CACHE_PREFIX}${ccy}:${date}`;
}

function readCache(ccy: string, date: string): number | null {
  try {
    const raw = localStorage.getItem(cacheKey(ccy, date));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedRate;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    if (!Number.isFinite(parsed.rate) || parsed.rate <= 0) return null;
    return parsed.rate;
  } catch {
    return null;
  }
}

function writeCache(ccy: string, date: string, rate: number) {
  try {
    localStorage.setItem(
      cacheKey(ccy, date),
      JSON.stringify({ rate, fetchedAt: Date.now() } satisfies CachedRate),
    );
  } catch {
    // localStorage full or disabled — caller falls back to network on next call.
  }
}

/**
 * Fetch a single EUR→ccy rate for an exact date. Frankfurter rolls the date
 * back to the latest available business day automatically (so weekends and
 * holidays return the prior Friday's close).
 *
 * Returns `null` on any network or parse failure — never throws. The
 * downstream effect is `fxRate` stays undefined and Donkeyfolio falls back
 * to whatever rate the market sync has cached (or stores cost basis without
 * FX attribution).
 */
async function fetchSingleRate(ccy: string, date: string): Promise<number | null> {
  const url = `https://api.frankfurter.app/${date}?from=EUR&to=${ccy}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { rates?: Record<string, number> };
    const rate = json.rates?.[ccy];
    if (typeof rate === "number" && rate > 0) return rate;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a batch of (ccy, date) pairs to FX rates with parallelism + cache.
 * Designed for the post-parse phase: gather every distinct lookup needed for
 * an import, hit Frankfurter in parallel batches, hand back a Map.
 *
 * Empty `requests` (e.g. EUR-only portfolio) returns an empty Map without
 * doing any I/O.
 */
export async function resolveFxRates(
  requests: { ccy: string; date: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  // De-duplicate identical (ccy, date) tuples — TR portfolios commonly have
  // 50+ trades on the same day in different USD assets, all sharing the same
  // EURUSD rate.
  const unique = new Map<string, { ccy: string; date: string }>();
  for (const r of requests) {
    if (r.ccy === "EUR" || !r.ccy || !r.date) continue;
    unique.set(`${r.ccy}|${r.date}`, r);
  }
  const queue = Array.from(unique.values());
  const total = queue.length;
  if (total === 0) return result;

  let processed = 0;
  // Serve from cache where possible (synchronously) before any network calls.
  const remaining: typeof queue = [];
  for (const r of queue) {
    const cached = readCache(r.ccy, r.date);
    if (cached !== null) {
      result.set(`${r.ccy}|${r.date}`, cached);
      processed += 1;
      onProgress?.(processed, total);
    } else {
      remaining.push(r);
    }
  }

  // Parallel fetch the rest in chunks of FX_PARALLELISM.
  for (let i = 0; i < remaining.length; i += FX_PARALLELISM) {
    const chunk = remaining.slice(i, i + FX_PARALLELISM);
    const fetched = await Promise.all(chunk.map((r) => fetchSingleRate(r.ccy, r.date)));
    chunk.forEach((r, idx) => {
      const rate = fetched[idx];
      if (rate !== null) {
        result.set(`${r.ccy}|${r.date}`, rate);
        writeCache(r.ccy, r.date, rate);
      }
      processed += 1;
      onProgress?.(processed, total);
    });
  }

  return result;
}

/** Convenience for callers that already have the resolved map. */
export function lookupFxRate(
  rates: Map<string, number>,
  ccy: string,
  date: string,
): number | undefined {
  if (ccy === "EUR") return 1;
  return rates.get(`${ccy}|${date}`);
}
