/**
 * Holdings Diagnostics Panel (v2.11.0).
 *
 * Renders the per-holding drift / diagnosis table after an import. The page
 * runs the analyzer once import completes (or when the user opens the
 * Diagnostics tab on a parsed-but-not-imported PDF) and passes results in.
 *
 * Designed to be self-contained: this component owns sorting, filtering,
 * pagination, action button wiring, and the export-to-CSV/JSON button.
 */
import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import React from "react";

import {
  buildDiagnosticsCsv,
  summariseDiagnostics,
  type DiagnosisCode,
  type HoldingDiagnostic,
} from "../lib/tr-diagnostics";
import type { SplitEvent } from "../lib/tr-splits";

const PAGE_SIZE = 50;

interface DiagnosticsPanelProps {
  ctx: AddonContext;
  diagnostics: HoldingDiagnostic[];
  /** True while the analyzer is mid-run (yahoo fetches in flight). */
  loading: boolean;
  /** "x of y tickers fetched" progress, when loading. */
  progress?: { done: number; total: number };
  /** Re-run the analyzer (useful after applying a fix). */
  onRefresh: () => void;
  /** Detected splits — needed when applying SPLIT_DETECTED_NOT_APPLIED action. */
  autoSplits: SplitEvent[];
  /** Currently selected account id — required for ctx.api.activities.create. */
  accountId: string;
  /** Account currency (e.g. "EUR") for SPLIT activity payloads. */
  accountCurrency: string;
  /** Save a generated report file (CSV/JSON). */
  onExport: (filename: string, content: string, mime: string) => Promise<void>;
}

type FilterKey = "all" | DiagnosisCode | "drift-only";
type SortKey = "drift-eur" | "drift-pct" | "name";

const DIAGNOSIS_LABEL: Record<DiagnosisCode, string> = {
  SPLIT_DETECTED_NOT_APPLIED: "Split needed",
  QTY_COLLISION_LIKELY: "Qty collision",
  MISSING_CRYPTO_DIRECT_BUYS: "Crypto buys missing",
  COST_BASIS_VS_PROCEEDS: "Cost basis gap",
  STALE_PRICE: "Stale price",
  FX_DISPLAY_ISSUE: "FX display",
  OK: "OK",
};

function formatEur(value: number): string {
  const sign = value < 0 ? "-" : "";
  return (
    sign +
    Math.abs(value).toLocaleString("en-US", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 2,
    })
  );
}

function formatQty(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatPct(value: number): string {
  return (value * 100).toFixed(2) + "%";
}

export default function DiagnosticsPanel({
  ctx,
  diagnostics,
  loading,
  progress,
  onRefresh,
  autoSplits,
  accountId,
  accountCurrency,
  onExport,
}: DiagnosticsPanelProps) {
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [sort, setSort] = React.useState<SortKey>("drift-eur");
  const [page, setPage] = React.useState(0);
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [actionMessage, setActionMessage] = React.useState<string | null>(null);

  const summary = React.useMemo(() => summariseDiagnostics(diagnostics), [diagnostics]);

  const filtered = React.useMemo(() => {
    let rows = diagnostics;
    if (filter === "drift-only") {
      rows = rows.filter((d) => d.severity !== "ok");
    } else if (filter !== "all") {
      rows = rows.filter((d) => d.diagnosis === filter);
    }
    const sorted = [...rows];
    if (sort === "drift-eur") {
      sorted.sort((a, b) => Math.abs(b.driftEur) - Math.abs(a.driftEur));
    } else if (sort === "drift-pct") {
      sorted.sort((a, b) => b.driftPct - a.driftPct);
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  }, [diagnostics, filter, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Reset to first page when filter changes.
  React.useEffect(() => {
    setPage(0);
  }, [filter, sort]);

  const handleApplySplit = React.useCallback(
    async (d: HoldingDiagnostic) => {
      const split = autoSplits.find((s) => s.isin === d.isin);
      if (!split) {
        setActionMessage(`No split data found for ${d.ticker}.`);
        return;
      }
      if (!accountId) {
        setActionMessage("Select a target account before applying a split.");
        return;
      }
      setPendingAction(d.isin);
      setActionMessage(null);
      try {
        // Donkeyfolio's snapshot service multiplies pre-split quantities by
        // the SPLIT activity's `amount` value (numerator/denominator).
        const factor = split.numerator / split.denominator;
        await ctx.api.activities.create({
          accountId,
          activityType: "SPLIT",
          activityDate: split.date,
          symbol: { symbol: split.ticker, name: split.stockName },
          quantity: 0,
          unitPrice: 0,
          amount: factor,
          currency: accountCurrency,
          fee: 0,
          comment: `TR PDF v2.11.0 diagnostics — applied ${split.ratio} split (${split.date}). Pre-split qty × ${factor} = post-split qty.`,
        });
        setActionMessage(`Applied ${split.ratio} split for ${d.ticker} on ${split.date}.`);
        onRefresh();
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        ctx.api.logger.warn(`[TR PDF] apply-split failed for ${d.isin}: ${m}`);
        setActionMessage(`Failed to apply split for ${d.ticker}: ${m}`);
      } finally {
        setPendingAction(null);
      }
    },
    [accountCurrency, accountId, autoSplits, ctx, onRefresh],
  );

  const handleSyncPrice = React.useCallback(
    async (d: HoldingDiagnostic) => {
      if (!d.dbAssetId) {
        setActionMessage(`No DB asset id for ${d.ticker} — re-import first.`);
        return;
      }
      setPendingAction(d.isin);
      setActionMessage(null);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const market = (ctx.api as any).market;
        if (!market?.sync) {
          setActionMessage("market.sync API not available in this Donkeyfolio build.");
          return;
        }
        await market.sync([d.dbAssetId], false);
        setActionMessage(`Synced price for ${d.ticker}.`);
        onRefresh();
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        ctx.api.logger.warn(`[TR PDF] sync-price failed for ${d.isin}: ${m}`);
        setActionMessage(`Sync failed for ${d.ticker}: ${m}`);
      } finally {
        setPendingAction(null);
      }
    },
    [ctx, onRefresh],
  );

  const handleExportCsv = React.useCallback(async () => {
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    await onExport(
      `tr-diagnostics-${ts}.csv`,
      buildDiagnosticsCsv(diagnostics),
      "text/csv;charset=utf-8",
    );
  }, [diagnostics, onExport]);

  const handleExportJson = React.useCallback(async () => {
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    await onExport(
      `tr-diagnostics-${ts}.json`,
      JSON.stringify(diagnostics, null, 2),
      "application/json",
    );
  }, [diagnostics, onExport]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Holdings Diagnostics</CardTitle>
            <CardDescription>
              Comparing parsed import vs current Donkeyfolio holdings. Each holding gets a
              rule-based diagnosis and (where possible) a one-click fix. Yahoo prices cached locally
              for 1 hour.
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onRefresh}
              disabled={loading || pendingAction !== null}
            >
              {loading ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Icons.RefreshCw className="mr-2 h-4 w-4" />
                  Re-run
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportCsv}
              disabled={loading || diagnostics.length === 0}
            >
              <Icons.Download className="mr-2 h-4 w-4" />
              CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportJson}
              disabled={loading || diagnostics.length === 0}
            >
              <Icons.Download className="mr-2 h-4 w-4" />
              JSON
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* Loading state */}
        {loading && (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Icons.Spinner className="h-4 w-4 animate-spin" />
            Fetching Yahoo prices ({progress?.done ?? 0} / {progress?.total ?? 0})…
          </div>
        )}

        {/* Empty state */}
        {!loading && diagnostics.length === 0 && (
          <div className="text-muted-foreground py-6 text-center text-xs">
            No holdings to diagnose. Import a TR PDF to populate this view.
          </div>
        )}

        {diagnostics.length > 0 && (
          <>
            {/* Summary tiles */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <SummaryTile label="Holdings checked" value={summary.total} tone="neutral" />
              <SummaryTile label="OK" value={summary.ok} tone="positive" />
              <SummaryTile label="Drifting (minor)" value={summary.drifting} tone="warning" />
              <SummaryTile label="Material drift" value={summary.material} tone="negative" />
            </div>

            {/* Filter / sort controls */}
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-muted-foreground text-xs font-medium">Filter:</label>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as FilterKey)}
                className="border-input bg-background h-8 rounded-md border px-2 text-xs"
              >
                <option value="all">All ({diagnostics.length})</option>
                <option value="drift-only">Drift only ({summary.total - summary.ok})</option>
                <option value="SPLIT_DETECTED_NOT_APPLIED">
                  Split needed ({summary.byDiagnosis.SPLIT_DETECTED_NOT_APPLIED})
                </option>
                <option value="QTY_COLLISION_LIKELY">
                  Qty collision ({summary.byDiagnosis.QTY_COLLISION_LIKELY})
                </option>
                <option value="MISSING_CRYPTO_DIRECT_BUYS">
                  Crypto missing ({summary.byDiagnosis.MISSING_CRYPTO_DIRECT_BUYS})
                </option>
                <option value="COST_BASIS_VS_PROCEEDS">
                  Cost basis ({summary.byDiagnosis.COST_BASIS_VS_PROCEEDS})
                </option>
                <option value="STALE_PRICE">Stale price ({summary.byDiagnosis.STALE_PRICE})</option>
                <option value="FX_DISPLAY_ISSUE">
                  FX display ({summary.byDiagnosis.FX_DISPLAY_ISSUE})
                </option>
                <option value="OK">OK ({summary.byDiagnosis.OK})</option>
              </select>
              <label className="text-muted-foreground ml-2 text-xs font-medium">Sort:</label>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="border-input bg-background h-8 rounded-md border px-2 text-xs"
              >
                <option value="drift-eur">Abs € drift</option>
                <option value="drift-pct">% drift</option>
                <option value="name">Name</option>
              </select>
              <span className="text-muted-foreground ml-auto text-xs">
                {filtered.length} row{filtered.length === 1 ? "" : "s"}
              </span>
            </div>

            {/* Action result */}
            {actionMessage && (
              <div className="rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
                {actionMessage}
              </div>
            )}

            {/* Table */}
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Holding</TableHead>
                    <TableHead className="text-right">Computed qty</TableHead>
                    <TableHead className="text-right">DB qty</TableHead>
                    <TableHead className="text-right">Drift</TableHead>
                    <TableHead className="text-right">Yahoo price</TableHead>
                    <TableHead className="text-right">Avg cost</TableHead>
                    <TableHead>Diagnosis</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((d) => (
                    <TableRow
                      key={d.isin}
                      className={
                        d.severity === "material"
                          ? "bg-red-50/40 dark:bg-red-950/10"
                          : d.severity === "minor"
                            ? "bg-amber-50/40 dark:bg-amber-950/10"
                            : undefined
                      }
                    >
                      <TableCell className="max-w-xs">
                        <div className="truncate font-medium" title={d.name}>
                          {d.name}
                        </div>
                        <div className="text-muted-foreground font-mono text-[10px]">
                          {d.ticker} · {d.isin}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatQty(d.computedQty)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatQty(d.dbQty)}</TableCell>
                      <TableCell className="text-right font-mono">
                        <DriftCell d={d} />
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {d.yahooPrice == null
                          ? "—"
                          : `${d.yahooPrice.toFixed(2)} ${d.yahooCurrency ?? ""}`}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {d.computedAvgCost > 0 ? formatEur(d.computedAvgCost) : "—"}
                      </TableCell>
                      <TableCell>
                        <DiagnosisBadge code={d.diagnosis} />
                        <div
                          className="text-muted-foreground mt-0.5 max-w-sm truncate text-[10px]"
                          title={d.reason}
                        >
                          {d.reason}
                        </div>
                      </TableCell>
                      <TableCell>
                        <ActionButton
                          d={d}
                          pending={pendingAction === d.isin}
                          onApplySplit={handleApplySplit}
                          onSyncPrice={handleSyncPrice}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {pageCount > 1 && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  Page {safePage + 1} of {pageCount}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                    disabled={safePage >= pageCount - 1}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "positive" | "warning" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? "text-green-700 dark:text-green-300"
      : tone === "warning"
        ? "text-amber-700 dark:text-amber-300"
        : tone === "negative"
          ? "text-red-700 dark:text-red-300"
          : "";
  return (
    <div className="bg-muted/40 rounded-md border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={`mt-0.5 font-mono text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function DriftCell({ d }: { d: HoldingDiagnostic }) {
  const qtyDiff = d.computedQty - d.dbQty;
  const cls =
    d.severity === "material"
      ? "text-red-700 dark:text-red-300"
      : d.severity === "minor"
        ? "text-amber-700 dark:text-amber-300"
        : "text-green-700 dark:text-green-300";
  const dot =
    d.severity === "material"
      ? "bg-red-500"
      : d.severity === "minor"
        ? "bg-amber-500"
        : "bg-green-500";
  return (
    <div className={`flex items-center justify-end gap-1.5 ${cls}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      <div className="text-right">
        <div>{formatQty(qtyDiff)}</div>
        <div className="text-[10px] opacity-70">
          {formatPct(d.driftPct)} · {formatEur(d.driftEur)}
        </div>
      </div>
    </div>
  );
}

function DiagnosisBadge({ code }: { code: DiagnosisCode }) {
  const variant =
    code === "OK"
      ? "outline"
      : code === "SPLIT_DETECTED_NOT_APPLIED" || code === "MISSING_CRYPTO_DIRECT_BUYS"
        ? "destructive"
        : "secondary";
  return (
    <Badge variant={variant} className="text-[10px]">
      {DIAGNOSIS_LABEL[code]}
    </Badge>
  );
}

function ActionButton({
  d,
  pending,
  onApplySplit,
  onSyncPrice,
}: {
  d: HoldingDiagnostic;
  pending: boolean;
  onApplySplit: (d: HoldingDiagnostic) => void;
  onSyncPrice: (d: HoldingDiagnostic) => void;
}) {
  if (d.action === "APPLY_SPLIT") {
    return (
      <Button size="sm" variant="outline" disabled={pending} onClick={() => onApplySplit(d)}>
        {pending ? <Icons.Spinner className="h-3 w-3 animate-spin" /> : "Apply split"}
      </Button>
    );
  }
  if (d.action === "SYNC_PRICE") {
    return (
      <Button size="sm" variant="outline" disabled={pending} onClick={() => onSyncPrice(d)}>
        {pending ? <Icons.Spinner className="h-3 w-3 animate-spin" /> : "Sync price"}
      </Button>
    );
  }
  if (d.action === "RE_RESOLVE_CRYPTO") {
    return <span className="text-muted-foreground text-[10px]">Re-import after v2.10.1</span>;
  }
  if (d.action === "INFO_ONLY") {
    return (
      <Badge variant="secondary" className="text-[10px]">
        Core fix needed
      </Badge>
    );
  }
  return <span className="text-muted-foreground text-[10px]">—</span>;
}
