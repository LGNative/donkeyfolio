/**
 * Diagnostics for the TR Importer.
 *
 * Reads all activities in the Trade Republic account from Donkeyfolio,
 * cross-references with TR-source metadata, and surfaces:
 *   - Duplicates (same `tr_transaction_id` imported >1 times — typically
 *     from re-imports without history clearing or partial-failure retries)
 *   - Per-asset counts + total qty + bucket + country
 *   - Per-bucket / per-region breakdowns
 *   - Cash impact (compare against CSV summary to spot drift)
 *   - Foreign activities (created outside this addon) so we don't
 *     accidentally clean them up
 *
 * No mutation. The caller decides what to do with the report (show it,
 * offer cleanup, write a backup, etc.).
 */

import type { ActivityDetails } from "@wealthfolio/addon-sdk";

export interface DuplicateGroup {
  /** The shared `tr_transaction_id` value. */
  trTransactionId: string;
  /** All activities sharing the id (length >= 2). */
  activities: ActivityDetails[];
}

export interface AssetAggregate {
  symbol: string;
  name?: string;
  /** Sum of quantity across BUY (+) and SELL (-) and TRANSFER_IN (+). */
  netQuantity: number;
  /** Number of activities for this asset. */
  activityCount: number;
  /** From the FIRST activity's metadata if present. */
  bucket?: string;
  /** From the FIRST activity's metadata if present (country code). */
  country?: string;
  /** From the FIRST activity's metadata if present (PT name). */
  countryName?: string;
  flag?: string;
}

export interface DiagnosticsReport {
  accountId: string;
  totalActivities: number;
  /** Activities tagged with our `tr_source_system = TR_CSV`. */
  trActivities: number;
  /** Activities NOT tagged with our source — likely manual / from another addon. */
  foreignActivities: number;
  /** Unique `tr_transaction_id`s found across TR activities. */
  uniqueTransactionIds: number;
  /** Groups of activities sharing the same `tr_transaction_id` (duplicates). */
  duplicates: DuplicateGroup[];
  /** Per-asset aggregate (only TR activities). */
  byAsset: AssetAggregate[];
  /** Activity count per bucket (CRYPTO / ETF / STOCK / DERIVATIVE / OTHER). */
  byBucket: Record<string, number>;
  /** Activity count per region (PT name). */
  byRegion: Record<string, number>;
  /** Activity count per asset class label. */
  byAssetType: Record<string, number>;
  /** Net cash effect computed from TR activities only. */
  cashEffect: { cashIn: number; cashOut: number };
}

interface ParsedMeta {
  tr_source_system?: string;
  tr_transaction_id?: string;
  tr_asset_bucket?: string;
  tr_asset_label?: string;
  tr_country?: string;
  tr_country_name?: string;
  tr_country_flag?: string;
  tr_region?: string;
  [k: string]: unknown;
}

const TR_SOURCE_SYSTEM = "TR_CSV";

function parseMeta(raw: unknown): ParsedMeta {
  if (!raw) return {};
  if (typeof raw === "object") return raw as ParsedMeta;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ParsedMeta;
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Run diagnostics over the activities returned by `ctx.api.activities.getAll`.
 * Pure function — no I/O, no SDK calls. Caller fetches and passes in.
 */
export function diagnose(activities: ActivityDetails[], accountId: string): DiagnosticsReport {
  let trActivities = 0;
  let foreignActivities = 0;

  // Group by transaction id
  const byTxId = new Map<string, ActivityDetails[]>();
  // Aggregate per asset
  const assetMap = new Map<string, AssetAggregate>();
  const byBucket: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  const byAssetType: Record<string, number> = {};
  let cashIn = 0;
  let cashOut = 0;

  for (const a of activities) {
    const meta = parseMeta(a.metadata);
    const isTrSource = meta.tr_source_system === TR_SOURCE_SYSTEM;

    if (!isTrSource) {
      foreignActivities++;
      continue;
    }
    trActivities++;

    if (meta.tr_transaction_id) {
      const arr = byTxId.get(meta.tr_transaction_id) ?? [];
      arr.push(a);
      byTxId.set(meta.tr_transaction_id, arr);
    }

    // Per-asset aggregate (only assets with a symbol)
    if (a.assetSymbol) {
      const key = a.assetSymbol;
      const cur = assetMap.get(key) ?? {
        symbol: key,
        name: a.assetName ?? undefined,
        netQuantity: 0,
        activityCount: 0,
        bucket: meta.tr_asset_bucket,
        country: meta.tr_country,
        countryName: meta.tr_country_name,
        flag: meta.tr_country_flag,
      };
      cur.activityCount++;
      const qty = a.quantity != null ? Number(a.quantity) : 0;
      if (a.activityType === "BUY" || a.activityType === "TRANSFER_IN") cur.netQuantity += qty;
      else if (a.activityType === "SELL" || a.activityType === "TRANSFER_OUT")
        cur.netQuantity -= Math.abs(qty);
      assetMap.set(key, cur);
    }

    // Bucket / Region / AssetType
    if (meta.tr_asset_bucket) {
      byBucket[meta.tr_asset_bucket] = (byBucket[meta.tr_asset_bucket] ?? 0) + 1;
    }
    if (meta.tr_region) {
      byRegion[meta.tr_region] = (byRegion[meta.tr_region] ?? 0) + 1;
    }
    if (meta.tr_asset_label) {
      byAssetType[meta.tr_asset_label] = (byAssetType[meta.tr_asset_label] ?? 0) + 1;
    }

    // Cash effect (rough — uses amount + fee, ignores qty*price recompute)
    const amount = a.amount != null ? Number(a.amount) : 0;
    const fee = a.fee != null ? Number(a.fee) : 0;
    let effect = 0;
    switch (a.activityType) {
      case "BUY": {
        const qty = a.quantity != null ? Number(a.quantity) : 0;
        const unit = a.unitPrice != null ? Number(a.unitPrice) : 0;
        effect = -(qty * unit + fee);
        break;
      }
      case "SELL": {
        const qty = a.quantity != null ? Number(a.quantity) : 0;
        const unit = a.unitPrice != null ? Number(a.unitPrice) : 0;
        effect = qty * unit - fee;
        break;
      }
      case "DIVIDEND":
      case "INTEREST":
      case "CREDIT":
      case "DEPOSIT":
        effect = amount;
        break;
      case "WITHDRAWAL":
      case "FEE":
      case "TAX":
        effect = -Math.abs(amount);
        break;
    }
    if (effect > 0) cashIn += effect;
    else if (effect < 0) cashOut += -effect;
  }

  // Detect duplicates (>=2 activities sharing a tx id)
  const duplicates: DuplicateGroup[] = [];
  for (const [txId, group] of byTxId) {
    if (group.length > 1) {
      duplicates.push({ trTransactionId: txId, activities: group });
    }
  }
  // Sort: most-duplicated first
  duplicates.sort((a, b) => b.activities.length - a.activities.length);

  const byAsset = [...assetMap.values()].sort(
    (a, b) => Math.abs(b.netQuantity) - Math.abs(a.netQuantity),
  );

  return {
    accountId,
    totalActivities: activities.length,
    trActivities,
    foreignActivities,
    uniqueTransactionIds: byTxId.size,
    duplicates,
    byAsset,
    byBucket,
    byRegion,
    byAssetType,
    cashEffect: { cashIn, cashOut },
  };
}

/**
 * Pick the activities to delete to leave 1 of each duplicated group.
 * Strategy: keep the OLDEST (lowest createdAt timestamp), delete the rest.
 */
export function pickDuplicatesToDelete(report: DiagnosticsReport): string[] {
  const ids: string[] = [];
  for (const group of report.duplicates) {
    const sorted = [...group.activities].sort((a, b) => {
      const ta = new Date(a.createdAt as unknown as string).getTime();
      const tb = new Date(b.createdAt as unknown as string).getTime();
      return ta - tb;
    });
    // Keep first (oldest), delete the rest
    for (let i = 1; i < sorted.length; i++) {
      ids.push(sorted[i].id);
    }
  }
  return ids;
}
