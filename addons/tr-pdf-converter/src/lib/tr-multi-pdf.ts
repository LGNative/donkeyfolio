/**
 * Multi-PDF merge — concatenate parse results from N TR account statements
 * (e.g. 2024 + 2025 + 2026) into a single ParseState equivalent. (v2.20.2)
 *
 * Why this exists:
 *   TR users with multi-year history have to drop one PDF, import, drop the
 *   next, import, etc. — losing the FIFO cost-basis advantage that comes
 *   from processing trades in chronological order across years. This module
 *   accepts multiple parsed states and produces ONE merged state suitable
 *   for the existing build pipeline.
 *
 * Merge rules:
 *   - cash[]      : concatenated, then sorted by datum chronologically
 *   - trading[]   : concatenated, sorted by date; dedup by idempotency-style
 *                   key (date|isin|amount|qty) to handle PDF overlaps where
 *                   the same trade appears in two statements that span an
 *                   overlapping period
 *   - interest[]  : concatenated + dedup by (date, isin, amount)
 *   - summary     : composed — opening = earliest PDF's opening,
 *                   ending = latest PDF's ending,
 *                   moneyIn/moneyOut summed across all PDFs
 *   - autoSplits  : merged + deduped by (isin, date, ratio) — same split
 *                   detected across years stays once
 *   - discoveredTickers: union; first occurrence wins per ISIN
 *
 * The merged state goes through the existing buildActivitiesFromParsed
 * pipeline unchanged. Idempotency keys at the activity level (date|line|
 * symbol|file) ensure re-imports across PDFs don't create duplicates.
 */

import type {
  CashTransaction,
  InterestTransaction,
  StatementSummary,
  TradingTransaction,
} from "./tr-parser";
import type { DiscoveryResult } from "./tr-ticker-discovery";
import type { SplitEvent } from "./tr-splits";

/**
 * The shape of a single parsed PDF — narrow subset of the page's
 * `ParseState` containing only what the merger needs. Keeps the merger
 * decoupled from page state shape so it can be unit-tested.
 */
export interface ParsedPdf {
  fileName: string;
  cash: CashTransaction[];
  interest: InterestTransaction[];
  trading: TradingTransaction[];
  summary: StatementSummary | null;
  discoveredTickers: DiscoveryResult[];
  autoSplits: SplitEvent[];
  failedChecks: number;
  recoveredRows: number;
  cryptoResolved: number;
}

export interface MergedPdf {
  /** Comma-joined filenames so logs / preview show provenance. */
  fileName: string;
  cash: CashTransaction[];
  interest: InterestTransaction[];
  trading: TradingTransaction[];
  /** Composed summary — opening from earliest, ending from latest. */
  summary: StatementSummary | null;
  discoveredTickers: DiscoveryResult[];
  autoSplits: SplitEvent[];
  failedChecks: number;
  recoveredRows: number;
  cryptoResolved: number;
  /** Per-PDF stats so the UI can render a "merged from N PDFs" badge. */
  perFile: Array<{
    fileName: string;
    cashCount: number;
    tradingCount: number;
    interestCount: number;
    opening?: string;
    ending?: string;
  }>;
}

/**
 * Heuristic for deduplicating trades that appear in two overlapping PDFs.
 * Uses the most discriminating fields available — date, ISIN, signed
 * amount, qty (when present). Idempotency across statements is best-effort:
 * if the same trade has a slightly different cash amount across PDFs (rare
 * but possible with floating-point recompute), we may keep both. The
 * activity-level idempotencyKey downstream guarantees no double-import.
 */
function tradingKey(t: TradingTransaction): string {
  const qty = t.quantity ?? "";
  const amount = Math.abs(t.amount).toFixed(2);
  return `${t.date}|${t.isin}|${t.isBuy ? "B" : "S"}|${amount}|${qty}|${t.tradeId ?? ""}`;
}

function interestKey(i: InterestTransaction): string {
  // InterestTransaction shape varies — use whatever date + amount fields
  // are available, fall back to a JSON snapshot for the rest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyI = i as any;
  const date = anyI.datum ?? anyI.date ?? "";
  const isin = anyI.isin ?? "";
  const amount = anyI.betrag ?? anyI.amount ?? "";
  return `${date}|${isin}|${amount}`;
}

function cashKey(c: CashTransaction): string {
  return `${c.datum}|${c.beschreibung}|${c.zahlungseingang}|${c.zahlungsausgang}|${c.saldo}`;
}

function splitKey(s: SplitEvent): string {
  return `${s.isin}|${s.date}|${s.ratio}`;
}

/**
 * Merge N parsed PDFs into one. Order matters only for the summary
 * composition (opening from earliest by date, ending from latest); the
 * cash / trading / interest arrays are sorted globally after merging.
 */
export function mergeParsedPdfs(pdfs: ParsedPdf[]): MergedPdf {
  if (pdfs.length === 0) {
    return {
      fileName: "",
      cash: [],
      interest: [],
      trading: [],
      summary: null,
      discoveredTickers: [],
      autoSplits: [],
      failedChecks: 0,
      recoveredRows: 0,
      cryptoResolved: 0,
      perFile: [],
    };
  }
  if (pdfs.length === 1) {
    const p = pdfs[0];
    return {
      ...p,
      perFile: [
        {
          fileName: p.fileName,
          cashCount: p.cash.length,
          tradingCount: p.trading.length,
          interestCount: p.interest.length,
          opening: p.summary?.openingBalance,
          ending: p.summary?.endingBalance,
        },
      ],
    };
  }

  // 1) Concatenate + sort cash chronologically. The TR parser uses
  //    German date format `dd.mm.yyyy` so we rely on the underlying
  //    parser's already-normalized field order if available; otherwise
  //    fall back to lexicographic sort which works for ISO-like dates.
  const cashAll: CashTransaction[] = [];
  const seenCash = new Set<string>();
  for (const p of pdfs) {
    for (const c of p.cash) {
      const k = cashKey(c);
      if (seenCash.has(k)) continue;
      seenCash.add(k);
      cashAll.push(c);
    }
  }
  cashAll.sort((a, b) => compareTrDate(a.datum, b.datum));

  // 2) Trading — dedup before sorting so the queue order in
  //    enrichTradingWithQuantity stays meaningful.
  const tradingAll: TradingTransaction[] = [];
  const seenTrade = new Set<string>();
  for (const p of pdfs) {
    for (const t of p.trading) {
      const k = tradingKey(t);
      if (seenTrade.has(k)) continue;
      seenTrade.add(k);
      tradingAll.push(t);
    }
  }
  tradingAll.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 3) Interest (MMF dividends).
  const interestAll: InterestTransaction[] = [];
  const seenInt = new Set<string>();
  for (const p of pdfs) {
    for (const i of p.interest) {
      const k = interestKey(i);
      if (seenInt.has(k)) continue;
      seenInt.add(k);
      interestAll.push(i);
    }
  }

  // 4) Splits — same split across years dedupes.
  const splitsAll: SplitEvent[] = [];
  const seenSplit = new Set<string>();
  for (const p of pdfs) {
    for (const s of p.autoSplits) {
      const k = splitKey(s);
      if (seenSplit.has(k)) continue;
      seenSplit.add(k);
      splitsAll.push(s);
    }
  }

  // 5) Discovered tickers — first occurrence wins per ISIN.
  const tickersAll: DiscoveryResult[] = [];
  const seenIsin = new Set<string>();
  for (const p of pdfs) {
    for (const d of p.discoveredTickers) {
      if (seenIsin.has(d.isin)) continue;
      seenIsin.add(d.isin);
      tickersAll.push(d);
    }
  }

  // 6) Compose summary. Opening = earliest PDF's opening; ending = latest
  //    PDF's ending; moneyIn/moneyOut summed across all PDFs.
  const sortedByDate = [...pdfs].sort((a, b) => {
    const ad = a.summary?.openingDate ?? a.cash[0]?.datum ?? "";
    const bd = b.summary?.openingDate ?? b.cash[0]?.datum ?? "";
    return compareTrDate(ad, bd);
  });
  const earliest = sortedByDate[0];
  const latest = sortedByDate[sortedByDate.length - 1];
  let summary: StatementSummary | null = null;
  if (earliest.summary && latest.summary) {
    let totalIn = 0;
    let totalOut = 0;
    for (const p of pdfs) {
      if (!p.summary) continue;
      totalIn += parseEurDisplayLocal(p.summary.moneyIn);
      totalOut += parseEurDisplayLocal(p.summary.moneyOut);
    }
    summary = {
      openingBalance: earliest.summary.openingBalance,
      endingBalance: latest.summary.endingBalance,
      moneyIn: formatEurEu(totalIn),
      moneyOut: formatEurEu(totalOut),
      openingDate: earliest.summary.openingDate,
      endingDate: latest.summary.endingDate,
    };
  } else {
    summary = earliest.summary ?? latest.summary ?? null;
  }

  return {
    fileName: pdfs.map((p) => p.fileName).join(" + "),
    cash: cashAll,
    interest: interestAll,
    trading: tradingAll,
    summary,
    discoveredTickers: tickersAll,
    autoSplits: splitsAll,
    failedChecks: pdfs.reduce((s, p) => s + p.failedChecks, 0),
    recoveredRows: pdfs.reduce((s, p) => s + p.recoveredRows, 0),
    cryptoResolved: pdfs.reduce((s, p) => s + p.cryptoResolved, 0),
    perFile: pdfs.map((p) => ({
      fileName: p.fileName,
      cashCount: p.cash.length,
      tradingCount: p.trading.length,
      interestCount: p.interest.length,
      opening: p.summary?.openingBalance,
      ending: p.summary?.endingBalance,
    })),
  };
}

/**
 * Compare two TR-style dates (`dd.mm.yyyy` or `yyyy-mm-dd`) chronologically.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 *
 * Defends against malformed dates by falling back to lexicographic sort
 * (which is wrong for `dd.mm.yyyy` but won't crash).
 */
function compareTrDate(a: string, b: string): number {
  const ax = isoizeTrDate(a);
  const bx = isoizeTrDate(b);
  return ax < bx ? -1 : ax > bx ? 1 : 0;
}

function isoizeTrDate(s: string): string {
  if (!s) return "";
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  // dd.mm.yyyy → yyyy-mm-dd
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s;
}

/**
 * Local copy of parseEurDisplay — kept here so this module has no
 * dependency on the page file. Accepts EU/US formats with €/spaces.
 */
function parseEurDisplayLocal(s: string | undefined | null): number {
  if (!s) return 0;
  const cleaned = String(s).replace(/[€\s]/g, "");
  if (!cleaned) return 0;
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  let normalized = cleaned;
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) {
      normalized = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (hasComma) {
    normalized = cleaned.replace(",", ".");
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

/** Format a number back to EU style for `moneyIn`/`moneyOut` summary fields. */
function formatEurEu(n: number): string {
  return n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
