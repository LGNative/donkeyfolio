import { Button, Icons, Input } from "@wealthfolio/ui";
import React from "react";

import type { MapperResult } from "../lib/tr-csv-mapper";

interface AssetSummary {
  symbol: string;
  displayName: string;
  bucket?: string;
  country?: string;
  flag?: string;
  defaultQuoteCcy?: string;
  instrumentType?: string;
  exchangeMic?: string;
  activityCount: number;
}

export interface AssetOverride {
  /** New quoteCcy chosen by the user (e.g. "EUR"). */
  quoteCcy: string;
}

interface Props {
  mapping: MapperResult;
  /** Existing overrides keyed by asset symbol (Yahoo-friendly form). */
  overrides: Map<string, AssetOverride>;
  onChange: (next: Map<string, AssetOverride>) => void;
  onBack: () => void;
  onContinue: () => void;
}

const COMMON_CURRENCIES = ["EUR", "USD", "GBP", "GBp", "CHF", "JPY", "CAD", "DKK", "SEK", "NOK"];
/** ISO ISIN shape — a symbol still in this form means no ticker was resolved. */
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{10}$/;

interface AssetActivity {
  symbol?: {
    symbol?: string;
    name?: string;
    quoteCcy?: string;
    instrumentType?: string;
    exchangeMic?: string;
  };
  currency?: string;
  activityType?: string;
  metadata?: string | Record<string, unknown>;
}

function classLabel(t?: string): string {
  if (!t) return "Asset";
  const lower = t.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function ReviewAssetsView({
  mapping,
  overrides,
  onChange,
  onBack,
  onContinue,
}: Props): React.JSX.Element {
  const [filter, setFilter] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);

  const activities = mapping.activities as AssetActivity[];

  // Conversion target = the dominant activity currency (the cash leg). Derived
  // from the data, never hardcoded — a USD-account user would see "→ USD".
  const targetCcy = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of activities) {
      if (a.currency) counts.set(a.currency, (counts.get(a.currency) ?? 0) + 1);
    }
    let best = "";
    let bestN = -1;
    for (const [c, n] of counts) {
      if (n > bestN) {
        best = c;
        bestN = n;
      }
    }
    return best || "EUR";
  }, [activities]);

  // Aggregate unique assets from the mapping output.
  const assets: AssetSummary[] = React.useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const a of activities) {
      const sym = a.symbol;
      if (!sym?.symbol) continue;
      const key = sym.symbol;
      const cur = map.get(key);
      let parsedMeta: Record<string, unknown> | null = null;
      try {
        if (typeof a.metadata === "string") {
          parsedMeta = JSON.parse(a.metadata) as Record<string, unknown>;
        } else if (a.metadata && typeof a.metadata === "object") {
          parsedMeta = a.metadata as Record<string, unknown>;
        }
      } catch {
        parsedMeta = null;
      }
      if (cur) {
        cur.activityCount++;
      } else {
        map.set(key, {
          symbol: key,
          displayName: sym.name ?? key,
          bucket: parsedMeta?.tr_asset_bucket as string | undefined,
          country: parsedMeta?.tr_country as string | undefined,
          flag: parsedMeta?.tr_country_flag as string | undefined,
          defaultQuoteCcy: sym.quoteCcy,
          instrumentType: sym.instrumentType,
          exchangeMic: sym.exchangeMic,
          activityCount: 1,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.activityCount - a.activityCount);
  }, [activities]);

  const effectiveCcy = React.useCallback(
    (a: AssetSummary) => overrides.get(a.symbol)?.quoteCcy ?? a.defaultQuoteCcy,
    [overrides],
  );

  const { unresolved, resolved } = React.useMemo(() => {
    let list = assets;
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      list = list.filter(
        (a) =>
          a.symbol.toLowerCase().includes(q) ||
          a.displayName.toLowerCase().includes(q) ||
          (a.country ?? "").toLowerCase().includes(q),
      );
    }
    return {
      unresolved: list.filter((a) => ISIN_RE.test(a.symbol)),
      resolved: list.filter((a) => !ISIN_RE.test(a.symbol)),
    };
  }, [assets, filter]);

  const nativeCount = assets.filter((a) => effectiveCcy(a) === targetCcy).length;
  const convertedCount = assets.filter(
    (a) => !ISIN_RE.test(a.symbol) && effectiveCcy(a) && effectiveCcy(a) !== targetCcy,
  ).length;
  const unresolvedCount = assets.filter((a) => ISIN_RE.test(a.symbol)).length;

  // Pre-import breakdown by activity type — mirrors the native wizard's
  // final summary (Buy 3970 · Dividend 195 · …). Counts are derived, not hardcoded.
  const byType = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of activities) {
      if (a.activityType) counts.set(a.activityType, (counts.get(a.activityType) ?? 0) + 1);
    }
    return [...counts.entries()].sort((x, y) => y[1] - x[1]);
  }, [activities]);

  const setOverride = React.useCallback(
    (symbol: string, quoteCcy: string) => {
      const next = new Map(overrides);
      const defaultCcy = assets.find((a) => a.symbol === symbol)?.defaultQuoteCcy;
      if (!quoteCcy.trim() || quoteCcy === defaultCcy) {
        next.delete(symbol);
      } else {
        next.set(symbol, { quoteCcy: quoteCcy.toUpperCase() });
      }
      onChange(next);
      setEditing(null);
    },
    [overrides, onChange, assets],
  );

  const renderRow = (a: AssetSummary, isUnresolved: boolean) => {
    const effective = effectiveCcy(a) ?? "—";
    const isEdited = overrides.has(a.symbol);
    const isNative = effective === targetCcy;
    const isEditing = editing === a.symbol;
    const meta = [classLabel(a.instrumentType), a.exchangeMic].filter(Boolean).join(" · ");

    return (
      <div
        key={a.symbol}
        className="hover:bg-muted/20 flex items-center gap-3 border-t px-4 py-2.5 first:border-t-0"
      >
        <div className="bg-muted text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium">
          {isUnresolved ? "?" : a.symbol.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {isUnresolved ? a.symbol : a.symbol}
            <span className="text-muted-foreground ml-1.5 text-xs font-normal">
              · {a.activityCount}×
            </span>
          </p>
          <p className="text-muted-foreground truncate text-xs">
            {isUnresolved ? "ISIN not resolved to a ticker" : [a.displayName, meta].join(" · ")}
          </p>
        </div>

        {isEditing ? (
          <select
            autoFocus
            value={effective}
            onChange={(e) => setOverride(a.symbol, e.target.value)}
            onBlur={() => setEditing(null)}
            className="bg-background rounded-md border px-2 py-1 text-xs"
          >
            {!COMMON_CURRENCIES.includes(effective) && (
              <option value={effective}>{effective}</option>
            )}
            {COMMON_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <>
            {isUnresolved ? (
              <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                unresolved
              </span>
            ) : isNative ? (
              <span className="text-success bg-success/10 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium">
                <Icons.CheckCircle className="h-3 w-3" />
                {effective} native
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                {effective} → {targetCcy}
              </span>
            )}
            <button
              onClick={() => setEditing(a.symbol)}
              className={
                "text-xs underline-offset-2 hover:underline " +
                (isEdited ? "text-primary" : "text-muted-foreground")
              }
            >
              {isEdited ? "edited" : "change"}
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <WizardStepIndicator
        steps={[
          { label: "Upload", state: "done" },
          { label: "Mapping", state: "done" },
          { label: "Review assets", state: "current" },
          { label: "Import", state: "future" },
        ]}
      />

      {/* Metric strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Assets" value={assets.length} />
        <Metric label={`Native ${targetCcy}`} value={nativeCount} tone="success" />
        <Metric label="Converted via FX" value={convertedCount} tone="amber" />
        <Metric label="Unresolved" value={unresolvedCount} tone={unresolvedCount ? "danger" : ""} />
      </div>

      {/* Search */}
      <Input
        placeholder="Search by ticker, name or country…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="max-w-sm"
      />

      {/* Por resolver */}
      {unresolved.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2 px-1 text-sm font-medium text-amber-600 dark:text-amber-400">
            <Icons.AlertCircle className="h-4 w-4" />
            Unresolved · {unresolved.length}
            <span className="text-muted-foreground ml-auto text-xs font-normal">
              imported as ISIN — Yahoo may not have a price
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border">
            {unresolved.map((a) => renderRow(a, true))}
          </div>
        </section>
      )}

      {/* Resolvidos */}
      <section className="space-y-2">
        <div className="flex items-center gap-2 px-1 text-sm font-medium">
          <Icons.Sparkles className="text-muted-foreground h-4 w-4" />
          Resolved · {resolved.length}
          <span className="text-muted-foreground ml-auto text-xs font-normal">
            auto-resolved by the providers — review if anything looks wrong
          </span>
        </div>
        <div className="max-h-[460px] overflow-auto rounded-lg border">
          {resolved.map((a) => renderRow(a, false))}
        </div>
      </section>

      {/* Pre-import summary by activity type */}
      {byType.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2 px-1 text-sm font-medium">
            <Icons.FileText className="text-muted-foreground h-4 w-4" />
            Will import · {mapping.activities.length}
          </div>
          <div className="flex flex-wrap gap-2">
            {byType.map(([type, n]) => (
              <span
                key={type}
                className="bg-muted/40 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs"
              >
                {classLabel(type.replace(/_/g, " "))}
                <span className="font-medium tabular-nums">{n}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between border-t pt-4">
        <Button variant="outline" onClick={onBack}>
          <Icons.ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <p className="text-muted-foreground hidden text-xs sm:block">
          {convertedCount > 0
            ? `${convertedCount} will be converted to ${targetCcy} via daily FX`
            : `All assets already in ${targetCcy}`}
        </p>
        <Button onClick={onContinue} size="lg">
          Import {mapping.activities.length} activities
          <Icons.ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "amber" | "danger" | "";
}): React.JSX.Element {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "danger"
          ? "text-destructive"
          : "";
  return (
    <div className="bg-muted/40 rounded-lg px-4 py-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className={"text-2xl font-semibold tabular-nums " + color}>{value}</p>
    </div>
  );
}

interface WizardStep {
  label: string;
  state: "done" | "current" | "future";
}

export function WizardStepIndicator({ steps }: { steps: WizardStep[] }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1">
      {steps.map((s, i) => (
        <React.Fragment key={s.label}>
          <div className="flex items-center gap-2">
            <div
              className={
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold " +
                (s.state === "done"
                  ? "bg-success/20 text-success"
                  : s.state === "current"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground")
              }
            >
              {s.state === "done" ? <Icons.CheckCircle className="h-4 w-4" /> : i + 1}
            </div>
            <span
              className={
                "text-sm " +
                (s.state === "current"
                  ? "font-medium"
                  : s.state === "done"
                    ? "text-muted-foreground"
                    : "text-muted-foreground/60")
              }
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && <div className="bg-border h-px flex-1" />}
        </React.Fragment>
      ))}
    </div>
  );
}
