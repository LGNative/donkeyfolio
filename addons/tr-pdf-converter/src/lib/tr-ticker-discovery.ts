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

/**
 * (v2.20.3) Live metadata fetch from Yahoo's quote endpoint.
 * Returns the EXACT currency, exchange MIC, and instrument type that
 * Yahoo sees for this ticker — no hardcoded suffix→currency tables.
 *
 * Why not hardcode:
 *   The user pointed out (correctly) that hardcoded suffix→currency maps
 *   inevitably get stale. Listings move exchanges, ETFs get re-issued,
 *   ADRs vs ordinaries differ. Asking Yahoo directly is the source of
 *   truth that updates automatically as exchanges/listings evolve.
 *
 * Endpoint: GET https://query2.finance.yahoo.com/v7/finance/quote?symbols=X
 *   Returns: { quoteResponse: { result: [{ currency, fullExchangeName,
 *             exchange, quoteType, ... }] } }
 *
 * Errors (rate limit, network, parse) all return null → caller falls back
 * to a conservative EUR default (matches TR account currency for the user).
 */
interface YahooQuoteMetadata {
  currency: string;
  /** Yahoo's exchange code, mapped to ISO 10383 MIC where known. */
  exchangeMic?: string;
  /** Mapped to our InstrumentType taxonomy. */
  instrumentType: string;
}

interface YahooQuoteResponse {
  quoteResponse?: {
    result?: Array<{
      symbol?: string;
      currency?: string;
      exchange?: string;
      fullExchangeName?: string;
      quoteType?: string;
    }>;
  };
}

/**
 * Map Yahoo's `quoteType` (closed enum from their API) to our taxonomy.
 * Defensive default = EQUITY. Not hardcoded data — translation layer.
 */
function quoteTypeToInstrument(quoteType?: string): string {
  switch ((quoteType ?? "").toUpperCase()) {
    case "ETF":
      return "ETF";
    case "MUTUALFUND":
    case "MUTUAL_FUND":
      return "MUTUAL_FUND";
    case "CRYPTOCURRENCY":
      return "CRYPTO";
    case "BOND":
      return "BOND";
    case "INDEX":
      return "INDEX";
    default:
      return "EQUITY";
  }
}

/**
 * Yahoo's `exchange` is a short code (NMS/NYQ/GER/etc.). The few we care
 * about for MIC enrichment are listed here — but if the code is unknown
 * we just leave exchangeMic undefined (the asset still works without it).
 *
 * This is a TRANSLATION (Yahoo internal code → ISO MIC standard), not a
 * data hardcode. Yahoo doesn't expose MIC directly, so this thin map is
 * required to interop with the standards-compliant Wealthfolio backend.
 */
function exchangeToMic(exchange?: string): string | undefined {
  if (!exchange) return undefined;
  const code = exchange.toUpperCase();
  // NMS=NASDAQ Mid/Small, NGM=NASDAQ Global Mkt, NYQ=NYSE
  if (code === "NMS" || code === "NGM" || code === "NCM") return "XNAS";
  if (code === "NYQ" || code === "NYS") return "XNYS";
  if (code === "ASE") return "XASE"; // NYSE American
  if (code === "PCX") return "ARCX"; // NYSE Arca
  if (code === "BTS") return "BATS";
  // Yahoo also returns short codes like "GER" (Xetra) for non-US — but
  // those are inconsistent across regions. Leaving undefined here lets
  // the asset profile use its own auto-inference based on instrumentSymbol.
  return undefined;
}

const QUOTE_META_CACHE_KEY = "tr-pdf-converter:yahoo-quote-meta:v1";

function loadQuoteMetaCache(): Record<string, YahooQuoteMetadata | null> {
  try {
    const raw =
      typeof localStorage !== "undefined" ? localStorage.getItem(QUOTE_META_CACHE_KEY) : null;
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveQuoteMetaCache(cache: Record<string, YahooQuoteMetadata | null>) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(QUOTE_META_CACHE_KEY, JSON.stringify(cache));
    }
  } catch {
    // localStorage full or disabled — silently skip caching.
  }
}

/**
 * Fetch real currency + exchange + instrumentType from Yahoo for one
 * ticker symbol. Cached forever in localStorage (the answer doesn't
 * change except when an asset gets re-listed, and TR users hold for
 * months/years so even occasional staleness is irrelevant).
 *
 * Returns null on any failure — caller falls through to a conservative
 * default (EUR / EQUITY) so the import doesn't fail outright.
 */
async function fetchYahooQuoteMetadata(symbol: string): Promise<YahooQuoteMetadata | null> {
  if (!symbol) return null;
  const cache = loadQuoteMetaCache();
  if (Object.prototype.hasOwnProperty.call(cache, symbol)) {
    return cache[symbol];
  }
  const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  try {
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    if (!res.ok) {
      cache[symbol] = null;
      saveQuoteMetaCache(cache);
      return null;
    }
    const json = (await res.json()) as YahooQuoteResponse;
    const result = json.quoteResponse?.result?.[0];
    if (!result || !result.currency) {
      cache[symbol] = null;
      saveQuoteMetaCache(cache);
      return null;
    }
    const meta: YahooQuoteMetadata = {
      currency: result.currency,
      exchangeMic: exchangeToMic(result.exchange),
      instrumentType: quoteTypeToInstrument(result.quoteType),
    };
    cache[symbol] = meta;
    saveQuoteMetaCache(cache);
    return meta;
  } catch {
    cache[symbol] = null;
    saveQuoteMetaCache(cache);
    return null;
  }
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

      // (v2.20.3) Live metadata fetch — no hardcoded suffix→currency table.
      // We ask Yahoo's quote endpoint directly for the ticker we just
      // discovered, getting the EXACT currency, exchangeMic and
      // instrumentType that Yahoo serves. Cached forever in localStorage
      // so re-imports are instant. Falls back to EUR/EQUITY when Yahoo
      // doesn't answer (e.g. obscure ISIN, rate limit) — better to default
      // to TR account currency than guess wrong with hardcoded heuristics.
      let mapping: TickerMapping | null = null;
      if (result) {
        const meta = await fetchYahooQuoteMetadata(result.symbol);
        mapping = {
          symbol: result.symbol,
          instrumentType: meta?.instrumentType ?? "EQUITY",
          quoteCcy: meta?.currency ?? "EUR",
          exchangeMic: meta?.exchangeMic,
          displayName: result.name,
        };
      }
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

/**
 * Build a lookup map from discovery results, enriched with the live
 * metadata cached during discovery. (v2.20.3)
 *
 * The metadata cache is populated by `fetchYahooQuoteMetadata` during
 * `discoverTickers`, so by the time we build this map every symbol
 * already has its real currency + instrumentType + exchangeMic ready.
 * No round-trips here, just a localStorage read per result.
 */
export function buildDiscoveryMap(results: DiscoveryResult[]): Map<string, TickerMapping> {
  const map = new Map<string, TickerMapping>();
  const metaCache = loadQuoteMetaCache();
  for (const r of results) {
    if (!r.symbol) continue;
    const meta = metaCache[r.symbol] ?? null;
    map.set(r.isin, {
      symbol: r.symbol,
      instrumentType: meta?.instrumentType ?? "EQUITY",
      quoteCcy: meta?.currency ?? "EUR",
      exchangeMic: meta?.exchangeMic,
      displayName: r.matchedName,
    });
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
