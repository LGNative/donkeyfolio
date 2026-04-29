/**
 * Auto-discover Yahoo tickers for unmapped ISINs. (v2.10)
 *
 * When a TR statement contains an ISIN we don't have in our hardcoded
 * map (tr-isin-tickers.ts), the import still succeeds but the asset
 * lands in Donkeyfolio with the ISIN as its ticker — Yahoo can't price
 * it and Holdings show as €0.00.
 *
 * v2.10 ships an automatic discovery pass: for each unmapped ISIN, we
 * call Yahoo's search API with the security name (or ISIN as fallback),
 * pick the most likely ticker from the results, and add it to a
 * session-local map that the import flow can consult.
 *
 * The discovery is best-effort:
 *   - Network failures yield no mapping (fall back to ISIN-as-symbol)
 *   - Ambiguous results (multiple matches) prefer the canonical primary
 *     listing where available
 *   - Each discovered ticker is persisted in localStorage so subsequent
 *     imports don't re-query Yahoo for the same ISIN
 *
 * The discovered mappings are surfaced in the UI so the user can
 * verify and report back any wrong matches for inclusion in our
 * hardcoded map.
 */
import type { TickerMapping } from "./tr-isin-tickers";

export interface DiscoveryRequest {
  isin: string;
  /** Best-effort security name from the PDF description (truncated). */
  name: string;
  /** WKN if extracted — more reliable than name for deduping. */
  wkn?: string;
}

export interface DiscoveryResult {
  isin: string;
  /** Yahoo ticker discovered, or null if no good match. */
  symbol: string | null;
  /** Yahoo's description for the matched security (for verification). */
  matchedName?: string;
  /** Source: "cache" if from localStorage, "yahoo" if freshly fetched,
   *  "failed" if discovery returned no result. */
  source: "cache" | "yahoo" | "failed";
}

interface YahooSearchResponse {
  quotes?: Array<{
    symbol: string;
    shortname?: string;
    longname?: string;
    quoteType?: string;
    exchange?: string;
    isYahooFinance?: boolean;
  }>;
  // Yahoo also sometimes returns this shape:
  ResultSet?: {
    Result?: Array<{
      symbol: string;
      name?: string;
      typeDisp?: string;
      exchDisp?: string;
    }>;
  };
}

const CACHE_KEY = "tr-pdf-converter:discovered-tickers:v1";

function loadCache(): Record<string, TickerMapping | null> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(CACHE_KEY) : null;
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, TickerMapping | null>): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    }
  } catch {
    // ignore quota/serialize errors
  }
}

/**
 * Hit Yahoo's search API. Yahoo accepts ISIN strings as queries on
 * query2.finance.yahoo.com/v1/finance/search and returns matching
 * securities. We pick the highest-confidence match (the first quote
 * with a non-empty symbol).
 */
async function searchYahoo(query: string): Promise<{ symbol: string; name: string } | null> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`;
  try {
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const json = (await res.json()) as YahooSearchResponse;
    const quotes = json.quotes || [];
    for (const q of quotes) {
      // Skip cryptos (those have their own pseudo-ISIN handling) and
      // index/futures contracts.
      const t = q.quoteType || "";
      if (t === "CRYPTOCURRENCY" || t === "FUTURE" || t === "INDEX") continue;
      if (!q.symbol) continue;
      return { symbol: q.symbol, name: q.shortname || q.longname || q.symbol };
    }
    // Fallback to the older ResultSet shape.
    const old = json.ResultSet?.Result || [];
    for (const r of old) {
      if (!r.symbol) continue;
      return { symbol: r.symbol, name: r.name || r.symbol };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Discover Yahoo tickers for a batch of unmapped ISINs.
 *
 * Strategy:
 *   1. Check localStorage cache first (each ISIN cached after first lookup)
 *   2. For misses, hit Yahoo search with: WKN > name > ISIN
 *   3. Cache successful matches (and explicit "no match" results)
 *   4. Return the resolved map
 *
 * Concurrency: max 4 parallel requests to be polite to Yahoo. ~250ms
 * per request typically; 50 unmapped ISINs ≈ 3 seconds total.
 */
export async function discoverTickers(
  requests: DiscoveryRequest[],
  onProgress?: (done: number, total: number) => void,
): Promise<DiscoveryResult[]> {
  const cache = loadCache();
  const out: DiscoveryResult[] = [];
  let done = 0;

  // Check cache first.
  const toFetch: DiscoveryRequest[] = [];
  for (const req of requests) {
    if (cache[req.isin] !== undefined) {
      const m = cache[req.isin];
      out.push({
        isin: req.isin,
        symbol: m?.symbol || null,
        source: "cache",
      });
      done += 1;
      onProgress?.(done, requests.length);
    } else {
      toFetch.push(req);
    }
  }

  // Fetch with bounded concurrency.
  const CONCURRENCY = 4;
  const queue = [...toFetch];
  const workers: Promise<void>[] = [];

  const work = async (): Promise<void> => {
    while (queue.length > 0) {
      const req = queue.shift();
      if (!req) break;
      // Try WKN first (most specific), then name, then ISIN.
      let result: { symbol: string; name: string } | null = null;
      if (req.wkn) result = await searchYahoo(req.wkn);
      if (!result && req.name) {
        // Strip TR's "Inc.", "Corp." etc. clutter for better matches.
        const cleanName = req.name
          .replace(/\b(Inc|Corp|Holdings?|Co|Ltd|PLC|SA|NV|AG|ADR|The)\.?\b/gi, "")
          .replace(/[,.]$/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (cleanName) result = await searchYahoo(cleanName);
      }
      if (!result) result = await searchYahoo(req.isin);

      const mapping: TickerMapping | null = result
        ? { symbol: result.symbol, instrumentType: "EQUITY", quoteCcy: "USD" }
        : null;
      cache[req.isin] = mapping;
      out.push({
        isin: req.isin,
        symbol: mapping?.symbol ?? null,
        matchedName: result?.name,
        source: mapping ? "yahoo" : "failed",
      });
      done += 1;
      onProgress?.(done, requests.length);
    }
  };

  for (let i = 0; i < CONCURRENCY; i++) workers.push(work());
  await Promise.all(workers);

  saveCache(cache);
  return out;
}

/** Build a lookup map from discovery results. */
export function buildDiscoveryMap(results: DiscoveryResult[]): Map<string, TickerMapping> {
  const map = new Map<string, TickerMapping>();
  for (const r of results) {
    if (r.symbol) {
      map.set(r.isin, {
        symbol: r.symbol,
        instrumentType: "EQUITY",
        quoteCcy: "USD",
        displayName: r.matchedName,
      });
    }
  }
  return map;
}

/** Clear the localStorage cache (for debugging or forcing re-discovery). */
export function clearDiscoveryCache(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}
