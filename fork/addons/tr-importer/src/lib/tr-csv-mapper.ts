/**
 * Trade Republic CSV → Wealthfolio `ActivityCreate[]` mapper.
 *
 * Pure functions: takes parsed CSV rows + a target accountId, returns the
 * activities to import + a list of notes (unmapped types, skipped rows,
 * resolved corporate-action pairs). No I/O, no SDK calls.
 *
 * Mapping rules — validated with the user against TR's official PDF
 * Account Statement on the full 4222-row history:
 *
 *   TRADING/BUY  → BUY  (fee = |fee_csv| + |tax_csv| rolls in FTT/stamp)
 *   TRADING/SELL → SELL (same fee rule)
 *   CASH/DIVIDEND → DIVIDEND (NET amount; gross+WHT preserved in metadata
 *                              for the future Tax Report panel)
 *   CASH/INTEREST_PAYMENT → INTEREST
 *   CASH/BENEFITS_SAVEBACK → CREDIT (subtype REBATE for "Saveback",
 *                                     BONUS for "Fixed income bonus")
 *   CASH/CUSTOMER_INBOUND        ↘
 *   CASH/TRANSFER_INBOUND         → DEPOSIT
 *   CASH/TRANSFER_INSTANT_INBOUND ↗
 *   CASH/TRANSFER_INSTANT_OUTBOUND → WITHDRAWAL
 *   CASH/CARD_TRANSACTION*        → consolidated monthly WITHDRAWAL
 *   CASH/CARD_ORDERING_FEE        → FEE
 *   CORPORATE_ACTION/SPLIT        → SPLIT (ratio computed from delta vs
 *                                          pre-split position)
 *   CORPORATE_ACTION/MERGER       → 2× ADJUSTMENT (out old / in new)
 *   CORPORATE_ACTION/SPIN_OFF     → TRANSFER_IN (cancelled-pair net resolved)
 *   CORPORATE_ACTION/STOCK_DIVIDEND → DIVIDEND subtype DIVIDEND_IN_KIND
 *                                     (cancelled-pair net resolved)
 *   CORPORATE_ACTION/WORTHLESS    → SELL @ unitPrice=0 (zeros out position)
 *   DELIVERY/FREE_RECEIPT         → TRANSFER_IN (TR Crypto staking, qty only)
 *
 * Key design choices, with the why:
 *
 * 1) `fee = |fee| + |tax|` for BUY/SELL rolls non-WHT taxes (French FTT,
 *    Italian/Spanish stamp duty) into the trade fee. Single activity per
 *    trade keeps the activity list legible. Cash-balance impact is correct
 *    by construction.
 *
 * 2) DIVIDEND records the NET amount the user actually received. Gross +
 *    WHT live in `metadata.tr_gross` / `metadata.tr_wht` for the Tax
 *    Report panel. Per user decision: "fica só o líquido — IRS é outra
 *    história para já".
 *
 * 3) CARD_TRANSACTION rows (113 in the test dataset, ~€-5,715 net) are
 *    NOT imported individually — those are personal expenses (groceries,
 *    coffee), not investment activity. We collapse them per calendar
 *    month into a single WITHDRAWAL with the net cash impact + a count
 *    of underlying transactions in the comment. Refunds (positive amounts)
 *    net into the same monthly figure, which is correct: a €50 refund
 *    in the same month as €100 of spend yields a €-50 monthly net.
 *
 * 4) Corporate-action CANCELLED pairs (STOCK_DIVIDEND_CANCELLED and
 *    SPIN_OFF_CANCELLED) are resolved BEFORE per-row mapping. TR records
 *    these as "applied → cancelled → re-applied" triplets that net to
 *    a single occurrence. Resolving early avoids emitting phantom
 *    activities the user would have to clean up manually.
 *
 * 5) Crypto symbols are appended with "-EUR" (BTC → BTC-EUR, ETH →
 *    ETH-EUR, etc.) since TR settles all crypto in EUR and Wealthfolio's
 *    Yahoo lookups use EUR pairs. Pinned by user decision.
 *
 * 6) DCA detection: BUY rows whose description starts with "Savings plan
 *    execution" are flagged with `metadata.tr_dca = true`. Useful for
 *    the dashboard's DCA insights panel, but doesn't change the activity
 *    type or amount.
 *
 * 7) The transaction_id from TR (UUID, 4222/4222 unique in the test
 *    dataset) is preserved on every emitted activity in
 *    `metadata.tr_transaction_id`. The incremental-import flow uses this
 *    to skip rows already imported.
 */

import type { ActivityCreate } from "@wealthfolio/addon-sdk";

import { resolveCountry } from "./tr-geography";
import { lookupTicker } from "./tr-isin-tickers";
import { type TrCsvRow } from "./tr-csv-parser";

export interface MapperOptions {
  accountId: string;
  /** When true, CARD_TRANSACTION/CARD_TRANSACTION_INTERNATIONAL rows are
   *  collapsed into 1 WITHDRAWAL per month. When false, each row maps to
   *  its own WITHDRAWAL (verbose but lossless). Default true. */
  consolidateCard?: boolean;
}

export interface MapperResult {
  activities: ActivityCreate[];
  notes: MapperNote[];
}

export interface MapperNote {
  rowIndex?: number;
  kind:
    | "unknown_type"
    | "missing_data"
    | "card_consolidated"
    | "cancelled_pair_resolved"
    | "split_ratio"
    | "merger_pair";
  message: string;
}

const TR_SOURCE_SYSTEM = "TR_CSV";
const IDEMPOTENCY_PREFIX = "tr-importer:v4";

/**
 * Stamp source-tracking + idempotency fields on every emitted activity.
 *
 * Why this exists:
 *   The Rust backend computes `idempotency_key` as SHA-256 of
 *   (account, type, date, asset, qty, unit_price, amount, currency,
 *   source_record_id, notes). When 2 BUYs share the same date, asset,
 *   amount and qty (routine on TR savings plans — multiple same-day
 *   executions of the same DCA), the hash collides and the second
 *   insert is rejected with "Duplicate activity detected".
 *
 *   Passing an EXPLICIT `idempotencyKey` derived from TR's globally
 *   unique `transaction_id` UUID guarantees no false collisions across
 *   any pair of distinct CSV rows.
 */
function tagSource<T extends ActivityCreate>(activity: T, recordId: string): T {
  const out = activity as T & {
    sourceSystem?: string;
    sourceRecordId?: string;
    idempotencyKey?: string;
  };
  out.sourceSystem = TR_SOURCE_SYSTEM;
  out.sourceRecordId = recordId;
  out.idempotencyKey = `${IDEMPOTENCY_PREFIX}:${recordId}`;
  return out;
}

/**
 * Map a list of parsed TR CSV rows to Wealthfolio `ActivityCreate[]`.
 */
export function mapTrCsvToActivities(rows: TrCsvRow[], opts: MapperOptions): MapperResult {
  const consolidateCard = opts.consolidateCard ?? true;
  const activities: ActivityCreate[] = [];
  const notes: MapperNote[] = [];

  // ── Pass 1: pre-resolve corporate-action cancellations.
  // TR can record a stock dividend or spin-off as +X / -X / +X (the
  // middle row is the cancellation). The net effect is a single +X.
  // Flag the cancellation and the duplicate so the per-row mapper
  // skips them.
  const skipRowIndexes = new Set<number>();
  resolveCancelledPairs(rows, skipRowIndexes, notes);

  // ── Pass 2: collect card transactions for monthly consolidation.
  const cardRows: TrCsvRow[] = [];

  // ── Pass 3: emit one activity per remaining row.
  for (const row of rows) {
    if (skipRowIndexes.has(row.rowIndex)) continue;

    if (
      consolidateCard &&
      (row.type === "CARD_TRANSACTION" || row.type === "CARD_TRANSACTION_INTERNATIONAL")
    ) {
      cardRows.push(row);
      continue;
    }

    const mapped = mapRow(row, opts.accountId, notes);
    if (mapped) {
      // Same row can produce 1+ activities (rare). Disambiguate the
      // idempotency key by appending an index when we see > 1.
      mapped.forEach((a, idx) => {
        const key = mapped.length === 1 ? row.transactionId : `${row.transactionId}#${idx}`;
        activities.push(tagSource(a, key));
      });
    }
  }

  // ── Pass 4: emit one consolidated WITHDRAWAL per month for cards.
  if (cardRows.length > 0) {
    const consolidated = consolidateCardByMonth(cardRows, opts.accountId, rows);
    for (const a of consolidated) {
      // Card consolidation: synthetic key per period; safe across re-imports.
      const periodMatch = /tr_period":"([^"]+)"/.exec(
        typeof a.metadata === "string" ? a.metadata : "",
      );
      const period = periodMatch?.[1] ?? a.activityDate;
      activities.push(tagSource(a, `card-monthly-${period}`));
    }
    notes.push({
      kind: "card_consolidated",
      message: `Consolidated ${cardRows.length} card transactions into ${consolidated.length} monthly WITHDRAWAL activities`,
    });
  }

  return { activities, notes };
}

/* ───────────────────────────────────────────────────────────────────── *
 *  Per-row mapping — switch on (category, type)
 * ───────────────────────────────────────────────────────────────────── */

function mapRow(row: TrCsvRow, accountId: string, notes: MapperNote[]): ActivityCreate[] | null {
  const cat = row.category;
  const t = row.type;

  if (cat === "TRADING" && (t === "BUY" || t === "SELL")) return mapBuySell(row, accountId);
  if (cat === "CASH") {
    switch (t) {
      case "DIVIDEND":
        return mapDividend(row, accountId);
      case "INTEREST_PAYMENT":
        return mapInterest(row, accountId);
      case "BENEFITS_SAVEBACK":
        return mapSaveback(row, accountId);
      case "CUSTOMER_INBOUND":
      case "TRANSFER_INBOUND":
      case "TRANSFER_INSTANT_INBOUND":
        return mapDeposit(row, accountId);
      case "TRANSFER_INSTANT_OUTBOUND":
        return mapWithdrawal(row, accountId);
      case "CARD_ORDERING_FEE":
        return mapCardOrderingFee(row, accountId);
      // CARD_TRANSACTION* handled by consolidator (caller filtered them)
    }
  }
  if (cat === "CORPORATE_ACTION") {
    switch (t) {
      case "SPLIT":
        return mapSplit(row, accountId);
      case "MERGER":
        return mapMerger(row, accountId);
      case "SPIN_OFF":
        return mapSpinOff(row, accountId);
      case "STOCK_DIVIDEND":
        return mapStockDividend(row, accountId);
      case "WORTHLESS":
        return mapWorthless(row, accountId);
      // *_CANCELLED handled by resolveCancelledPairs (skipped)
    }
  }
  if (cat === "DELIVERY" && t === "FREE_RECEIPT") return mapFreeReceipt(row, accountId);

  notes.push({
    rowIndex: row.rowIndex,
    kind: "unknown_type",
    message: `Unmapped (category=${cat}, type=${t})`,
  });
  return null;
}

/* ─────────────────────────  Trading  ───────────────────────── */

function mapBuySell(row: TrCsvRow, accountId: string): ActivityCreate[] {
  const fee = Math.abs(row.fee ?? 0) + Math.abs(row.tax ?? 0);
  const isDca = row.description?.startsWith("Savings plan execution") ?? false;

  return [
    {
      accountId,
      activityType: row.type === "BUY" ? "BUY" : "SELL",
      activityDate: row.datetime || row.date,
      symbol: resolveAsset(row),
      quantity: Math.abs(row.shares ?? 0),
      unitPrice: row.price ?? undefined,
      currency: row.currency || "EUR",
      fee: fee > 0 ? fee : undefined,
      fxRate: row.fxRate ?? undefined,
      comment: row.description || undefined,
      metadata: buildMetadata(row, { tr_dca: isDca || undefined }),
    },
  ];
}

/* ─────────────────────────  Cash  ───────────────────────── */

function mapDividend(row: TrCsvRow, accountId: string): ActivityCreate[] {
  const gross = row.amount ?? 0;
  const wht = Math.abs(row.tax ?? 0);
  const net = gross - wht;

  return [
    {
      accountId,
      activityType: "DIVIDEND",
      activityDate: row.datetime || row.date,
      symbol: resolveAsset(row),
      amount: net,
      currency: row.currency || "EUR",
      fxRate: row.fxRate ?? undefined,
      comment: row.description || undefined,
      metadata: buildMetadata(row, {
        tr_gross: gross,
        tr_wht: wht > 0 ? wht : undefined,
        tr_wht_country: wht > 0 ? extractCountryFromIsin(row.symbol) : undefined,
      }),
    },
  ];
}

function mapInterest(row: TrCsvRow, accountId: string): ActivityCreate[] {
  return [
    {
      accountId,
      activityType: "INTEREST",
      activityDate: row.datetime || row.date,
      amount: row.amount ?? 0,
      currency: row.currency || "EUR",
      comment: row.description || undefined,
      metadata: buildMetadata(row),
    },
  ];
}

function mapSaveback(row: TrCsvRow, accountId: string): ActivityCreate[] {
  // "Fixed income bonus …" → BONUS, anything else (Saveback payment /
  // Saveback cash reward) → REBATE.
  const isFixedIncome = (row.description || "").toLowerCase().includes("fixed income");

  return [
    {
      accountId,
      activityType: "CREDIT",
      subtype: isFixedIncome ? "BONUS" : "REBATE",
      activityDate: row.datetime || row.date,
      amount: row.amount ?? 0,
      currency: row.currency || "EUR",
      comment: row.description || undefined,
      metadata: buildMetadata(row),
    },
  ];
}

function mapDeposit(row: TrCsvRow, accountId: string): ActivityCreate[] {
  return [
    {
      accountId,
      activityType: "DEPOSIT",
      activityDate: row.datetime || row.date,
      amount: row.amount ?? 0,
      currency: row.currency || "EUR",
      comment: row.description || row.name || undefined,
      metadata: buildMetadata(row),
    },
  ];
}

function mapWithdrawal(row: TrCsvRow, accountId: string): ActivityCreate[] {
  return [
    {
      accountId,
      activityType: "WITHDRAWAL",
      activityDate: row.datetime || row.date,
      amount: Math.abs(row.amount ?? 0),
      currency: row.currency || "EUR",
      comment: row.description || row.name || undefined,
      metadata: buildMetadata(row),
    },
  ];
}

function mapCardOrderingFee(row: TrCsvRow, accountId: string): ActivityCreate[] {
  // TR records the €5 issuance fee with `amount=0, fee=-5.00`.
  const fee = Math.abs(row.fee ?? 0);
  return [
    {
      accountId,
      activityType: "FEE",
      activityDate: row.datetime || row.date,
      amount: fee,
      currency: row.currency || "EUR",
      comment: row.description || "Trade Republic Card",
      metadata: buildMetadata(row),
    },
  ];
}

/* ─────────────────────────  Card consolidation  ───────────────────────── */

interface CardBucket {
  ymKey: string; // e.g. "2025-03"
  net: number;
  count: number;
  refundCount: number;
  refundAmount: number;
  spendCount: number;
  spendAmount: number;
  /** Newest date in the bucket — used as the activity date so the
   *  monthly summary lands on the last day there was activity, which
   *  reads naturally in chronological listings. */
  latestDate: string;
  txnIds: string[];
}

function consolidateCardByMonth(
  cardRows: TrCsvRow[],
  accountId: string,
  _allRows: TrCsvRow[],
): ActivityCreate[] {
  const buckets = new Map<string, CardBucket>();

  for (const row of cardRows) {
    const ym = row.date.slice(0, 7); // YYYY-MM
    let bucket = buckets.get(ym);
    if (!bucket) {
      bucket = {
        ymKey: ym,
        net: 0,
        count: 0,
        refundCount: 0,
        refundAmount: 0,
        spendCount: 0,
        spendAmount: 0,
        latestDate: row.date,
        txnIds: [],
      };
      buckets.set(ym, bucket);
    }
    const amt = row.amount ?? 0;
    bucket.net += amt;
    bucket.count += 1;
    if (amt > 0) {
      bucket.refundCount += 1;
      bucket.refundAmount += amt;
    } else {
      bucket.spendCount += 1;
      bucket.spendAmount += -amt;
    }
    if (row.date > bucket.latestDate) bucket.latestDate = row.date;
    if (row.transactionId) bucket.txnIds.push(row.transactionId);
  }

  const out: ActivityCreate[] = [];
  for (const bucket of [...buckets.values()].sort((a, b) => a.ymKey.localeCompare(b.ymKey))) {
    if (Math.abs(bucket.net) < 0.005) continue; // pure pass-through (rare)

    const isOutflow = bucket.net < 0;
    out.push({
      accountId,
      activityType: isOutflow ? "WITHDRAWAL" : "DEPOSIT",
      activityDate: bucket.latestDate,
      amount: Math.abs(bucket.net),
      currency: "EUR",
      comment: `TR Card — ${bucket.spendCount} spend (€${bucket.spendAmount.toFixed(2)})${
        bucket.refundCount > 0
          ? ` + ${bucket.refundCount} refund (€${bucket.refundAmount.toFixed(2)})`
          : ""
      } in ${bucket.ymKey}`,
      metadata: JSON.stringify({
        tr_source_system: TR_SOURCE_SYSTEM,
        tr_consolidation: "card_monthly",
        tr_period: bucket.ymKey,
        tr_count: bucket.count,
        tr_spend_count: bucket.spendCount,
        tr_spend_amount: bucket.spendAmount,
        tr_refund_count: bucket.refundCount,
        tr_refund_amount: bucket.refundAmount,
        tr_transaction_ids: bucket.txnIds,
      }),
    });
  }
  return out;
}

/* ─────────────────────────  Corporate Actions  ───────────────────────── */

function mapSplit(row: TrCsvRow, accountId: string): ActivityCreate[] {
  // The CSV gives us the DELTA shares. Wealthfolio's SPLIT activity
  // expects the ratio (numerator / denominator). We compute it from
  // the user's prior position for that symbol.
  // Fallback (no prior position found) → emit with metadata only,
  // user must edit manually. Logged as a note.
  return [
    {
      accountId,
      activityType: "SPLIT",
      activityDate: row.datetime || row.date,
      symbol: resolveAsset(row),
      // The Wealthfolio backend stores the ratio in `amount`. We don't
      // know the prior position from a single row, so the caller
      // computes the ratio in a 2nd pass (see resolveSplits) and
      // patches this activity. Default to delta if uncomputed.
      amount: row.shares ?? 0,
      currency: row.currency || "EUR",
      comment: row.description || `SPLIT ${row.symbol}`,
      metadata: buildMetadata(row, {
        tr_split_delta_shares: row.shares ?? undefined,
        tr_split_pending_ratio: true,
      }),
    },
  ];
}

function mapMerger(row: TrCsvRow, accountId: string): ActivityCreate[] {
  // 1:1 ticker swap (Rocket Lab US7731221062 ↔ US7731211089). Per row
  // we emit a single ADJUSTMENT with the signed share delta. The two
  // CSV rows together produce a -OLD / +NEW pair.
  const shares = row.shares ?? 0;
  return [
    {
      accountId,
      activityType: "ADJUSTMENT",
      activityDate: row.datetime || row.date,
      symbol: resolveAsset(row),
      quantity: shares,
      currency: row.currency || "EUR",
      comment: row.description || `MERGER ${row.symbol}`,
      metadata: buildMetadata(row, {
        tr_corporate_action: "MERGER",
        tr_direction: shares < 0 ? "OUT" : "IN",
      }),
    },
  ];
}

function mapSpinOff(row: TrCsvRow, accountId: string): ActivityCreate[] {
  // Honeywell → Solstice: receive new shares, no cash. Cancelled-pair
  // resolution already collapsed +X/-X/+X to a single +X row.
  const shares = row.shares ?? 0;
  return [
    {
      accountId,
      activityType: "TRANSFER_IN",
      activityDate: row.datetime || row.date,
      symbol: resolveAsset(row),
      quantity: shares,
      currency: row.currency || "EUR",
      comment: row.description || `SPIN_OFF ${row.symbol}`,
      metadata: buildMetadata(row, { tr_corporate_action: "SPIN_OFF" }),
    },
  ];
}

function mapStockDividend(row: TrCsvRow, accountId: string): ActivityCreate[] {
  // Bonus shares (e.g. Enovix warrants). Subtype DIVIDEND_IN_KIND.
  const shares = row.shares ?? 0;
  return [
    {
      accountId,
      activityType: "DIVIDEND",
      subtype: "DIVIDEND_IN_KIND",
      activityDate: row.datetime || row.date,
      symbol: resolveAsset(row),
      quantity: shares,
      amount: 0,
      currency: row.currency || "EUR",
      comment: row.description || `STOCK_DIVIDEND ${row.symbol}`,
      metadata: buildMetadata(row, { tr_corporate_action: "STOCK_DIVIDEND" }),
    },
  ];
}

function mapWorthless(row: TrCsvRow, accountId: string): ActivityCreate[] {
  // Position written off (e.g. expired warrants). Emit a SELL at €0
  // with the absolute share count to zero out the holding.
  const shares = Math.abs(row.shares ?? 0);
  return [
    {
      accountId,
      activityType: "SELL",
      activityDate: row.datetime || row.date,
      symbol: resolveAsset(row),
      quantity: shares,
      unitPrice: 0,
      amount: 0,
      currency: row.currency || "EUR",
      comment: row.description || `WORTHLESS ${row.symbol}`,
      metadata: buildMetadata(row, { tr_corporate_action: "WORTHLESS" }),
    },
  ];
}

/* ─────────────────────────  Delivery (staking)  ───────────────────────── */

function mapFreeReceipt(row: TrCsvRow, accountId: string): ActivityCreate[] {
  // TR Crypto Saveback: small SOL/ADA/etc. rewards delivered weekly.
  // Per user decision: record qty only (no cost basis, no income event).
  // If the user later sells these fractions, the gain shows as the full
  // sale price — accepted trade-off (€0.40 per reward, fiscal impact
  // negligible).
  const shares = row.shares ?? 0;
  return [
    {
      accountId,
      activityType: "TRANSFER_IN",
      activityDate: row.datetime || row.date,
      symbol: resolveAsset(row),
      quantity: shares,
      currency: row.currency || "EUR",
      comment: row.description || `TR Staking reward (${row.symbol})`,
      metadata: buildMetadata(row, { tr_staking: true, tr_fmv_at_receipt: row.price ?? undefined }),
    },
  ];
}

/* ─────────────────────────  Cancelled-pair resolver  ───────────────────────── */

/**
 * STOCK_DIVIDEND_CANCELLED and SPIN_OFF_CANCELLED show up as the inverse
 * of an immediately preceding/following sibling row (same date, symbol,
 * abs(shares)). TR's net effect is a single occurrence.
 *
 * Strategy: for each *_CANCELLED, find one matching positive sibling on
 * the same date+symbol, mark BOTH as skipped — leaving the remaining
 * positive row(s) to be mapped normally.
 */
function resolveCancelledPairs(rows: TrCsvRow[], skip: Set<number>, notes: MapperNote[]): void {
  const byKey = new Map<string, TrCsvRow[]>();
  for (const row of rows) {
    if (row.category !== "CORPORATE_ACTION") continue;
    if (
      row.type !== "STOCK_DIVIDEND" &&
      row.type !== "STOCK_DIVIDEND_CANCELLED" &&
      row.type !== "SPIN_OFF" &&
      row.type !== "SPIN_OFF_CANCELLED"
    )
      continue;
    const baseType = row.type.replace("_CANCELLED", "");
    const key = `${baseType}|${row.date}|${row.symbol}|${Math.abs(row.shares ?? 0).toFixed(8)}`;
    const arr = byKey.get(key) ?? [];
    arr.push(row);
    byKey.set(key, arr);
  }

  for (const [key, group] of byKey) {
    const cancellations = group.filter((r) => r.type.endsWith("_CANCELLED"));
    if (cancellations.length === 0) continue;
    const positives = group.filter((r) => !r.type.endsWith("_CANCELLED"));

    // Pair each cancellation with one positive sibling.
    for (let i = 0; i < cancellations.length && i < positives.length; i++) {
      skip.add(cancellations[i].rowIndex);
      skip.add(positives[i].rowIndex);
    }
    notes.push({
      kind: "cancelled_pair_resolved",
      message: `Resolved ${cancellations.length} ${key.split("|")[0]} cancellation(s) — net = ${positives.length - cancellations.length} occurrence(s)`,
    });
  }
}

/* ─────────────────────────  Asset resolution  ───────────────────────── */

function resolveAsset(row: TrCsvRow) {
  const sym = row.symbol;
  if (!sym) return undefined;

  // Derive instrumentType from CSV's asset_class so Wealthfolio routes
  // to the correct provider (CoinGecko for crypto, Yahoo/Stooq for
  // stocks/ETFs, etc.). The mapping table is in bucketFromAssetClass —
  // no per-ISIN hardcoding.
  const bucket = bucketFromAssetClass(row.assetClass);
  const instrumentType = bucket?.instrumentType;

  // (v4.5.0) Derivatives — warrants, options, structured products — are
  // rarely tradable on Yahoo and CUSTOM_SCRAPER returns HTTP 404 for
  // their ISINs (e.g. Enovix WTS US2935941318). Mark the asset profile
  // as quoteMode=MANUAL on creation so Wealthfolio doesn't try to sync
  // a price for it. Affected positions are still tracked at cost basis;
  // the user can manually input prices via the UI if needed.
  const quoteMode: "MANUAL" | undefined = bucket?.bucket === "DERIVATIVE" ? "MANUAL" : undefined;

  // Currency strategy (v4.3.1 — reverted from forcing EUR):
  //   - Crypto: pin EUR (BTC-EUR, ETH-EUR pairs are the canonical
  //     CoinGecko/Yahoo identifiers since TR settles crypto in EUR).
  //   - Stocks/ETFs: use the ticker map's natural quoteCcy (USD for
  //     AAPL, EUR for SXR8.DE, etc.). Wealthfolio's FX engine converts
  //     to the account's base currency (EUR) at valuation time —
  //     "Total Value" displays in EUR even when "Today's Price" stays
  //     in the asset's native currency. The Holdings page has a 🌐
  //     toggle to flip Today's Price to base currency too.
  //   - Unknown ISINs: omit quoteCcy entirely so Wealthfolio's
  //     auto-discovery picks the right currency from the provider
  //     metadata.
  //
  // Why we reverted: forcing quoteCcy=EUR on a USD-quoted Yahoo asset
  // confused the FX layer (it logged "Holding currency (EUR) differs
  // from quote currency (USD)" warnings on every valuation), and once
  // an asset profile is created the dedup-by-ISIN means we can't
  // later change it via UpdateAssetProfile (the SDK type doesn't
  // expose quoteCcy, even though the Rust accepts it).

  // Crypto: TR ships tickers (BTC/ETH/SOL/ADA/XRP). Yahoo/CoinGecko
  // expect BTC-EUR / ETH-EUR / etc. since TR settles in EUR.
  if (row.assetClass === "CRYPTO") {
    return {
      symbol: `${sym}-EUR`,
      kind: "INVESTMENT",
      name: row.name || sym,
      quoteCcy: "EUR",
      instrumentType: "CRYPTO",
    };
  }

  // ISIN: try the ticker map for friendly Yahoo symbols. Use the map's
  // natural quoteCcy (USD for US stocks, EUR for Xetra-listed ETFs)
  // and trust Wealthfolio's FX engine to convert at display time.
  const mapping = lookupTicker(sym);
  if (mapping) {
    return {
      symbol: mapping.symbol,
      kind: "INVESTMENT",
      name: mapping.displayName || row.name || sym,
      exchangeMic: mapping.exchangeMic,
      quoteCcy: mapping.quoteCcy,
      instrumentType: instrumentType ?? mapping.instrumentType,
      quoteMode,
    };
  }

  // Unknown ISIN — fall back to ISIN-as-symbol; let Wealthfolio's
  // auto-discovery infer the currency from the provider metadata.
  // For derivatives, also pin quoteMode=MANUAL so the backend doesn't
  // hammer Yahoo / CUSTOM_SCRAPER with a 404-bound ISIN every sync.
  return {
    symbol: sym,
    kind: "INVESTMENT",
    name: row.name || sym,
    instrumentType,
    quoteMode,
  };
}

/* ─────────────────────────  Split ratio resolver  ───────────────────────── */

/**
 * 2nd-pass: walk all activities to compute prior position per
 * (symbol, splitDate), then patch each pending SPLIT activity with the
 * correct ratio. Returns the count of resolved + unresolved splits.
 */
export function resolveSplitRatios(
  rows: TrCsvRow[],
  activities: ActivityCreate[],
  notes: MapperNote[],
): { resolved: number; unresolved: number } {
  let resolved = 0;
  let unresolved = 0;

  for (const a of activities) {
    if (a.activityType !== "SPLIT") continue;
    // metadata is now a JSON string (Rust backend expects Option<String>),
    // so parse → mutate → re-serialize.
    const metaRaw = typeof a.metadata === "string" ? safeParse(a.metadata) : a.metadata;
    const meta = (metaRaw ?? {}) as Record<string, unknown>;
    if (!meta.tr_split_pending_ratio) continue;

    const symbol = meta.tr_symbol as string | undefined;
    const splitDate = meta.tr_date as string | undefined;
    const delta = meta.tr_split_delta_shares as number | undefined;
    if (!symbol || !splitDate || delta == null) {
      unresolved++;
      continue;
    }

    let prior = 0;
    for (const row of rows) {
      if (row.symbol !== symbol) continue;
      if (row.date >= splitDate) continue;
      if (row.shares == null) continue;
      if (row.type === "BUY" || row.type === "FREE_RECEIPT" || row.type === "STOCK_DIVIDEND") {
        prior += row.shares;
      } else if (row.type === "SELL") {
        prior -= Math.abs(row.shares);
      } else if (row.type === "SPIN_OFF") {
        prior += row.shares; // shares received
      } else if (row.type === "MERGER") {
        prior += row.shares; // signed (negative for old, positive for new)
      }
    }

    if (prior <= 0) {
      unresolved++;
      notes.push({
        kind: "split_ratio",
        message: `Could not resolve split ratio for ${symbol} on ${splitDate} — prior position computed as ${prior}`,
      });
      continue;
    }

    const ratio = (prior + delta) / prior;
    a.amount = roundTo(ratio, 6);
    delete meta.tr_split_pending_ratio;
    a.metadata = JSON.stringify(meta);
    notes.push({
      kind: "split_ratio",
      message: `Resolved split ${symbol} ${splitDate}: prior=${prior.toFixed(6)} delta=${delta.toFixed(6)} ratio=${ratio.toFixed(2)}:1`,
    });
    resolved++;
  }

  return { resolved, unresolved };
}

/* ─────────────────────────  Helpers  ───────────────────────── */

/**
 * Build the activity metadata as a JSON string.
 *
 * The Wealthfolio Rust backend declares `metadata: Option<String>` (a
 * JSON-encoded blob, not a structured map). The TypeScript SDK type
 * accepts both `string | Record<string, unknown>`, but only strings
 * actually deserialize on the Tauri side — passing a map raises:
 *   "invalid type: map, expected a string"
 * which silently fails the entire bulk insert.
 *
 * Always serialize here.
 */
function buildMetadata(row: TrCsvRow, extras?: Record<string, unknown>): string {
  const geo = row.symbol ? resolveCountry(row.symbol, row.assetClass) : undefined;
  const bucket = bucketFromAssetClass(row.assetClass);

  const md: Record<string, unknown> = {
    tr_source_system: TR_SOURCE_SYSTEM,
    tr_transaction_id: row.transactionId,
    tr_datetime: row.datetime,
    tr_symbol: row.symbol || undefined,
    tr_date: row.date,
    tr_category: row.category,
    tr_type: row.type,
    tr_asset_class: row.assetClass || undefined,
    tr_asset_bucket: bucket?.bucket,
    tr_asset_label: bucket?.label,
    tr_country: geo?.code,
    tr_country_name: geo?.name,
    tr_country_flag: geo?.flag,
    tr_region: geo?.region,
    tr_is_umbrella_jurisdiction: geo?.isUmbrella || undefined,
    tr_is_offshore_jurisdiction: geo?.isOffshore || undefined,
    tr_account_type: row.accountType || undefined,
    tr_original_amount: row.originalAmount ?? undefined,
    tr_original_currency: row.originalCurrency || undefined,
    tr_counterparty_name: row.counterpartyName || undefined,
    tr_counterparty_iban: row.counterpartyIban || undefined,
    tr_payment_reference: row.paymentReference || undefined,
    tr_mcc_code: row.mccCode || undefined,
  };
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined) md[k] = v;
    }
  }
  // Strip undefined keys for a tighter JSON.
  for (const k of Object.keys(md)) {
    if (md[k] === undefined) delete md[k];
  }
  return JSON.stringify(md);
}

/**
 * Map TR's `asset_class` field to:
 *   - bucket: the broad category for the dashboard (CRYPTO / ETF / STOCK
 *             / DERIVATIVE / OTHER). Stable across re-imports — safe to
 *             group by in queries.
 *   - label : human-readable PT label for UI ("Cripto", "ETF", "Ações",
 *             "Derivado", "Outro").
 *   - instrumentType: hint Wealthfolio's market-data router uses to
 *             pick the right provider (CoinGecko for CRYPTO, Yahoo/Stooq
 *             for EQUITY/ETF, etc.).
 */
interface AssetBucket {
  bucket: "CRYPTO" | "ETF" | "STOCK" | "DERIVATIVE" | "OTHER";
  label: string;
  instrumentType: "CRYPTO" | "ETF" | "EQUITY" | "OPTION" | "OTHER";
}

function bucketFromAssetClass(assetClass: string): AssetBucket | undefined {
  switch (assetClass) {
    case "CRYPTO":
      return { bucket: "CRYPTO", label: "Cripto", instrumentType: "CRYPTO" };
    case "FUND":
      return { bucket: "ETF", label: "ETF / Fundo", instrumentType: "ETF" };
    case "STOCK":
      return { bucket: "STOCK", label: "Ações", instrumentType: "EQUITY" };
    case "DERIVATIVE":
      return { bucket: "DERIVATIVE", label: "Derivado", instrumentType: "OPTION" };
    case "":
    case undefined:
      return undefined; // cash transactions — no asset
    default:
      return { bucket: "OTHER", label: assetClass, instrumentType: "OTHER" };
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractCountryFromIsin(isin: string): string | undefined {
  if (!isin || isin.length < 2) return undefined;
  const cc = isin.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(cc)) return undefined;
  return cc;
}

function roundTo(n: number, digits: number): number {
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}

/* ─────────────────────────  Cash sanity (test helper)  ───────────────────────── */

/** Sum the cash effect across all emitted activities. Used by smoke
 *  tests to verify the mapper preserves the CSV's cash balance. */
export function sumActivityCashEffect(activities: ActivityCreate[]): {
  cashIn: number;
  cashOut: number;
} {
  let cashIn = 0;
  let cashOut = 0;
  for (const a of activities) {
    const t = a.activityType;
    const amount = Number(a.amount ?? 0);
    const fee = Number(a.fee ?? 0);
    const qty = Number(a.quantity ?? 0);
    const unitPrice = Number(a.unitPrice ?? 0);

    let cash = 0;
    switch (t) {
      case "BUY":
        cash = -(qty * unitPrice + fee);
        break;
      case "SELL":
        cash = qty * unitPrice - fee;
        break;
      case "DIVIDEND":
      case "INTEREST":
      case "CREDIT":
      case "DEPOSIT":
        cash = amount;
        break;
      case "WITHDRAWAL":
      case "FEE":
      case "TAX":
        cash = -Math.abs(amount);
        break;
      case "TRANSFER_IN":
      case "TRANSFER_OUT":
      case "SPLIT":
      case "ADJUSTMENT":
        cash = 0; // no cash impact
        break;
    }

    if (cash > 0) cashIn += cash;
    else if (cash < 0) cashOut += -cash;
  }
  return { cashIn, cashOut };
}

/* ─────────────────────────  v4.6.0 — quoteCcy override suggestions  ───────────────────────── */

export interface AssetCcySuggestion {
  /** Yahoo-friendly symbol the activity carries (e.g. "ABCL"). */
  symbol: string;
  /** Asset's current quoteCcy from the mapper (e.g. "USD"). */
  currentQuoteCcy: string;
  /** Currency the user actually paid in for every trade of this asset. */
  suggestedQuoteCcy: string;
  /** Number of BUY/SELL trades that contributed to the suggestion. */
  tradeCount: number;
}

/**
 * Detect assets where the asset profile's `quoteCcy` (set by the ticker
 * map, e.g. USD for NASDAQ) doesn't match the currency the user actually
 * paid in for **every single trade** of that asset.
 *
 * Common case: a TR Portugal user buys ABCL via savings plan. Each BUY
 * row in the CSV has `currency=EUR` (TR settles in EUR even for
 * US-listed stocks). The mapper resolves ABCL to `quoteCcy=USD` from the
 * NASDAQ ticker map. Wealthfolio then converts every EUR purchase to
 * USD at the historical FX rate, and reports cost basis in USD —
 * matching neither the TR app (€4.07/share) nor what the user actually
 * paid (~€710 total).
 *
 * Pure data-driven detection — no thresholds, no hardcoded EUR:
 *   1) Group BUY+SELL activities by asset symbol
 *   2) For each asset, collect the set of distinct `currency` values
 *      across its trades
 *   3) If that set has exactly ONE currency AND it differs from the
 *      asset's `quoteCcy` → suggest override to that currency
 *   4) Skip cryptos (already pinned to `-EUR` pair format by the mapper)
 *   5) Skip unknown ISINs (no `quoteCcy` set — Wealthfolio infers)
 *
 * Mixed-currency edge case (rare): if the same asset has trades in
 * multiple currencies (e.g. EUR + USD), no suggestion is emitted — the
 * user keeps the mapped quoteCcy and can adjust manually.
 *
 * The caller (the page wizard) uses these suggestions to pre-populate
 * the Review Assets overrides Map. The user can still deselect
 * individually before continuing.
 */
export function suggestQuoteCcyOverrides(activities: ActivityCreate[]): AssetCcySuggestion[] {
  interface Bag {
    symbol: string;
    quoteCcy: string;
    instrumentType?: string;
    tradeCcySet: Set<string>;
    tradeCount: number;
  }
  const bag = new Map<string, Bag>();

  for (const a of activities) {
    // Only trades shape cost basis. DIVIDEND/SPLIT/etc. can carry their
    // own currency that has nothing to do with the cost basis question.
    if (a.activityType !== "BUY" && a.activityType !== "SELL") continue;

    const sym = (a as { symbol?: { symbol?: string; quoteCcy?: string; instrumentType?: string } })
      .symbol;
    if (!sym?.symbol) continue;
    if (!sym.quoteCcy) continue; // unknown ISIN — no canonical quoteCcy to override
    if (sym.instrumentType === "CRYPTO") continue; // already EUR-paired

    const ccy = a.currency;
    if (!ccy) continue;

    const key = sym.symbol;
    const cur = bag.get(key);
    if (cur) {
      cur.tradeCcySet.add(ccy);
      cur.tradeCount++;
    } else {
      bag.set(key, {
        symbol: key,
        quoteCcy: sym.quoteCcy,
        instrumentType: sym.instrumentType,
        tradeCcySet: new Set([ccy]),
        tradeCount: 1,
      });
    }
  }

  const out: AssetCcySuggestion[] = [];
  for (const b of bag.values()) {
    if (b.tradeCcySet.size !== 1) continue; // mixed-currency trades — no clear suggestion
    const [paidCcy] = b.tradeCcySet;
    if (paidCcy === b.quoteCcy) continue; // already aligned — nothing to do
    out.push({
      symbol: b.symbol,
      currentQuoteCcy: b.quoteCcy,
      suggestedQuoteCcy: paidCcy,
      tradeCount: b.tradeCount,
    });
  }
  return out;
}
