/**
 * Stock-split detection via Yahoo Finance.
 *
 * Why this matters for TR statements:
 *   Trade Republic emits trades with the QUANTITY and PRICE that were valid at
 *   trade time. If a stock splits 2:1 after you bought it, your TR app shows
 *   the post-split holding (2× shares at half the price), but every BUY/SELL
 *   in the historical PDF is still recorded at PRE-split values. When we
 *   import those into Donkeyfolio without knowing about the split, the
 *   resulting holdings quantity will be HALF of reality.
 *
 *   ServiceNow (NOW) is the canonical example in the user's data: 10.55 shares
 *   in DB after import, 21.56 shares in TR app — confirmed 2:1 split.
 *
 * What we do here:
 *   1. For every position with mapped Yahoo ticker AND at least one trade
 *      before today, hit Yahoo's chart API with `events=splits`.
 *   2. Yahoo returns a `splits` map keyed by event timestamp; each entry has
 *      `numerator` / `denominator` (e.g. {numerator: 2, denominator: 1} = 2:1).
 *   3. Filter to splits that fall AFTER any trade in the position's history —
 *      those are the ones the user's holdings need adjusted for.
 *   4. Surface them in the UI so the user can either acknowledge (already
 *      reflected in TR's quantity) or generate a SPLIT activity.
 *
 * Network behaviour:
 *   - Calls go to `query1.finance.yahoo.com` (no API key needed, public CORS).
 *   - We batch sequentially with a 500ms gap to avoid rate-limits on large
 *     portfolios. Total wall-clock for ~150 mapped positions: ~75s, but in
 *     practice splits only happen on a handful of stocks per year so we cap
 *     the lookup range to a 5-year window.
 *   - All calls are best-effort — any error (network, parse, rate-limit)
 *     yields `null` for that ticker and the UI shows "couldn't check N".
 */
import { lookupTicker } from "./tr-isin-tickers";
import type { TradingTransaction } from "./tr-parser";

export interface SplitEvent {
  /** ISIN of the affected security. */
  isin: string;
  /** Mapped Yahoo ticker we used to query (e.g. "NOW", "AAPL"). */
  ticker: string;
  /** Stock display name (best effort from trade data). */
  stockName: string;
  /** WKN of the affected security, if known (helps user verify identity). */
  wkn?: string;
  /** Date of the split (ISO yyyy-MM-dd). */
  date: string;
  /** Yahoo's numerator (e.g. 2 for a 2-for-1). */
  numerator: number;
  /** Yahoo's denominator (e.g. 1 for a 2-for-1). */
  denominator: number;
  /** Pretty ratio string like "2:1" or "3:2". */
  ratio: string;
  /** Raw multiplier (numerator/denominator) — qty post-split = qty × ratioMul. */
  ratioMul: number;
  /** Earliest trade date for this position (ISO date). The split needs adjusting
   *  only if it happened AFTER this date. */
  firstTradeDate: string;
}

export interface SplitDetectionResult {
  splits: SplitEvent[];
  /** Number of positions we attempted to check (had a Yahoo ticker mapping). */
  checked: number;
  /** Number of positions we couldn't query (network errors, no ticker, etc.). */
  errors: number;
  /** Number of positions skipped (no trade history, crypto, cash). */
  skipped: number;
}

interface YahooChartResponse {
  chart: {
    result?: Array<{
      events?: {
        splits?: Record<
          string,
          {
            date: number;
            numerator: number;
            denominator: number;
            splitRatio: string;
          }
        >;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
}

const MS_PER_DAY = 86_400_000;
const FIVE_YEARS_DAYS = 5 * 365;

function toEpochSec(isoDate: string): number {
  const t = new Date(isoDate).getTime();
  return Math.floor(t / 1000);
}

function isoDate(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

function parseTradeDate(s: string): number {
  // Re-uses the same date heuristics as tr-parser. Returns epoch ms or NaN.
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

async function fetchYahooSplits(
  ticker: string,
  fromEpochSec: number,
  toEpochSec: number,
): Promise<YahooChartResponse | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${fromEpochSec}&period2=${toEpochSec}&interval=1d&events=splits`;
  try {
    const res = await fetch(url, {
      // Yahoo's chart endpoint allows anonymous CORS for the chart sub-path.
      // No credentials, no cache → fresh data every time we run a detection
      // (the user runs this once per import, so caching savings would be
      // marginal anyway).
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as YahooChartResponse;
    if (json.chart?.error) return null;
    return json;
  } catch {
    return null;
  }
}

function ratioPretty(num: number, den: number): string {
  // Reduce to coprime if possible (most TR-relevant splits are already simple).
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(Math.abs(num), Math.abs(den)) || 1;
  return `${num / g}:${den / g}`;
}

/**
 * Detect splits that happened after each position's first trade.
 *
 * @param trading All trades from the parsed PDF.
 * @param onProgress Optional callback `(checked, total) => void` so the UI can
 *   show a progress bar (network step is the long part).
 */
export async function detectSplitsForPositions(
  trading: TradingTransaction[],
  onProgress?: (checked: number, total: number) => void,
): Promise<SplitDetectionResult> {
  // Group trades by ISIN to find each position's first-trade date.
  const byIsin = new Map<string, { firstTradeMs: number; stockName: string; wkn?: string }>();
  for (const t of trading) {
    if (!t.isin || !t.date) continue;
    const ms = parseTradeDate(t.date);
    if (!Number.isFinite(ms)) continue;
    const cur = byIsin.get(t.isin);
    if (!cur || ms < cur.firstTradeMs) {
      byIsin.set(t.isin, {
        firstTradeMs: ms,
        stockName: t.cleanStockName || t.stockName,
        wkn: t.wkn,
      });
    } else if (cur && t.wkn && !cur.wkn) {
      cur.wkn = t.wkn;
    }
  }

  // Bound the lookup window: from `min(firstTrade, today - 5 years)` to today.
  const todayEpoch = Math.floor(Date.now() / 1000);
  const fiveYearsAgoEpoch = todayEpoch - FIVE_YEARS_DAYS * 86_400;

  const splits: SplitEvent[] = [];
  let checked = 0;
  let errors = 0;
  let skipped = 0;
  let totalToCheck = 0;

  // First pass — count what we'll actually try.
  for (const [isin] of byIsin) {
    const mapped = lookupTicker(isin);
    if (mapped && mapped.instrumentType !== "CRYPTO") totalToCheck += 1;
  }

  for (const [isin, info] of byIsin) {
    const mapped = lookupTicker(isin);
    if (!mapped || mapped.instrumentType === "CRYPTO") {
      skipped += 1;
      continue;
    }

    const fromEpoch = Math.max(
      Math.floor(info.firstTradeMs / 1000) - MS_PER_DAY * 7,
      fiveYearsAgoEpoch,
    );
    const resp = await fetchYahooSplits(mapped.symbol, fromEpoch, todayEpoch);
    checked += 1;
    onProgress?.(checked, totalToCheck);

    if (!resp) {
      errors += 1;
      // Polite delay between calls — Yahoo throttles bursts, especially when
      // we're going through ~100 tickers in quick succession.
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    const splitMap = resp.chart.result?.[0]?.events?.splits;
    if (splitMap) {
      for (const ev of Object.values(splitMap)) {
        const splitMs = ev.date * 1000;
        // Only flag splits that happened AFTER the user's first trade — earlier
        // splits don't affect anything we're importing.
        if (splitMs > info.firstTradeMs && ev.numerator && ev.denominator) {
          splits.push({
            isin,
            ticker: mapped.symbol,
            stockName: info.stockName,
            wkn: info.wkn,
            date: isoDate(ev.date),
            numerator: ev.numerator,
            denominator: ev.denominator,
            ratio: ev.splitRatio || ratioPretty(ev.numerator, ev.denominator),
            ratioMul: ev.numerator / ev.denominator,
            firstTradeDate: new Date(info.firstTradeMs).toISOString().slice(0, 10),
          });
        }
      }
    }

    // Pace ourselves between calls.
    await new Promise((r) => setTimeout(r, 300));
  }

  // Sort splits by date descending (most recent first — usually what the user
  // wants to see at the top of the report).
  splits.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { splits, checked, errors, skipped };
}

// Re-export for tests / external consumers; harmless if unused.
export { toEpochSec };
