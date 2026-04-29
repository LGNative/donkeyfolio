/**
 * Self-healing portfolio watcher (v2.12.0).
 *
 * Why this exists:
 *   v2.10.2 / v2.11.0 fix splits and ticker drift at IMPORT time. But Yahoo
 *   records new splits/ticker changes continuously, and TR only emits annual
 *   PDF statements — so the user can't reliably "re-import" to pick those up.
 *   Without a watcher, Donkeyfolio's holdings drift away from reality over
 *   time (e.g. a stock that splits 2:1 on 2026-03-15 leaves the user's qty
 *   at half until they next import a new PDF).
 *
 *   This module is the watcher: a background scanner that runs on addon
 *   load (debounced) and on a daily timer while the page is open. It
 *   surfaces three kinds of pending corrections:
 *
 *     1. NEW SPLIT — a split happened after the last check AND there's no
 *        SPLIT activity for that ISIN+date in the DB. One-click apply.
 *     2. TICKER MIGRATION — Yahoo 404s on a holding's symbol (the ticker
 *        was deprecated). Try ISIN search to find the new symbol. Surfaced
 *        as a SUGGESTION only (we don't auto-rename — too risky).
 *     3. DRIP GAP (optional, off by default) — Yahoo dividend × qty held vs
 *        DIVIDEND/CASH activities in DB. Gap > €5 surfaced as best-effort.
 *
 *   Pure module: no React. Returns `WatcherFindings` for the page to render.
 *
 * Network:
 *   Yahoo `chart` endpoint (events=splits + events=dividends), bounded
 *   concurrency 4, 1 call per ticker per 24h via localStorage cache. For
 *   ~150 holdings the daily check completes in ~10-15s. We never hammer:
 *   if a ticker was checked in the last 24h, we skip the network entirely.
 */
import { lookupTicker, type TickerMapping } from "./tr-isin-tickers";

// ─── Types ────────────────────────────────────────────────────────────

export interface WatcherSettings {
  /** Master switch — disables all background work when false. */
  autoCheckSplits: boolean;
  /** If true, new splits are applied as SPLIT activities without a click. */
  autoApplySplits: boolean;
  /** Surface ticker migrations as suggestions. */
  watchTickerChanges: boolean;
  /** Surface dividend reinvestment gaps. Off by default (noisy). */
  watchDripGaps: boolean;
}

export const DEFAULT_SETTINGS: WatcherSettings = {
  autoCheckSplits: true,
  autoApplySplits: false,
  watchTickerChanges: true,
  watchDripGaps: false,
};

export interface PendingSplit {
  kind: "split";
  isin: string;
  ticker: string;
  name: string;
  /** ISO yyyy-MM-dd. */
  date: string;
  numerator: number;
  denominator: number;
  ratio: string;
  /** Multiplier applied to pre-split qty (e.g. 2 for 2:1, 0.1 for 1:10). */
  ratioMul: number;
  /** Net qty currently held in DB. */
  dbQty: number;
}

export interface PendingTickerMigration {
  kind: "ticker-migration";
  isin: string;
  /** Old ticker (the one in DB, now 404ing). */
  fromTicker: string;
  /** New ticker discovered via Yahoo ISIN search. */
  toTicker: string;
  /** Display name (best-effort). */
  name: string;
}

export interface PendingDripGap {
  kind: "drip-gap";
  isin: string;
  ticker: string;
  name: string;
  /** Dividend ex-date that may have been reinvested. */
  date: string;
  /** Expected DIVIDEND amount (qty × dividend per share). */
  expectedEur: number;
  /** Actual DIVIDEND/CASH amount we found in DB on that date (may be 0). */
  actualEur: number;
  /** Gap = expected − actual (positive = under-counted). */
  gapEur: number;
}

export type PendingCorrection = PendingSplit | PendingTickerMigration | PendingDripGap;

export interface WatcherFindings {
  splits: PendingSplit[];
  tickerMigrations: PendingTickerMigration[];
  dripGaps: PendingDripGap[];
  /** Tickers actually queried this run (i.e. not skipped via 24h cache). */
  checkedTickers: number;
  /** Tickers skipped because lastChecked < 24h ago. */
  skippedFresh: number;
  /** Tickers that errored (Yahoo 404, parse error). */
  errors: number;
  /** Wall-clock when this scan finished, for "Last checked: …" display. */
  lastFullScan: number;
}

/** Activity row shape we read from `ctx.api.activities.getAll()`. */
export interface DbActivityLike {
  id?: string;
  activityType: string;
  quantity?: string | number | null;
  amount?: string | number | null;
  unitPrice?: string | number | null;
  assetSymbol?: string;
  assetId?: string;
  comment?: string;
  date?: string | Date;
}

export interface WatcherInput {
  /** All DB activities in scope (typically the user's TR account). */
  dbActivities: DbActivityLike[];
  /** Settings (typically merged from localStorage + defaults). */
  settings: WatcherSettings;
  /** Optional progress callback for UI. */
  onProgress?: (done: number, total: number) => void;
}

// ─── localStorage state ──────────────────────────────────────────────

const STATE_KEY = "tr-splits-watcher:state:v1";
const TICKER_CHECK_PREFIX = "tr-splits-watcher:lastChecked:";
const APPLIED_SPLIT_PREFIX = "tr-splits-watcher:lastApplied:";

const TICKER_CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CONCURRENCY = 4;
const BATCH_PAUSE_MS = 1500; // for large portfolios (>50 holdings)

interface PersistedState {
  lastFullScan: number;
  settings: WatcherSettings;
}

export function loadSettings(): WatcherSettings {
  if (typeof window === "undefined" || !window.localStorage) return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STATE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as PersistedState;
    return { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: WatcherSettings): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const cur = window.localStorage.getItem(STATE_KEY);
    const parsed = cur ? (JSON.parse(cur) as PersistedState) : { lastFullScan: 0, settings };
    parsed.settings = settings;
    window.localStorage.setItem(STATE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

export function loadLastFullScan(): number {
  if (typeof window === "undefined" || !window.localStorage) return 0;
  try {
    const raw = window.localStorage.getItem(STATE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as PersistedState;
    return parsed.lastFullScan ?? 0;
  } catch {
    return 0;
  }
}

function saveLastFullScan(ts: number): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const cur = window.localStorage.getItem(STATE_KEY);
    const parsed = cur
      ? (JSON.parse(cur) as PersistedState)
      : { lastFullScan: 0, settings: DEFAULT_SETTINGS };
    parsed.lastFullScan = ts;
    window.localStorage.setItem(STATE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

function readTickerLastChecked(ticker: string): number {
  if (typeof window === "undefined" || !window.localStorage) return 0;
  const raw = window.localStorage.getItem(TICKER_CHECK_PREFIX + ticker);
  return raw ? Number(raw) || 0 : 0;
}

function writeTickerLastChecked(ticker: string, ts: number): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(TICKER_CHECK_PREFIX + ticker, String(ts));
  } catch {
    // ignore
  }
}

function readLastAppliedSplit(ticker: string): string | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  return window.localStorage.getItem(APPLIED_SPLIT_PREFIX + ticker);
}

export function writeLastAppliedSplit(ticker: string, isoDate: string): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(APPLIED_SPLIT_PREFIX + ticker, isoDate);
  } catch {
    // ignore
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function isoDate(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

function activityIso(d: string | Date | undefined): string {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function ratioPretty(numr: number, den: number): string {
  const g = gcd(Math.abs(numr), Math.abs(den)) || 1;
  return `${numr / g}:${den / g}`;
}

async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ─── Holdings derivation ─────────────────────────────────────────────

interface HoldingRow {
  isin: string;
  ticker: string;
  name: string;
  /** Net qty after BUY-SELL × splitFactor (≈ what TR shows). */
  netQty: number;
  /** ISO yyyy-MM-dd of the earliest BUY/SELL we saw. */
  firstTradeDate: string;
  /** SPLIT activity dates already in DB for this ISIN (ISO yyyy-MM-dd). */
  existingSplitDates: Set<string>;
  /** Yahoo instrument type (EQUITY / CRYPTO). Skip CRYPTO for splits. */
  instrumentType: string;
  isCrypto: boolean;
}

/**
 * Derive holdings from raw activities. We don't have `assets.getAll()` in
 * the SDK, so we aggregate BUY/SELL/SPLIT activities ourselves — same shape
 * the diagnostics analyzer uses.
 */
function deriveHoldings(activities: DbActivityLike[]): HoldingRow[] {
  const byIsin = new Map<
    string,
    {
      buyQty: number;
      sellQty: number;
      splitFactor: number;
      firstTradeMs: number;
      name: string;
      splitDates: Set<string>;
    }
  >();

  for (const a of activities) {
    const sym = a.assetSymbol;
    if (!sym) continue;
    let cur = byIsin.get(sym);
    if (!cur) {
      cur = {
        buyQty: 0,
        sellQty: 0,
        splitFactor: 1,
        firstTradeMs: Number.POSITIVE_INFINITY,
        name: sym,
        splitDates: new Set<string>(),
      };
      byIsin.set(sym, cur);
    }
    const q = num(a.quantity);
    switch (a.activityType) {
      case "BUY": {
        cur.buyQty += q;
        const ms = new Date(a.date ?? 0).getTime();
        if (Number.isFinite(ms) && ms < cur.firstTradeMs) cur.firstTradeMs = ms;
        break;
      }
      case "SELL": {
        cur.sellQty += q;
        const ms = new Date(a.date ?? 0).getTime();
        if (Number.isFinite(ms) && ms < cur.firstTradeMs) cur.firstTradeMs = ms;
        break;
      }
      case "SPLIT": {
        const factor = num(a.amount) || num(a.unitPrice) || 1;
        if (factor > 0) cur.splitFactor *= factor;
        const iso = activityIso(a.date);
        if (iso) cur.splitDates.add(iso);
        break;
      }
      default:
        break;
    }
  }

  const out: HoldingRow[] = [];
  for (const [isin, agg] of byIsin) {
    const netQty = (agg.buyQty - agg.sellQty) * agg.splitFactor;
    if (netQty <= 0) continue; // closed positions don't need watching
    const mapped: TickerMapping | null = lookupTicker(isin);
    const ticker = mapped?.symbol || isin;
    const instrumentType = mapped?.instrumentType ?? "EQUITY";
    const isCrypto = instrumentType === "CRYPTO" || /^XF000/.test(isin);
    out.push({
      isin,
      ticker,
      name: mapped?.displayName || agg.name,
      netQty,
      firstTradeDate: Number.isFinite(agg.firstTradeMs)
        ? new Date(agg.firstTradeMs).toISOString().slice(0, 10)
        : "",
      existingSplitDates: agg.splitDates,
      instrumentType,
      isCrypto,
    });
  }
  return out;
}

// ─── Yahoo split fetch ───────────────────────────────────────────────

interface YahooEventsResponse {
  chart: {
    result?: Array<{
      events?: {
        splits?: Record<
          string,
          { date: number; numerator: number; denominator: number; splitRatio?: string }
        >;
        dividends?: Record<string, { date: number; amount: number }>;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
}

interface YahooSearchResponse {
  quotes?: Array<{ symbol?: string; quoteType?: string; shortname?: string; longname?: string }>;
}

interface FetchOutcome {
  /** New splits we should surface (after lastChecked, not in DB). */
  splits: PendingSplit[];
  /** Dividend events for DRIP analysis (unfiltered). */
  dividends: Array<{ date: string; amount: number }>;
  /** True if Yahoo 404'd on this ticker — candidate for ticker migration. */
  notFound: boolean;
  /** True if a network/parse error occurred (don't update lastChecked). */
  errored: boolean;
}

async function fetchYahooEvents(
  holding: HoldingRow,
  fromEpochSec: number,
  toEpochSec: number,
  wantDividends: boolean,
): Promise<FetchOutcome> {
  const events = wantDividends ? "splits,dividends" : "splits";
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(holding.ticker)}` +
    `?period1=${fromEpochSec}&period2=${toEpochSec}&interval=1d&events=${events}`;
  try {
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    if (res.status === 404) {
      return { splits: [], dividends: [], notFound: true, errored: false };
    }
    if (!res.ok) return { splits: [], dividends: [], notFound: false, errored: true };
    const json = (await res.json()) as YahooEventsResponse;
    if (json.chart?.error) {
      // Yahoo returns "Not Found" inside the error blob too.
      const desc = json.chart.error.description || "";
      const notFound = /not.?found|invalid|symbol/i.test(desc);
      return { splits: [], dividends: [], notFound, errored: !notFound };
    }
    const result = json.chart?.result?.[0];
    const splitMap = result?.events?.splits ?? {};
    const divMap = result?.events?.dividends ?? {};
    const newSplits: PendingSplit[] = [];
    for (const ev of Object.values(splitMap)) {
      if (!ev || !ev.numerator || !ev.denominator) continue;
      const date = isoDate(ev.date);
      if (holding.existingSplitDates.has(date)) continue;
      const ratioMul = ev.numerator / ev.denominator;
      newSplits.push({
        kind: "split",
        isin: holding.isin,
        ticker: holding.ticker,
        name: holding.name,
        date,
        numerator: ev.numerator,
        denominator: ev.denominator,
        ratio: ev.splitRatio || ratioPretty(ev.numerator, ev.denominator),
        ratioMul,
        dbQty: holding.netQty,
      });
    }
    const divs: Array<{ date: string; amount: number }> = [];
    for (const ev of Object.values(divMap)) {
      if (!ev || !ev.amount) continue;
      divs.push({ date: isoDate(ev.date), amount: ev.amount });
    }
    return { splits: newSplits, dividends: divs, notFound: false, errored: false };
  } catch {
    return { splits: [], dividends: [], notFound: false, errored: true };
  }
}

/** Yahoo ISIN search — used for ticker migration suggestions only. */
async function searchByIsin(isin: string): Promise<string | null> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    isin,
  )}&quotesCount=5&newsCount=0`;
  try {
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const json = (await res.json()) as YahooSearchResponse;
    const quotes = json.quotes ?? [];
    for (const q of quotes) {
      const t = q.quoteType || "";
      if (t === "CRYPTOCURRENCY" || t === "FUTURE" || t === "INDEX") continue;
      if (q.symbol) return q.symbol;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── DRIP gap detection ──────────────────────────────────────────────

/**
 * Cross-reference Yahoo dividends against DB DIVIDEND activities.
 * Surfaces gaps > €5 where the DB amount is materially less than expected
 * (qty × dividend per share). Best-effort — false positives if the user
 * holds the stock through a different broker that paid the dividend, or
 * if the DIVIDEND activity is dated differently.
 */
function detectDripGaps(
  holding: HoldingRow,
  yahooDividends: Array<{ date: string; amount: number }>,
  dbActivities: DbActivityLike[],
): PendingDripGap[] {
  if (yahooDividends.length === 0) return [];
  // Build a per-(isin, date) sum of DIVIDEND amounts already in DB.
  const dbByDate = new Map<string, number>();
  for (const a of dbActivities) {
    if (a.assetSymbol !== holding.isin) continue;
    if (a.activityType !== "DIVIDEND") continue;
    const iso = activityIso(a.date);
    if (!iso) continue;
    dbByDate.set(iso, (dbByDate.get(iso) ?? 0) + Math.abs(num(a.amount)));
  }
  const gaps: PendingDripGap[] = [];
  for (const ev of yahooDividends) {
    const expected = ev.amount * holding.netQty;
    if (expected < 5) continue; // Threshold per spec — sub-€5 is noise
    // Look up by exact date first, then ±2 days.
    let actual = dbByDate.get(ev.date) ?? 0;
    if (actual === 0) {
      const evMs = new Date(ev.date).getTime();
      for (const [d, v] of dbByDate) {
        const dMs = new Date(d).getTime();
        if (Math.abs(dMs - evMs) <= 2 * 86400_000) {
          actual = v;
          break;
        }
      }
    }
    const gap = expected - actual;
    if (gap > 5) {
      gaps.push({
        kind: "drip-gap",
        isin: holding.isin,
        ticker: holding.ticker,
        name: holding.name,
        date: ev.date,
        expectedEur: expected,
        actualEur: actual,
        gapEur: gap,
      });
    }
  }
  return gaps;
}

// ─── Main scan ───────────────────────────────────────────────────────

export async function runWatcherScan(input: WatcherInput): Promise<WatcherFindings> {
  const { dbActivities, settings, onProgress } = input;
  const holdings = deriveHoldings(dbActivities);
  // Splits are nonsensical for crypto; ticker-migrations less so but we
  // still skip XF000* (we know our own pseudo-ISIN mapping).
  const watchable = holdings.filter((h) => !h.isCrypto);

  // Decide which tickers are due (lastChecked > 24h or never).
  const now = Date.now();
  const due: HoldingRow[] = [];
  let skippedFresh = 0;
  for (const h of watchable) {
    const last = readTickerLastChecked(h.ticker);
    if (now - last < TICKER_CHECK_TTL_MS) {
      skippedFresh += 1;
      continue;
    }
    due.push(h);
  }

  const splits: PendingSplit[] = [];
  const dripGaps: PendingDripGap[] = [];
  const notFoundHoldings: HoldingRow[] = [];
  let errors = 0;
  let done = 0;

  // From-epoch: 2 years before earliest first trade, capped at 5y back.
  const FIVE_YEARS_AGO = Math.floor(now / 1000) - 5 * 365 * 86400;
  const TODAY_EPOCH = Math.floor(now / 1000);

  if (due.length > 50) {
    // Polite pause for large portfolios — Yahoo throttles bursts.
    await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
  }

  await mapBounded(due, CONCURRENCY, async (h, i) => {
    const last = readTickerLastChecked(h.ticker);
    const firstMs = h.firstTradeDate ? new Date(h.firstTradeDate).getTime() : 0;
    const fromEpoch = Math.max(
      Math.floor((last > 0 ? last : firstMs) / 1000) - 7 * 86400,
      FIVE_YEARS_AGO,
    );
    const result = await fetchYahooEvents(h, fromEpoch, TODAY_EPOCH, settings.watchDripGaps);
    done += 1;
    onProgress?.(done, due.length);

    if (result.errored) {
      errors += 1;
      return;
    }
    if (result.notFound) {
      notFoundHoldings.push(h);
      // Don't update lastChecked — we want to retry next scan.
      return;
    }
    // Attach splits if not already applied per localStorage flag.
    const lastApplied = readLastAppliedSplit(h.ticker);
    for (const s of result.splits) {
      if (lastApplied && lastApplied >= s.date) continue;
      splits.push(s);
    }
    if (settings.watchDripGaps && result.dividends.length > 0) {
      dripGaps.push(...detectDripGaps(h, result.dividends, dbActivities));
    }
    writeTickerLastChecked(h.ticker, now);
    // Polite pacing — every CONCURRENCY-th call, breathe a bit.
    if (i > 0 && i % (CONCURRENCY * 5) === 0) {
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  // Ticker migration discovery — only for 404'd holdings.
  const tickerMigrations: PendingTickerMigration[] = [];
  if (settings.watchTickerChanges && notFoundHoldings.length > 0) {
    await mapBounded(notFoundHoldings, CONCURRENCY, async (h) => {
      const newSym = await searchByIsin(h.isin);
      if (newSym && newSym !== h.ticker) {
        tickerMigrations.push({
          kind: "ticker-migration",
          isin: h.isin,
          fromTicker: h.ticker,
          toTicker: newSym,
          name: h.name,
        });
      }
    });
  }

  // De-dupe splits by (isin, date) — same split can appear in cache + retry.
  const splitKey = new Set<string>();
  const uniqueSplits = splits.filter((s) => {
    const k = `${s.isin}|${s.date}`;
    if (splitKey.has(k)) return false;
    splitKey.add(k);
    return true;
  });
  // Sort splits by date desc (newest first).
  uniqueSplits.sort((a, b) => (a.date < b.date ? 1 : -1));

  saveLastFullScan(now);

  return {
    splits: uniqueSplits,
    tickerMigrations,
    dripGaps,
    checkedTickers: due.length - errors,
    skippedFresh,
    errors,
    lastFullScan: now,
  };
}

/**
 * Count of pending corrections — used for sidebar badge.
 */
export function countPending(findings: WatcherFindings | null): number {
  if (!findings) return 0;
  return findings.splits.length + findings.tickerMigrations.length + findings.dripGaps.length;
}

/**
 * Reset all per-ticker lastChecked entries (force a full re-scan).
 */
export function resetWatcherCache(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && (k.startsWith(TICKER_CHECK_PREFIX) || k.startsWith(APPLIED_SPLIT_PREFIX))) {
        keys.push(k);
      }
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    // ignore
  }
}
