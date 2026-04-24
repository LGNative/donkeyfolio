/**
 * Convert parsed TR statements → Donkeyfolio ActivityImport[].
 *
 * Mapping rules:
 *   - Trading BUY  → ACT.BUY  (needs symbol, quantity, unitPrice)
 *   - Trading SELL → ACT.SELL (needs symbol, quantity, unitPrice)
 *   - Cash "Zinsen" / interest → INTEREST
 *   - Cash "Überweisung" / "Einzahlung" (incoming money) → DEPOSIT
 *   - Cash outgoing transfer / Auszahlung → WITHDRAWAL
 *   - Cash "Dividende" → DIVIDEND
 *   - Cash "Steuern" / Tax → TAX
 *   - Cash "Gebühr" / fee → FEE
 *
 * Only cash rows that are NOT backing a trading transaction (same date+ISIN
 * appears in trading[]) are converted to DEPOSIT/WITHDRAWAL/INTEREST/etc. —
 * otherwise we'd double-count the trade's cash leg.
 */
import type { ActivityImport, ActivityType } from "@wealthfolio/addon-sdk";

import type { CashTransaction, TradingTransaction } from "./tr-parser";

// The SDK only re-exports data-types as types (not runtime consts), so we
// reference activity types by their literal string values. These match the
// closed set in packages/addon-sdk/src/data-types.ts.
const ACT = {
  BUY: "BUY",
  SELL: "SELL",
  DEPOSIT: "DEPOSIT",
  WITHDRAWAL: "WITHDRAWAL",
  DIVIDEND: "DIVIDEND",
  INTEREST: "INTEREST",
  FEE: "FEE",
  TAX: "TAX",
} satisfies Record<string, ActivityType>;

// Parse German/European money "1.234,56 €" → number
function parseEuroAmount(raw: string): number {
  if (!raw) return 0;
  const cleaned = String(raw)
    .replace(/€/g, "")
    .replace(/\s/g, "")
    .replace(/\.(?=\d{3}(?:[.,]|$))/g, "")
    .replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// dd.MM.yyyy → yyyy-MM-ddTHH:mm:ssZ (midnight UTC)
function toIsoDate(ddmmyyyy: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(ddmmyyyy.trim());
  if (!m) return new Date().toISOString();
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
}

function classifyCashType(typ: string, description: string, incoming: number): ActivityType | null {
  const t = (typ || "").toLowerCase();
  const d = (description || "").toLowerCase();

  if (t.includes("zins") || d.includes("zins") || d.includes("interest")) return ACT.INTEREST;
  if (t.includes("dividend") || d.includes("dividend")) return ACT.DIVIDEND;
  if (t.includes("steuer") || d.includes("steuer") || d.includes("tax")) return ACT.TAX;
  if (t.includes("gebühr") || t.includes("gebuehr") || d.includes("gebühr") || d.includes("fee"))
    return ACT.FEE;

  // Generic in/out → deposit/withdrawal
  if (incoming > 0) return ACT.DEPOSIT;
  if (incoming < 0) return ACT.WITHDRAWAL;
  return null;
}

interface BuildOpts {
  accountId: string;
  currency: string;
  cash: CashTransaction[];
  trading: TradingTransaction[];
  /** Set of date|ISIN keys that should be skipped from cash (already covered by trading). */
  skipCashKeys: Set<string>;
}

function extractIsin(text: string): string | undefined {
  return text.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/)?.[1];
}

export function buildActivitiesFromParsed(opts: BuildOpts): ActivityImport[] {
  const { accountId, currency, cash, trading, skipCashKeys } = opts;
  const activities: ActivityImport[] = [];
  let lineNumber = 1;

  // 1) Trading → BUY / SELL
  for (const tx of trading) {
    if (!tx.isin || !tx.date) continue;
    const qty = tx.quantity;
    const unit = tx.unitPrice;
    if (!qty || qty <= 0 || !unit || unit <= 0) {
      // No quantity → can't create a proper BUY/SELL activity.
      continue;
    }
    activities.push({
      accountId,
      currency,
      activityType: tx.isBuy ? ACT.BUY : ACT.SELL,
      date: toIsoDate(tx.date),
      symbol: tx.isin,
      symbolName: tx.cleanStockName || tx.stockName,
      quantity: qty,
      unitPrice: unit,
      amount: Math.abs(tx.amount),
      fee: 0,
      lineNumber: lineNumber++,
      isValid: true,
      isDraft: false,
    });
  }

  // 2) Cash rows NOT tied to a trade → DEPOSIT / WITHDRAWAL / INTEREST / etc.
  for (const c of cash) {
    const inc = parseEuroAmount(c.zahlungseingang);
    const out = parseEuroAmount(c.zahlungsausgang);
    const signed = inc - out;
    if (signed === 0) continue;

    const isin = extractIsin(c.beschreibung);
    const key = isin ? `${c.datum}|${isin}` : "";
    if (key && skipCashKeys.has(key)) continue;

    const kind = classifyCashType(c.typ, c.beschreibung, signed);
    if (!kind) continue;

    activities.push({
      accountId,
      currency,
      activityType: kind,
      date: toIsoDate(c.datum),
      symbol: isin || "$CASH",
      amount: Math.abs(signed),
      quantity: 0,
      unitPrice: 0,
      fee: 0,
      comment: c.beschreibung?.slice(0, 200) || undefined,
      lineNumber: lineNumber++,
      isValid: true,
      isDraft: false,
    });
  }

  return activities;
}

/**
 * Build a set of "date|ISIN" keys that identify cash rows already covered
 * by a trading transaction — so we don't import the same event twice
 * (once as BUY and once as WITHDRAWAL).
 */
export function buildTradingCashKeys(trading: TradingTransaction[]): Set<string> {
  const keys = new Set<string>();
  for (const tx of trading) {
    if (tx.date && tx.isin) keys.add(`${tx.date}|${tx.isin}`);
  }
  return keys;
}
