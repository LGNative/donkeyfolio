/**
 * TR Tax Report PDF parser. (v2.20.2)
 *
 * What this is:
 *   Trade Republic publishes a SEPARATE annual PDF for tax purposes
 *   ("Steuerbescheinigung" / "Tax Report" / "Comprovativo Fiscal" /
 *   "Justificatif fiscal") that contains data the regular Account
 *   Statement omits — most importantly the staking rewards table that
 *   shows qty + EUR value per crypto + date.
 *
 *   Without this, TR users have to type every staking event manually
 *   (potentially hundreds per year for ETH/SOL/ADA).
 *
 * What we extract:
 *   1. Staking rewards: per-crypto rows with date, qty, value EUR
 *   2. Withholding tax: per-dividend tax breakdown (KESt + Soli + Kirche
 *      for DE; equivalent for other markets) — used to enrich existing
 *      DIVIDEND activities with subtypes / proper tax tracking
 *   3. Realized gains/losses summary (informational)
 *
 * Detection:
 *   The same pdf.js text extraction we use for the account statement.
 *   The Tax Report has unique header keywords ("Steuerbescheinigung",
 *   "Erträgnisaufstellung", "Tax Report", "Comprovativo Fiscal") which
 *   we use to distinguish it from the regular statement and route to
 *   this parser instead of `parsePDF`.
 *
 * Output:
 *   `TaxReportData` with arrays of staking rewards and withholding tax
 *   entries. The page caller emits these as INTEREST/STAKING_REWARD
 *   activities at import time, identical to manual entries.
 *
 * Limitations:
 *   - Tax Report layouts vary by year (TR has redesigned ~yearly since
 *     2022). The parser uses keyword anchors rather than column positions
 *     so minor layout shifts don't break it. Major redesigns will need
 *     updates here.
 *   - Crypto-only — TR's Steuerbescheinigung also covers stocks/ETF
 *     dividends but our use case is staking specifically.
 */

import * as pdfjs from "pdfjs-dist";

export interface StakingRewardEntry {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** Crypto symbol (BTC, ETH, SOL, ADA, XRP, DOT, DOGE, LTC). */
  symbol: string;
  /** TR pseudo-ISIN if we can map it (XF000ETH0019, etc.). */
  isin?: string;
  /** Qty of crypto received as reward. */
  quantity: number;
  /** EUR value at the time of the reward (TR's spot conversion). */
  amountEur: number;
  /** Optional tax description from PDF (e.g. "Staking Reward — ETH"). */
  description?: string;
}

export interface WithholdingTaxEntry {
  date: string;
  isin?: string;
  /** Description string from PDF (security name, payment type). */
  description: string;
  /** Total tax withheld in EUR. */
  amountEur: number;
  /** Tax category (KESt, SOLI, Kirchensteuer) when DE detail is available. */
  category?: string;
}

export interface TaxReportData {
  /** Year covered by the report (extracted from header). */
  year: number | null;
  /** Source filename for audit. */
  fileName: string;
  /** All staking reward events. */
  staking: StakingRewardEntry[];
  /** Withholding tax breakdown per payment. */
  withholding: WithholdingTaxEntry[];
  /** Whether the file looked like a Tax Report at all. */
  isTaxReport: boolean;
}

/**
 * Heuristic check on the first ~3 pages — we look for any of the known
 * Tax Report header strings. Only proceeds with full parse if positive.
 */
const TAX_REPORT_HEADERS = [
  "Steuerbescheinigung",
  "Erträgnisaufstellung",
  "Tax Report",
  "Tax Statement",
  "Comprovativo Fiscal",
  "Justificatif fiscal",
  "Certificación Fiscal",
  "Certificazione Fiscale",
];

/** Pseudo-ISIN map for crypto symbols seen in Tax Reports. */
const CRYPTO_SYMBOL_TO_ISIN: Record<string, string> = {
  BTC: "XF000BTC0017",
  ETH: "XF000ETH0019",
  XRP: "XF000XRP0018",
  SOL: "XF000SOL0012",
  ADA: "XF000ADA0018",
  DOT: "XF000DOT0010",
  DOGE: "XF000DOGE001",
  LTC: "XF000LTC0011",
  AVAX: "XF000AVAX001",
  ATOM: "XF000ATOM001",
  MATIC: "XF000MATIC01",
};

/**
 * Anchor keywords that mark the start of the staking section per language.
 * Detection uses substring match so partial / inflected forms still work.
 */
const STAKING_SECTION_ANCHORS = [
  "Staking",
  "Recompensa de Staking",
  "Recompensas de Staking",
  "Staking-Belohnung",
  "Récompense de staking",
  "Recompensa staking",
];

/**
 * Date matchers — TR uses dd.mm.yyyy in DE PDFs and dd/mm/yyyy in PT.
 * We support both and ISO yyyy-mm-dd as a future-proofing safety.
 */
const DATE_RE = /\b(\d{2})[./](\d{2})[./](\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/;

/**
 * Robust EUR amount parser. Tax Report layouts mix EU and US formats
 * depending on the user's account locale. Returns 0 on parse failure.
 */
function parseEurFlex(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[€\s]/g, "").replace(/ /g, "");
  if (!cleaned) return 0;
  const hasDot = cleaned.includes(".");
  const hasComma = cleaned.includes(",");
  let normalized = cleaned;
  if (hasDot && hasComma) {
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) {
      normalized = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = cleaned.split(",");
    if (parts.length === 2 && parts[1].length === 3) {
      normalized = cleaned.replace(/,/g, "");
    } else {
      normalized = cleaned.replace(",", ".");
    }
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize a captured date to ISO YYYY-MM-DD. Returns "" when the input
 * doesn't match a known TR format (caller skips that row).
 */
function isoDate(raw: string): string {
  const m = raw.match(DATE_RE);
  if (!m) return "";
  if (m[1]) {
    // dd.mm.yyyy or dd/mm/yyyy
    return `${m[3]}-${m[2]}-${m[1]}`;
  }
  if (m[4]) {
    // yyyy-mm-dd
    return `${m[4]}-${m[5]}-${m[6]}`;
  }
  return "";
}

/**
 * Top-level entry point. Loads the PDF, checks the header for Tax Report
 * keywords, and extracts staking + withholding entries when applicable.
 *
 * Designed to NOT throw on a non-tax-report PDF — instead, it returns
 * `isTaxReport: false` and empty arrays so the caller can fall through
 * to the regular account-statement parser.
 */
export async function parseTaxReport(
  buffer: ArrayBuffer,
  fileName: string,
  onProgress?: (page: number, total: number) => void,
): Promise<TaxReportData> {
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const allText: string[] = [];
  const totalPages = pdf.numPages;
  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((it: any) => (typeof it.str === "string" ? it.str : ""))
      .join(" ");
    allText.push(pageText);
    onProgress?.(i, totalPages);
  }
  const fullText = allText.join("\n");

  const isTaxReport = TAX_REPORT_HEADERS.some((h) =>
    fullText.toLowerCase().includes(h.toLowerCase()),
  );
  const year = extractYear(fullText);

  if (!isTaxReport) {
    return { year, fileName, staking: [], withholding: [], isTaxReport: false };
  }

  const staking = extractStakingRewards(fullText);
  const withholding = extractWithholding(fullText);
  return { year, fileName, staking, withholding, isTaxReport: true };
}

/**
 * Find a 4-digit year (2020-2099) in the first ~500 chars of the text.
 * Used for display (`Tax Report 2025`) — does not affect parsing.
 */
function extractYear(text: string): number | null {
  const head = text.slice(0, 1000);
  const m = head.match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract staking reward rows. Strategy:
 *   1. Locate any line containing a known staking anchor + a crypto symbol
 *   2. From that line, extract date / qty / EUR amount
 *
 * The TR PDF text extraction collapses tables onto single lines per row
 * (whitespace-separated), so this works for the layouts we've seen.
 *
 * False positives are filtered by requiring ALL of: date + crypto symbol
 * + qty > 0 + amountEur > 0. Anything missing → row dropped (no harm,
 * user can still add manually).
 */
function extractStakingRewards(text: string): StakingRewardEntry[] {
  const rows: StakingRewardEntry[] = [];
  const lines = text.split(/\n+/);
  for (const line of lines) {
    const isStakingLine = STAKING_SECTION_ANCHORS.some((a) =>
      line.toLowerCase().includes(a.toLowerCase()),
    );
    if (!isStakingLine) continue;

    // Extract crypto symbol — find the first standalone match
    let symbol = "";
    for (const sym of Object.keys(CRYPTO_SYMBOL_TO_ISIN)) {
      const symRe = new RegExp(`\\b${sym}\\b`, "i");
      if (symRe.test(line)) {
        symbol = sym;
        break;
      }
    }
    if (!symbol) continue;

    const date = isoDate(line);
    if (!date) continue;

    // Extract numeric tokens — last 2 are typically qty + amount EUR.
    // This is heuristic; layouts vary. We prefer:
    //   - qty: a number with 4+ decimals (TR shows fractional crypto)
    //   - amount EUR: a number with 2 decimals + € or in EUR column
    const tokens = line.match(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2,8})\b/g) ?? [];
    let qty = 0;
    let amountEur = 0;
    for (const tok of tokens) {
      const n = parseEurFlex(tok);
      if (n <= 0) continue;
      // Heuristic: if more than 2 decimal places, treat as qty
      const decimalsMatch = tok.match(/[.,](\d+)$/);
      const decimals = decimalsMatch ? decimalsMatch[1].length : 0;
      if (decimals >= 4 && qty === 0) qty = n;
      else if (decimals === 2 && amountEur === 0) amountEur = n;
    }
    if (qty <= 0 || amountEur <= 0) continue;

    rows.push({
      date,
      symbol,
      isin: CRYPTO_SYMBOL_TO_ISIN[symbol],
      quantity: qty,
      amountEur,
      description: `Staking reward · ${symbol}`,
    });
  }
  // Dedup by (date, symbol, qty, amount) — TR Tax Report sometimes has
  // a summary table that repeats rows. Idempotency at the activity level
  // would catch this anyway, but cleaner to dedup early.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.date}|${r.symbol}|${r.quantity.toFixed(6)}|${r.amountEur.toFixed(2)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Extract withholding tax breakdown. Best-effort — DE Steuerbescheinigung
 * has a clean tabular layout, PT/ES are looser. We currently only emit
 * total tax per payment; per-category split (KESt vs Soli) is dropped.
 *
 * The page caller uses these to flag/enhance corresponding DIVIDEND
 * activities; not to create new TAX activities (those already flow
 * through the cash-section parser of the regular account statement).
 */
function extractWithholding(text: string): WithholdingTaxEntry[] {
  const rows: WithholdingTaxEntry[] = [];
  const lines = text.split(/\n+/);
  const taxKeywords = ["Kapitalertragsteuer", "Withholding", "Imposto", "Retención", "Ritenuta"];
  for (const line of lines) {
    const hasTaxKw = taxKeywords.some((k) => line.toLowerCase().includes(k.toLowerCase()));
    if (!hasTaxKw) continue;
    const date = isoDate(line);
    if (!date) continue;
    const isinMatch = line.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/);
    const tokens = line.match(/\b\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\b/g) ?? [];
    if (tokens.length === 0) continue;
    const lastTok = tokens[tokens.length - 1];
    const amountEur = parseEurFlex(lastTok);
    if (amountEur <= 0) continue;
    rows.push({
      date,
      isin: isinMatch?.[1],
      description: line.slice(0, 200),
      amountEur,
    });
  }
  return rows;
}

/**
 * Convert StakingRewardEntry[] into the ActivityImport shape the addon's
 * import path expects. This bridges the Tax Report data into the existing
 * activity pipeline so they import alongside trades/dividends/etc.
 *
 * Mapping per row:
 *   activityType = INTEREST
 *   subtype      = STAKING_REWARD  (Donkeyfolio convention; treats them
 *                                    as INTEREST income with crypto asset)
 *   symbol       = pseudo-ISIN     (XF000ETH0019 etc., routed as CRYPTO)
 *   quantity     = crypto qty
 *   unitPrice    = amountEur / qty (implied EUR price at reward time)
 *   amount       = amountEur       (cash-equivalent recognized as income)
 *   fee          = 0
 *   currency     = "EUR"
 */
export interface StakingActivityImport {
  date: string;
  symbol: string;
  symbolName: string;
  isin: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  comment: string;
}

export function stakingRewardsToActivities(rewards: StakingRewardEntry[]): StakingActivityImport[] {
  return rewards
    .filter((r) => r.isin && r.quantity > 0 && r.amountEur > 0)
    .map((r) => ({
      date: r.date,
      symbol: r.isin!,
      symbolName: `${r.symbol} (Staking Reward)`,
      isin: r.isin!,
      quantity: r.quantity,
      unitPrice: r.amountEur / r.quantity,
      amount: r.amountEur,
      comment: `TR Tax Report — ${r.description ?? r.symbol} staking reward`,
    }));
}
