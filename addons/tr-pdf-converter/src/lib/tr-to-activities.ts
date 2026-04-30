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
import { lookupTicker } from "./tr-isin-tickers";
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

export function toIsoDate(raw: string): string {
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
  // (v2.15.0) Dividend reinvestment plan — TR sometimes pays dividend
  // directly as fractional shares of the same security ("DRIP"). When
  // detected, classify as DIVIDEND with subtype=DRIP so Wealthfolio's
  // import wizard treats it as an asset-backed cash event.
  drip: [
    "drip",
    "reinvest",
    "réinvest",
    "reinvestido",
    "dividend reinvestment",
    "dividendo reinvestido",
    "wiederanlage",
  ],
  // (v2.15.0) Stock distribution / dividend-in-kind / spin-off — extra
  // shares received from a corporate action. Classified as BUY with
  // subtype=DIVIDEND_IN_KIND so the share count grows but no cash flows.
  stockDistribution: [
    "stock distribution",
    "dividend in kind",
    "dividend in shares",
    "dividendo em ações",
    "dividendo em acoes",
    "spin-off",
    "spinoff",
    "ausschüttung in aktien",
  ],
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
  // (v2.15.0) Dividend reinvestment / stock distribution — check BEFORE
  // generic dividend so the more specific subtype wins. DRIP and stock
  // distributions both end up as DIVIDEND in TR's cash section, but with
  // distinct payout mechanisms (reinvested as shares vs. extra shares).
  if (matchAny(probe, KEYWORDS.drip)) {
    return { type: ACT.DIVIDEND, subtype: "DRIP" };
  }
  if (matchAny(probe, KEYWORDS.stockDistribution)) {
    return { type: ACT.DIVIDEND, subtype: "DIVIDEND_IN_KIND" };
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
  /** (v2.20.0) EUR→quoteCcy FX rates by `${ccy}|${YYYY-MM-DD}` key.
   *  Resolved upstream via Frankfurter (ECB official daily rates). When a
   *  trade's asset quotes in a non-EUR currency (USD typically), the
   *  matching rate is attached as `activity.fxRate` so Donkeyfolio's
   *  holdings calculator can attribute cost basis in the asset's quote
   *  currency, matching what the TR app shows for Avg cost. */
  fxRates?: Map<string, number>;
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
    fxRates,
  } = opts;
  const activities: ActivityImport[] = [];
  let lineNumber = 1;

  // (v2.15.0) Deduplicate SELL rows by (date, isin, qty, amount). The TR
  // PDF parser sometimes emits the same SELL row twice when the
  // confirmation line is split across multiple visual lines (e.g. MSFT
  // 2024-08-05: 1 BUY 20 shares + 2 phantom SELLs of 20 shares). Real same-
  // day same-amount SELLs would have the SAME tradeId — so dedup keeps the
  // first occurrence and drops subsequent ones with identical signature.
  // BUYs are NOT deduplicated because legitimate same-day same-amount
  // savings-plan executions are common (handled by the qty queue in
  // enrichTradingWithQuantity, not here).
  const sellSeen = new Set<string>();
  const dedupedTrading: TradingTransaction[] = [];
  for (const tx of trading) {
    if (!tx.isBuy) {
      const sig = `${tx.date}|${tx.isin}|${tx.quantity}|${Math.abs(tx.amount).toFixed(2)}`;
      if (sellSeen.has(sig)) continue;
      sellSeen.add(sig);
    }
    dedupedTrading.push(tx);
  }

  // (v2.19.11 / v2.20.2) Aggregate partial fills of the same logical TR order.
  // TR sometimes splits a single order into multiple PDF cash rows when
  // it executes the order in batches (e.g. user submits ONE buy of 2.036383
  // ServiceNow shares, TR fills it as 2 + 0.036383 in two rows). The TR
  // app aggregates these for display and only charges €1 fee on the order
  // total — but our previous code created one BUY per fill and applied €1
  // to EACH, doubling the fee and producing wrong unitPrices.
  //
  // Aggregation strategy (v2.20.2 rewrite for robustness):
  //   PRIMARY: same date + ISIN + isBuy + isSavingsPlan + tradeId
  //            (when tradeId present, this is unambiguous)
  //   FALLBACK: same date + ISIN + isBuy + isSavingsPlan + similar unit
  //            price (≤2% drift). Catches partial fills where TR's PDF
  //            description doesn't include the order ID — verified
  //            against ServiceNow Apr 24 case (qty 2 @ €73.66 + qty
  //            0.036383 @ implied €73.66, matching TR app's single
  //            2.036383 × €73.66 + €1 fee transaction).
  //
  // Why limited to ≤2% unit-price drift: protects against accidentally
  // collapsing a manual BUY at €73.66 with a separate savings-plan BUY at
  // €73.71 on the same day (different orders, different fees). Real
  // partial fills always execute at the same price (TR settles them at
  // the order's average fill price by design).
  const aggregated: TradingTransaction[] = [];
  const aggIndex = new Map<string, number>();
  for (const tx of dedupedTrading) {
    const baseKey = `${tx.date}|${tx.isin}|${tx.isBuy ? "B" : "S"}|${
      tx.isSavingsPlan ? "SP" : "M"
    }`;
    const txQty = tx.quantity ?? 0;
    const txAmount = Math.abs(tx.amount);
    const txUnit = txQty > 0 ? txAmount / txQty : 0;

    // Try tradeId-keyed match first.
    if (tx.tradeId) {
      const tradeKey = `${baseKey}|tid:${tx.tradeId}`;
      const idx = aggIndex.get(tradeKey);
      if (idx !== undefined) {
        mergeInto(aggregated, idx, tx);
        continue;
      }
      aggIndex.set(tradeKey, aggregated.length);
      aggregated.push(tx);
      continue;
    }

    // Fallback: scan existing aggregated entries with the same base key
    // and similar unit price. Same-day same-asset same-direction without
    // tradeId is rare (manual: 1 trade/day typical; savings: 1/asset/day),
    // so this loop almost always finds 0 or 1 match.
    let matchedIdx = -1;
    for (let i = aggregated.length - 1; i >= 0; i--) {
      const existing = aggregated[i];
      const existingKey = `${existing.date}|${existing.isin}|${
        existing.isBuy ? "B" : "S"
      }|${existing.isSavingsPlan ? "SP" : "M"}`;
      if (existingKey !== baseKey) continue;
      // Unit-price proximity check (skip when one side has no qty).
      const existingQty = existing.quantity ?? 0;
      const existingAmount = Math.abs(existing.amount);
      const existingUnit = existingQty > 0 ? existingAmount / existingQty : 0;
      if (existingUnit > 0 && txUnit > 0) {
        const drift = Math.abs(existingUnit - txUnit) / existingUnit;
        if (drift <= 0.02) {
          matchedIdx = i;
          break;
        }
      } else {
        // One side has no qty (rare). Merge anyway since we have nothing
        // better to discriminate by — same date+ISIN+direction is strong.
        matchedIdx = i;
        break;
      }
    }
    if (matchedIdx >= 0) {
      mergeInto(aggregated, matchedIdx, tx);
      continue;
    }
    aggregated.push(tx);
  }

  function mergeInto(arr: TradingTransaction[], idx: number, incoming: TradingTransaction) {
    const existing = arr[idx];
    const sumQty = (existing.quantity ?? 0) + (incoming.quantity ?? 0);
    const sumAmount = Math.abs(existing.amount) + Math.abs(incoming.amount);
    arr[idx] = {
      ...existing,
      quantity: sumQty > 0 ? sumQty : existing.quantity,
      amount: existing.isBuy ? sumAmount : -sumAmount,
      unitPrice: sumQty > 0 ? sumAmount / sumQty : existing.unitPrice,
      // Preserve the first non-empty PDF fee found across the merged rows
      // — TR usually prints Fremdkostenzuschlag once per ORDER, not per
      // fill, so whichever fragment has it carries the canonical value.
      pdfFee: existing.pdfFee ?? incoming.pdfFee,
      pdfFeeCurrency: existing.pdfFeeCurrency ?? incoming.pdfFeeCurrency,
    };
  }

  // 1) Trading → BUY / SELL
  // Trade Republic fee model:
  //   - Manual Buy / Sell of stocks/ETFs: €1 flat external fee
  //   - Savings plan executions: free (€0)
  // The cash leg in the TR statement always shows the TOTAL cash flow
  // (including the fee). For Donkeyfolio's import the convention is:
  //   amount = qty × unitPrice  (gross trade value, NO fee)
  //   fee   = the €1 (or €0)    (separate field)
  // (v2.20.0) Fee resolution priority:
  //   1. Read explicit fee from PDF (Fremdkostenzuschlag / External cost
  //      surcharge / Encargos externos / Sobretaxa de execução / etc.) when
  //      TR included it inline. Source-of-truth, currency-aware.
  //   2. Fallback heuristic: €1 manual / €0 savings plan. Used when the PDF
  //      doesn't print the fee line (typical for the Portugal account
  //      statement layout, which only shows totals in cash log).
  //
  // So we have to back the fee out of the cash amount before storing it.
  for (const tx of aggregated) {
    if (!tx.isin || !tx.date) continue;
    const qty = tx.quantity;
    if (!qty || qty <= 0) {
      // No quantity → can't create a proper BUY/SELL activity.
      continue;
    }

    const totalCash = Math.abs(tx.amount);
    // Fee resolution: PDF line wins over heuristic when present.
    const heuristicFee = tx.isSavingsPlan ? 0 : 1;
    const resolvedFee = tx.pdfFee ?? heuristicFee;
    // For BUY: cash_out = gross + fee → gross = cash_out - fee
    // For SELL: cash_in = gross - fee → gross = cash_in + fee
    const grossAmount = tx.isBuy ? totalCash - resolvedFee : totalCash + resolvedFee;

    // Safety: if the trade is smaller than the fee (very rare, but defends
    // against bad data), keep the cash amount as-is and skip the fee.
    const useFeeAdjustment = grossAmount > 0;
    const amount = useFeeAdjustment ? grossAmount : totalCash;
    const fee = useFeeAdjustment ? resolvedFee : 0;
    const unitPrice = amount / qty;
    if (unitPrice <= 0) continue;

    // Crypto pseudo-ISINs start with "XF000" (BTC/ETH/XRP/SOL etc.) — flag
    // those so the import resolves them differently than equities.
    const isCrypto = /^XF000/.test(tx.isin);
    // (v2.20.0) Look up the asset's quote currency. USD-quoted equities
    // (MSFT, NVDA, etc.) need an fxRate per trade so cost basis attribution
    // matches the TR app's Avg cost (which is computed against TR's
    // execution-day FX, not today's spot).
    const mapped = lookupTicker(tx.isin);
    const assetQuoteCcy = mapped?.quoteCcy ?? currency;
    const tradeIsoDate = toIsoDate(tx.date).slice(0, 10);
    let fxRate: number | undefined;
    if (assetQuoteCcy !== currency && fxRates) {
      const rate = fxRates.get(`${assetQuoteCcy}|${tradeIsoDate}`);
      if (typeof rate === "number" && rate > 0) fxRate = rate;
    }
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
      fxRate,
      // Hints the Donkeyfolio backend uses for symbol resolution & validation.
      // Without these, most rows were getting silently rejected during import
      // ("Imported 0 / N skipped").
      quoteCcy: assetQuoteCcy,
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
 * (v2.17.0) Build INTEREST/Staking Reward activities for crypto holdings
 * that received staking rewards on TR — these don't appear in the Account
 * Statement PDF (only cash flows are listed) so we add them post-hoc based
 * on user input from the Crypto Reconciliation panel.
 *
 * Wealthfolio docs: "INTEREST with Staking Reward subtype: Crypto staking
 * income received as additional tokens. Records the interest income and
 * the resulting token acquisition." So a single activity with qty + amount
 * does both: increase token holdings AND register cost basis.
 *
 * Each entry must have:
 *   - isin       (e.g. XF000SOL0012)
 *   - symbol     (e.g. SOL-EUR)
 *   - stakingQty (e.g. 0.527)
 *   - stakingValueEur (e.g. 45.55 — total fair-value at receipt, cumulative)
 *   - date       (YYYY-MM-DD; usually the last activity date in the import)
 */
export interface StakingReconcileEntry {
  isin: string;
  symbol: string;
  symbolName?: string;
  stakingQty: number;
  stakingValueEur: number;
  date: string;
}

export function buildStakingActivities(
  entries: StakingReconcileEntry[],
  accountId: string,
  currency: string,
  startingLine: number,
): ActivityImport[] {
  const activities: ActivityImport[] = [];
  let lineNumber = startingLine;
  for (const e of entries) {
    if (!e.stakingQty || e.stakingQty <= 0) continue;
    if (!Number.isFinite(e.stakingValueEur) || e.stakingValueEur < 0) continue;
    const unitPrice = e.stakingQty > 0 ? e.stakingValueEur / e.stakingQty : 0;
    // (v2.19.1) Use ISIN (XF000xxx) as the activity symbol so the import
    // routing in tr-converter-page.tsx (handleImport) classifies it as a
    // CRYPTO pseudo-ISIN and creates the correct CRYPTO asset profile,
    // not a generic EQUITY asset named "SOL-EUR".
    const symbolForRouting = e.isin || e.symbol;
    const tickerCode = e.symbol.split("-")[0]; // e.g. "SOL-EUR" → "SOL"
    activities.push({
      accountId,
      currency,
      activityType: ACT.INTEREST,
      subtype: "Staking Reward",
      date: `${e.date}T00:00:00.000Z`,
      symbol: symbolForRouting,
      symbolName: e.symbolName,
      quantity: e.stakingQty,
      unitPrice,
      amount: e.stakingValueEur,
      fee: 0,
      quoteCcy: currency,
      instrumentType: "Crypto",
      comment: `TR cumulative staking reward: ${e.stakingQty.toFixed(6)} ${tickerCode} = €${e.stakingValueEur.toFixed(2)}`,
      lineNumber: lineNumber++,
      isValid: true,
      isDraft: false,
    });
  }
  return activities;
}

/**
 * (v2.19.1) Scale crypto BUY/SELL activity quantities so the holding total
 * for each crypto matches a user-supplied target. This is the proper fix
 * for the "Compra direta" price-imprecision problem: instead of relying on
 * Yahoo daily-close prices (which can be 0.5–50% off intraday execution),
 * we accept the user's TR-app qty as ground truth and scale every
 * Compra/Venda direta + Buy/Sell trade + Savings plan row proportionally.
 *
 * The activity `amount` (cash impact) stays constant — only `quantity`
 * scales. `unitPrice` is recomputed as `amount / new_quantity` so the
 * row-level invariant `quantity × unitPrice = amount` holds.
 *
 * After scaling: sum(BUY_qty) − sum(SELL_qty) = targetQty exactly.
 *
 * Returns the same activities array, mutated. Caller is expected to pass
 * the same array reference used elsewhere; we don't deep-copy.
 */
export function scaleCryptoBuysToTarget(
  activities: ActivityImport[],
  isinTargets: Map<string, number>,
): { isin: string; oldTotal: number; newTotal: number; scale: number }[] {
  const log: { isin: string; oldTotal: number; newTotal: number; scale: number }[] = [];
  for (const [isin, target] of isinTargets) {
    if (target <= 0) continue;
    const tradeIdxs: number[] = [];
    let oldTotal = 0;
    for (let i = 0; i < activities.length; i++) {
      const a = activities[i];
      if (a.symbol !== isin) continue;
      if (a.activityType !== ACT.BUY && a.activityType !== ACT.SELL) continue;
      const qty = typeof a.quantity === "number" ? a.quantity : 0;
      if (!qty || qty <= 0) continue;
      tradeIdxs.push(i);
      oldTotal += a.activityType === ACT.BUY ? qty : -qty;
    }
    if (oldTotal <= 0 || tradeIdxs.length === 0) continue;
    const scale = target / oldTotal;
    if (Math.abs(scale - 1) < 1e-6) {
      log.push({ isin, oldTotal, newTotal: oldTotal, scale: 1 });
      continue;
    }
    for (const i of tradeIdxs) {
      const a = activities[i];
      const oldQty = typeof a.quantity === "number" ? a.quantity : 0;
      const amt = typeof a.amount === "number" ? a.amount : 0;
      const newQty = oldQty * scale;
      a.quantity = newQty;
      a.unitPrice = newQty > 0 ? amt / newQty : 0;
    }
    log.push({ isin, oldTotal, newTotal: target, scale });
  }
  return log;
}

/**
 * (v2.17.0) Build TRANSFER_IN activities for crypto qty corrections that
 * are NOT staking — i.e. price-imprecision in our "Compra direta" qty
 * estimation. When the user reports TR qty > computed qty AND we've already
 * accounted for staking, the residual goes here as a no-cash transfer-in
 * to top up the holding to match TR exactly.
 *
 * cost basis for the topped-up qty defaults to the last cash-buy avg price
 * (so it doesn't distort the realized gain on later sells). Caller can
 * override via `costBasisEur`.
 */
export interface QtyAdjustmentEntry {
  isin: string;
  symbol: string;
  symbolName?: string;
  qtyDelta: number; // positive: add shares; negative: remove
  costBasisEur: number; // typically qtyDelta × current cash avg
  date: string;
}

export function buildQtyAdjustments(
  entries: QtyAdjustmentEntry[],
  accountId: string,
  currency: string,
  startingLine: number,
): ActivityImport[] {
  const activities: ActivityImport[] = [];
  let lineNumber = startingLine;
  for (const e of entries) {
    if (!e.qtyDelta || Math.abs(e.qtyDelta) < 1e-9) continue;
    const isPositive = e.qtyDelta > 0;
    const unitPrice = e.qtyDelta !== 0 ? Math.abs(e.costBasisEur / e.qtyDelta) : 0;
    activities.push({
      accountId,
      currency,
      activityType: isPositive ? "TRANSFER_IN" : "TRANSFER_OUT",
      subtype: "TR_QTY_RECONCILE",
      date: `${e.date}T00:00:00.000Z`,
      symbol: e.symbol,
      symbolName: e.symbolName,
      quantity: Math.abs(e.qtyDelta),
      unitPrice,
      amount: Math.abs(e.costBasisEur),
      fee: 0,
      quoteCcy: currency,
      instrumentType: "Crypto",
      comment: `TR qty reconcile (price imprecision on Compra direta): ${e.qtyDelta > 0 ? "+" : ""}${e.qtyDelta.toFixed(6)} ${e.symbol.split("-")[0]}`,
      lineNumber: lineNumber++,
      isValid: true,
      isDraft: false,
    });
  }
  return activities;
}

/**
 * (v2.18.0) Build TRANSFER_IN activities for holdings that the user adds
 * manually via the reconciliation panel — used for spin-offs, gifts,
 * inheritances, or any position TR doesn't capture in cash transactions.
 *
 * Cost basis is preserved via TRANSFER_IN's `amount` field per Wealthfolio
 * convention. The parent asset (for spin-offs) is NOT touched in v2.18 —
 * user must manually adjust parent cost basis in Donkeyfolio UI if needed.
 */
export interface ManualHoldingEntry {
  symbol: string;
  isin?: string;
  name?: string;
  quantity: number;
  costBasisEur: number;
  date: string; // YYYY-MM-DD
  source?: string; // "Spin-off from HON", "Gift", etc — goes into the comment
  parentSymbol?: string; // optional, for tagging spin-off parent
  instrumentType?: string; // "Equity" | "Crypto" | "Bond" — defaults to Equity
}

export function buildManualHoldingActivities(
  entries: ManualHoldingEntry[],
  accountId: string,
  currency: string,
  startingLine: number,
): ActivityImport[] {
  const activities: ActivityImport[] = [];
  let lineNumber = startingLine;
  for (const e of entries) {
    if (!e.symbol || !e.quantity || e.quantity <= 0) continue;
    if (!Number.isFinite(e.costBasisEur) || e.costBasisEur < 0) continue;
    const unitPrice = e.quantity > 0 ? e.costBasisEur / e.quantity : 0;
    const sourceTag = e.source ? ` (${e.source})` : "";
    activities.push({
      accountId,
      currency,
      activityType: "TRANSFER_IN",
      subtype: "TR_MANUAL_ADD",
      date: `${e.date}T00:00:00.000Z`,
      symbol: e.symbol,
      symbolName: e.name,
      quantity: e.quantity,
      unitPrice,
      amount: e.costBasisEur,
      fee: 0,
      quoteCcy: currency,
      instrumentType: e.instrumentType || "Equity",
      comment: `Manual holding add${sourceTag}: ${e.quantity.toFixed(6)} @ €${unitPrice.toFixed(4)}`,
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
