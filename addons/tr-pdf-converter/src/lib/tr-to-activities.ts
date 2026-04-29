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

import { extractIsin } from "./tr-isin-utils";
import type { CashTransaction, TradingTransaction } from "./tr-parser";
import type { SplitEvent } from "./tr-splits";

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
  CREDIT: "CREDIT",
  FEE: "FEE",
  TAX: "TAX",
} satisfies Record<string, ActivityType>;

// Format-aware number parser (handles both US "€13,862.66" and EU "€13.862,66").
// Rule: the separator that appears LAST is the decimal. Single-separator
// strings use a 3-digit heuristic (exactly 3 trailing digits → thousands).
function parseEuroAmount(raw: string): number {
  if (!raw) return 0;
  const s = String(raw).replace(/[€\s]/g, "");
  if (!s) return 0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let normalized: string = s;
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      normalized = s.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = s.split(",");
    normalized =
      parts.length === 2 && parts[1].length === 3 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (hasDot) {
    const parts = s.split(".");
    // Multiple dots → EU thousands. Single dot with 3 digits after → EU
    // thousands ONLY when integer part is non-zero. "0.384" stays as US
    // decimal (it's a fractional share quantity, not 384).
    if (parts.length > 2) {
      normalized = s.replace(/\./g, "");
    } else if (parts.length === 2 && parts[1].length === 3 && !/^0+$/.test(parts[0])) {
      normalized = s.replace(/\./g, "");
    }
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

// Convert TR statement dates to ISO 8601 (midnight UTC).
// TR emits dates in two flavours depending on the statement language:
//   "20.06.2024"    (German, dd.MM.yyyy)
//   "20 Jun 2024"   (English/Portuguese, dd MMM yyyy)
//   "20 Jun. 2024"  (occasional period after the month abbreviation)
// Everything else falls back to today (and is logged-by-effect via a clear
// stale date in the import).
const MONTHS_EN_PT: Record<string, string> = {
  jan: "01",
  feb: "02",
  fev: "02",
  mar: "03",
  apr: "04",
  abr: "04",
  may: "05",
  mai: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  ago: "08",
  sep: "09",
  set: "09",
  oct: "10",
  out: "10",
  nov: "11",
  dec: "12",
  dez: "12",
};

function toIsoDate(raw: string): string {
  const s = (raw || "").trim();
  // dd.MM.yyyy
  const dotMatch = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (dotMatch) {
    const [, dd, mm, yyyy] = dotMatch;
    return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
  }
  // dd MMM[.] yyyy   (e.g. "20 Jun 2024", "20 Jun. 2024", "20 jun 2024")
  const monMatch = /^(\d{1,2})\s+([A-Za-zçÇ]{3,})\.?\s+(\d{4})$/.exec(s);
  if (monMatch) {
    const [, dd, monRaw, yyyy] = monMatch;
    const mm = MONTHS_EN_PT[monRaw.slice(0, 3).toLowerCase()];
    if (mm) {
      const ddPad = dd.padStart(2, "0");
      return `${yyyy}-${mm}-${ddPad}T00:00:00.000Z`;
    }
  }
  // yyyy-MM-dd already
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00.000Z`;
  }
  return new Date().toISOString();
}

// Multi-language keyword classifier. TR statements come in DE / EN / PT (and
// occasionally mixed) so we match against all three for each activity type.
// Order matters: more specific keywords (STAKING, DIVIDEND, INTEREST, TAX,
// FEE, BONUS, SAVEBACK, REFUND) are checked before the generic IN/OUT
// fallback.
const KEYWORDS = {
  // Staking rewards (TR pays them as cash to the EUR account)
  staking: ["staking", "stake reward", "staked"],
  // Saveback / Round-up — TR returns 1% of card spending as ETF investments.
  // Classified as CREDIT/SAVEBACK so it's separable from regular bonuses.
  saveback: ["saveback", "round up", "round-up", "aufrundung", "arredondamento"],
  // Bonus / referral / promo cash credits
  bonus: ["bonus", "referral", "promo", "promoção", "promocao", "prämie"],
  // Refunds / reimbursements / chargebacks — net incoming cash, NOT income.
  refund: ["refund", "erstattung", "reembolso", "estorno", "rückzahlung", "ruckzahlung"],
  // Settlement / rebooking / rounding adjustments — internal corrections.
  // Generic in/out fallthrough handles direction; classified as CREDIT to
  // avoid skewing the deposit/withdrawal totals.
  settlement: [
    "ausgleich",
    "umbuchung",
    "rundung",
    "rebooking",
    "settlement adjust",
    "liquidação",
    "liquidacao",
    "reclassificação",
    "reclassificacao",
  ],
  interest: ["zins", "interest", "juros", "rendimento"],
  dividend: ["dividend", "dividendo", "dividendos"],
  tax: ["steuer", "tax", "imposto", "withhold", "retenção", "retencao"],
  fee: [
    "gebühr",
    "gebuehr",
    "fee",
    "comissão",
    "comissao",
    "taxa",
    "encargo",
    "external cost",
    "settlement fee",
  ],
} as const;

function matchAny(text: string, words: readonly string[]): boolean {
  for (const w of words) if (text.includes(w)) return true;
  return false;
}

interface CashClassification {
  type: ActivityType;
  subtype?: string;
}

function classifyCashType(
  typ: string,
  description: string,
  incoming: number,
): CashClassification | null {
  const t = (typ || "").toLowerCase();
  const d = (description || "").toLowerCase();
  const probe = `${t} ${d}`;

  // Staking → INTEREST with STAKING_REWARD subtype (Donkeyfolio convention).
  if (matchAny(probe, KEYWORDS.staking)) {
    return { type: ACT.INTEREST, subtype: "STAKING_REWARD" };
  }
  if (matchAny(probe, KEYWORDS.dividend)) return { type: ACT.DIVIDEND };
  if (matchAny(probe, KEYWORDS.interest)) return { type: ACT.INTEREST };
  if (matchAny(probe, KEYWORDS.tax)) return { type: ACT.TAX };
  if (matchAny(probe, KEYWORDS.fee)) return { type: ACT.FEE };
  // Saveback / Round-up: TR returns 1% of card spending. CREDIT/SAVEBACK so
  // it's separable from referral bonuses. Always incoming — but if the row
  // direction says outgoing (rare edge case), it'll fall through to the
  // generic in/out branch instead of being miscategorised here.
  if (incoming > 0 && matchAny(probe, KEYWORDS.saveback)) {
    return { type: ACT.CREDIT, subtype: "SAVEBACK" };
  }
  // Refund / reimbursement / chargeback. Direction-aware: a refund TO the
  // user is CREDIT/REFUND (incoming); a reversed refund (outgoing) falls
  // through to WITHDRAWAL.
  if (incoming > 0 && matchAny(probe, KEYWORDS.refund)) {
    return { type: ACT.CREDIT, subtype: "REFUND" };
  }
  // Settlement / rebooking / rounding — internal adjustment. Direction-aware:
  // tag as CREDIT (with SETTLEMENT subtype) regardless of sign, but use the
  // sign from incoming to set the activity-level amount direction.
  // We map both signs to CREDIT so they don't skew DEPOSIT/WITHDRAWAL totals.
  // (In practice these are usually a few cents.)
  if (matchAny(probe, KEYWORDS.settlement)) {
    return {
      type: incoming >= 0 ? ACT.CREDIT : ACT.WITHDRAWAL,
      subtype: "SETTLEMENT",
    };
  }
  // Bonus / referral / promo → CREDIT with BONUS subtype.
  if (matchAny(probe, KEYWORDS.bonus)) {
    return { type: ACT.CREDIT, subtype: "BONUS" };
  }

  // Generic in/out → deposit/withdrawal (covers "Transfer", "Depósito aceite",
  // "Auszahlung", "Withdrawal", "Lastschrift", anything else with cash flow).
  if (incoming > 0) return { type: ACT.DEPOSIT };
  if (incoming < 0) return { type: ACT.WITHDRAWAL };
  return null;
}

interface BuildOpts {
  accountId: string;
  currency: string;
  cash: CashTransaction[];
  trading: TradingTransaction[];
  /** Set of date|ISIN keys that should be skipped from cash (already covered by trading). */
  skipCashKeys: Set<string>;
  /** (v2.8) PDF SUMMARY's authoritative period totals. When provided, the
   *  builder appends a final RECONCILIATION activity that closes any drift
   *  between (sum of activity cash impacts) and the PDF's (ending − opening).
   *  This guarantees the imported cash balance matches TR's reported balance
   *  exactly — even when individual rows can't be parsed perfectly. */
  pdfSummary?: {
    opening: number;
    moneyIn: number;
    moneyOut: number;
    ending: number;
  };
  /** Latest activity date in the cash[] — used as the date for the
   *  reconciliation activity so it appears at the end of the timeline. */
  lastActivityDate?: string;
  /** (v2.10.2) Auto-detected stock splits to emit as SPLIT activities.
   *  Each entry produces one SPLIT row with `amount = numerator/denominator`
   *  (Donkeyfolio's snapshot service reads the ratio from `amount` —
   *  see crates/core snapshot_service::calculate_split_factors).
   *  Without these, ServiceNow-style 2:1 splits leave imported holdings at
   *  ~half the real share count (DB 10.55 vs TR 21.10). */
  autoSplits?: SplitEvent[];
}

// (v2.10.1) ISIN validation moved to tr-isin-utils.ts — see that file for
// the rationale. Previous inline `/\b[A-Z]{2}[A-Z0-9]{10}\b/` regex matched
// the word "SUBSCRIPTION", creating a fake asset that Yahoo failed to price.

export function buildActivitiesFromParsed(opts: BuildOpts): ActivityImport[] {
  const {
    accountId,
    currency,
    cash,
    trading,
    skipCashKeys,
    pdfSummary,
    lastActivityDate,
    autoSplits,
  } = opts;
  const activities: ActivityImport[] = [];
  let lineNumber = 1;

  // 1) Trading → BUY / SELL
  // Trade Republic fee model:
  //   - Manual Buy / Sell of stocks/ETFs: €1 flat external fee
  //   - Savings plan executions: free (€0)
  // The cash leg in the TR statement always shows the TOTAL cash flow
  // (including the fee). For Donkeyfolio's import the convention is:
  //   amount = qty × unitPrice  (gross trade value, NO fee)
  //   fee   = the €1 (or €0)    (separate field)
  // So we have to back the fee out of the cash amount before storing it.
  for (const tx of trading) {
    if (!tx.isin || !tx.date) continue;
    const qty = tx.quantity;
    if (!qty || qty <= 0) {
      // No quantity → can't create a proper BUY/SELL activity.
      continue;
    }

    const totalCash = Math.abs(tx.amount);
    const expectedFee = tx.isSavingsPlan ? 0 : 1;
    // For BUY: cash_out = gross + fee → gross = cash_out - fee
    // For SELL: cash_in = gross - fee → gross = cash_in + fee
    const grossAmount = tx.isBuy ? totalCash - expectedFee : totalCash + expectedFee;

    // Safety: if the trade is smaller than the fee (very rare, but defends
    // against bad data), keep the cash amount as-is and skip the fee.
    const useFeeAdjustment = grossAmount > 0;
    const amount = useFeeAdjustment ? grossAmount : totalCash;
    const fee = useFeeAdjustment ? expectedFee : 0;
    const unitPrice = amount / qty;
    if (unitPrice <= 0) continue;

    // Crypto pseudo-ISINs start with "XF000" (BTC/ETH/XRP/SOL etc.) — flag
    // those so the import resolves them differently than equities.
    const isCrypto = /^XF000/.test(tx.isin);
    activities.push({
      accountId,
      currency,
      activityType: tx.isBuy ? ACT.BUY : ACT.SELL,
      date: toIsoDate(tx.date),
      symbol: tx.isin,
      symbolName: tx.cleanStockName || tx.stockName,
      quantity: qty,
      unitPrice,
      amount,
      fee,
      // Hints the Donkeyfolio backend uses for symbol resolution & validation.
      // Without these, most rows were getting silently rejected during import
      // ("Imported 0 / N skipped").
      quoteCcy: currency,
      instrumentType: isCrypto ? "Crypto" : "Equity",
      comment: tx.isSavingsPlan ? "TR Savings plan" : undefined,
      lineNumber: lineNumber++,
      isValid: true,
      isDraft: false,
    });
  }

  // 1b) (v2.10.2) Stock splits — emit one SPLIT activity per detected split.
  //
  // Donkeyfolio convention (verified against
  // crates/core/src/portfolio/snapshot/snapshot_service.rs::calculate_split_factors):
  //   - activityType = "SPLIT"
  //   - amount       = numerator / denominator  (e.g. 2 for a 2:1 forward split)
  //   - quantity     = 1 (placeholder — wizard requires a positive qty;
  //                       the snapshot service reads the ratio from `amount`)
  //   - unitPrice    = 0
  //   - symbol       = ISIN (matches the BUY/SELL rows above so the asset_id
  //                          resolves identically)
  //
  // The Rust side adjusts every NON-SPLIT activity dated BEFORE the split's
  // date by the cumulative ratio. So a 2:1 split with `amount=2` doubles
  // pre-split quantities, which is exactly what we want for ServiceNow.
  if (autoSplits && autoSplits.length > 0) {
    for (const sp of autoSplits) {
      if (!sp.isin || !sp.date) continue;
      const ratio = sp.numerator / sp.denominator;
      if (!Number.isFinite(ratio) || ratio <= 0) continue;
      activities.push({
        accountId,
        currency,
        activityType: "SPLIT",
        date: `${sp.date}T00:00:00.000Z`,
        symbol: sp.isin,
        symbolName: sp.stockName,
        // SPLIT ratio lives in `amount`. quantity/unitPrice are placeholders
        // to satisfy the import wizard's "must be positive" check.
        amount: ratio,
        quantity: 1,
        unitPrice: 0,
        fee: 0,
        quoteCcy: currency,
        instrumentType: "Equity",
        comment: `TR auto-split: ${sp.ticker} ${sp.ratio} on ${sp.date} (Yahoo Finance)`,
        lineNumber: lineNumber++,
        isValid: true,
        isDraft: false,
      });
    }
  }

  // 2) Cash rows NOT tied to a trade → DEPOSIT / WITHDRAWAL / INTEREST / etc.
  // Donkeyfolio's import wizard requires quantity > 0 on every row (it's a
  // mandatory field), so for cash activities we follow the same convention
  // the AI Importer uses:
  //     quantity  = 1
  //     unitPrice = amount
  //     amount    = amount
  // That keeps amount = qty × unitPrice consistent and lets the wizard accept
  // the row. For DIVIDEND/INTEREST a per-share breakdown is irrelevant — the
  // total cash received is what matters.
  for (const c of cash) {
    const inc = parseEuroAmount(c.zahlungseingang);
    const out = parseEuroAmount(c.zahlungsausgang);
    const signed = inc - out;
    if (signed === 0) continue;

    const isin = extractIsin(c.beschreibung);
    const key = isin ? `${c.datum}|${isin}` : "";
    if (key && skipCashKeys.has(key)) continue;

    const classification = classifyCashType(c.typ, c.beschreibung, signed);
    if (!classification) continue;

    const amount = Math.abs(signed);
    // Tag DIVIDEND/INTEREST rows tied to a security as Equity; pure cash
    // flows stay generic.
    const symbol = isin || "$CASH-EUR";
    const isSecurityTied = !!isin;
    activities.push({
      accountId,
      currency,
      activityType: classification.type,
      subtype: classification.subtype,
      date: toIsoDate(c.datum),
      symbol,
      amount,
      quantity: 1,
      unitPrice: amount,
      fee: 0,
      quoteCcy: currency,
      instrumentType: isSecurityTied ? "Equity" : "Cash",
      comment: c.beschreibung?.slice(0, 200) || undefined,
      lineNumber: lineNumber++,
      isValid: true,
      isDraft: false,
    });
  }

  // 3) (v2.8) Auto-reconciliation: if the PDF SUMMARY block was parsed,
  // compute the gap between sum-of-activity-cash-impacts and the period's
  // (ending − opening) and emit a single CREDIT/WITHDRAWAL activity to
  // close it. This guarantees the imported cash balance matches TR's
  // reported balance exactly, even when row-level parsing has residual
  // drift (multi-line layouts, lost rows, etc.).
  if (pdfSummary && Number.isFinite(pdfSummary.ending - pdfSummary.opening)) {
    const targetNet = pdfSummary.ending - pdfSummary.opening;
    let actualNet = 0;
    for (const a of activities) {
      const amt = typeof a.amount === "number" ? a.amount : parseFloat(a.amount || "0") || 0;
      const fee = typeof a.fee === "number" ? a.fee : parseFloat(a.fee || "0") || 0;
      switch (a.activityType) {
        case ACT.DEPOSIT:
        case ACT.DIVIDEND:
        case ACT.INTEREST:
        case ACT.CREDIT:
          actualNet += amt;
          break;
        case ACT.WITHDRAWAL:
        case ACT.TAX:
        case ACT.FEE:
          actualNet -= amt;
          break;
        case ACT.BUY:
          actualNet -= amt + fee;
          break;
        case ACT.SELL:
          actualNet += amt - fee;
          break;
      }
    }
    const gap = targetNet - actualNet;
    // Only emit if gap is material (> €0.50) — sub-cent rounding noise
    // doesn't deserve its own activity. Above that threshold the
    // reconciliation is meaningful and auditable.
    if (Math.abs(gap) >= 0.5) {
      const isInflow = gap > 0;
      // (v2.14.0) lastActivityDate comes from cash[].datum which is TR's
      // raw format ("29 Apr 2026" / "29.04.2026") — Donkeyfolio rejects
      // anything that isn't ISO 8601. Run it through toIsoDate() before
      // assigning. Previous versions silently shipped the raw string and
      // the activities import skipped one row with "Invalid date format".
      const reconcileDate = lastActivityDate
        ? toIsoDate(lastActivityDate)
        : new Date().toISOString();
      activities.push({
        accountId,
        currency,
        activityType: isInflow ? ACT.CREDIT : ACT.WITHDRAWAL,
        subtype: "TR_RECONCILIATION",
        date: reconcileDate,
        symbol: "$CASH-EUR",
        amount: Math.abs(gap),
        quantity: 1,
        unitPrice: Math.abs(gap),
        fee: 0,
        quoteCcy: currency,
        instrumentType: "Cash",
        comment: `Auto-reconciliation: closes €${gap.toFixed(2)} drift between activities (€${actualNet.toFixed(2)}) and PDF SUMMARY net flow (€${targetNet.toFixed(2)}). Cash now matches TR's reported ending balance €${pdfSummary.ending.toFixed(2)}.`,
        lineNumber: lineNumber++,
        isValid: true,
        isDraft: false,
      });
    }
  }

  return activities;
}

/**
 * Build a set of "date|ISIN" keys that identify cash rows already covered
 * by a trading transaction — so we don't import the same event twice
 * (once as BUY and once as WITHDRAWAL).
 *
 * IMPORTANT: only include trades that will actually be imported as
 * BUY/SELL (i.e. have a usable quantity). Otherwise we silently drop both
 * the trade (no qty → skipped in buildActivitiesFromParsed) AND its cash
 * leg (skipped here), evaporating €X of cash flow per dropped trade. On a
 * typical TR yearly statement with ~100 trades whose qty couldn't be
 * extracted, this used to produce a ~€2-9k phantom shortfall in the imported
 * cash balance.
 */
export function buildTradingCashKeys(trading: TradingTransaction[]): Set<string> {
  const keys = new Set<string>();
  for (const tx of trading) {
    if (tx.date && tx.isin && tx.quantity && tx.quantity > 0) {
      keys.add(`${tx.date}|${tx.isin}`);
    }
  }
  return keys;
}

// ───────────────────────────────────────────────────────────────────
// CSV export for the Donkeyfolio Import Activities wizard
// Columns match those expected in the mapping step:
//   date* | account | activityType* | symbol* | isin | quantity* |
//   unitPrice* | amount* | currency | fee | comment | subtype |
//   instrumentType
// ───────────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function isoDateOnly(d: Date | string | undefined): string {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function buildDonkeyfolioCsv(
  activities: ActivityImport[],
  opts: { accountName?: string } = {},
): string {
  const accountName = opts.accountName ?? "Trade Republic";
  const headers = [
    "date",
    "account",
    "activityType",
    "symbol",
    "isin",
    "quantity",
    "unitPrice",
    "amount",
    "currency",
    "fee",
    "comment",
    "subtype",
    "instrumentType",
  ];
  const lines: string[] = [headers.join(",")];
  for (const a of activities) {
    const sym = a.symbol || "";
    // TR symbols are always ISIN; populate both columns so the wizard can
    // match by either.
    const isISIN = /^[A-Z]{2}[A-Z0-9]{10}$/.test(sym);
    const row = [
      isoDateOnly(a.date),
      accountName,
      a.activityType,
      sym,
      isISIN ? sym : "",
      a.quantity ?? "",
      a.unitPrice ?? "",
      a.amount ?? "",
      a.currency || "EUR",
      a.fee ?? "",
      a.comment ?? "",
      a.subtype ?? "",
      // Instrument hint — ETFs use "Equity" in the wizard.
      a.activityType === "BUY" || a.activityType === "SELL" ? "Equity" : "",
    ];
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\n");
}
