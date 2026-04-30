/**
 * Self-Healing Watcher Panel (v2.12.0).
 *
 * Renders the current `WatcherFindings` (pending splits / ticker migrations /
 * DRIP gaps) plus a small settings strip and a "Run check now" button. The
 * page owns the scan lifecycle (debounce on mount, 24h interval); this
 * component only renders state + dispatches user actions.
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
  countPending,
  resetWatcherCache,
  type PendingSplit,
  type PendingTickerMigration,
  type PendingDripGap,
  type WatcherFindings,
  type WatcherSettings,
  writeLastAppliedSplit,
} from "../lib/tr-splits-watcher";

interface WatcherPanelProps {
  ctx: AddonContext;
  findings: WatcherFindings | null;
  scanning: boolean;
  scanProgress: { done: number; total: number };
  settings: WatcherSettings;
  onSettingsChange: (next: WatcherSettings) => void;
  onRunNow: () => void;
  /** Called after a fix is applied — page re-runs the scan to refresh state. */
  onAfterApply: () => void;
  accountId: string;
  accountCurrency: string;
}

function formatTime(ms: number): string {
  if (!ms) return "never";
  const d = new Date(ms);
  return d.toLocaleString();
}

function formatEur(v: number): string {
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  });
}

export default function WatcherPanel({
  ctx,
  findings,
  scanning,
  scanProgress,
  settings,
  onSettingsChange,
  onRunNow,
  onAfterApply,
  accountId,
  accountCurrency,
}: WatcherPanelProps) {
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [actionMessage, setActionMessage] = React.useState<string | null>(null);

  const total = countPending(findings);

  const handleApplySplit = React.useCallback(
    async (s: PendingSplit) => {
      if (!accountId) {
        setActionMessage("Pick a target account before applying a split.");
        return;
      }
      setPendingAction(`split:${s.isin}:${s.date}`);
      setActionMessage(null);
      try {
        // Same shape used by the Diagnostics panel — Donkeyfolio's snapshot
        // service multiplies pre-split qty by `amount` (numerator/denominator).
        const factor = s.numerator / s.denominator;
        await ctx.api.activities.create({
          accountId,
          activityType: "SPLIT",
          activityDate: s.date,
          symbol: { symbol: s.ticker, name: s.name },
          quantity: 0,
          unitPrice: 0,
          amount: factor,
          currency: accountCurrency,
          fee: 0,
          comment: `TR PDF v2.12.0 watcher — applied ${s.ratio} split detected after import (${s.date}).`,
        });
        writeLastAppliedSplit(s.ticker, s.date);
        setActionMessage(`Applied ${s.ratio} split for ${s.ticker} (${s.date}).`);
        onAfterApply();
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        ctx.api.logger.warn(`[TR PDF watcher] apply-split failed for ${s.isin}: ${m}`);
        setActionMessage(`Failed to apply split for ${s.ticker}: ${m}`);
      } finally {
        setPendingAction(null);
      }
    },
    [accountCurrency, accountId, ctx, onAfterApply],
  );

  const handleResetCache = React.useCallback(() => {
    resetWatcherCache();
    setActionMessage("Watcher cache cleared — next check will re-scan everything.");
  }, []);

  const updateSetting = <K extends keyof WatcherSettings>(key: K, value: WatcherSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              Self-Healing Portfolio
              {total > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {total} pending
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Background watcher detects new splits, ticker migrations, and DRIP gaps that happen
              AFTER your last PDF import. Yahoo cached per ticker for 24h to keep network polite.
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={onRunNow} disabled={scanning}>
              {scanning ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  Scanning…
                </>
              ) : (
                <>
                  <Icons.RefreshCw className="mr-2 h-4 w-4" />
                  Run check now
                </>
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* Settings strip */}
        <div className="bg-muted/30 grid gap-2 rounded-md border p-3 text-xs sm:grid-cols-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.autoCheckSplits}
              onChange={(e) => updateSetting("autoCheckSplits", e.target.checked)}
            />
            <span>Auto-check for splits (default ON)</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.autoApplySplits}
              onChange={(e) => updateSetting("autoApplySplits", e.target.checked)}
            />
            <span>Auto-apply detected splits without confirmation</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.watchTickerChanges}
              onChange={(e) => updateSetting("watchTickerChanges", e.target.checked)}
            />
            <span>Watch for ticker migrations (suggestions only)</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.watchDripGaps}
              onChange={(e) => updateSetting("watchDripGaps", e.target.checked)}
            />
            <span>Watch for dividend reinvestment gaps (best-effort, off by default)</span>
          </label>
        </div>

        {/* Last-checked + cache reset */}
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>
            Last full scan: <strong>{formatTime(findings?.lastFullScan ?? 0)}</strong>
            {findings && (
              <>
                {" "}
                · {findings.checkedTickers} checked, {findings.skippedFresh} fresh,{" "}
                {findings.errors} errors
              </>
            )}
          </span>
          <button
            type="button"
            onClick={handleResetCache}
            className="hover:text-foreground underline"
          >
            Reset 24h cache
          </button>
        </div>

        {actionMessage && (
          <div className="rounded-md border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
            {actionMessage}
          </div>
        )}

        {scanning && (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Icons.Spinner className="h-4 w-4 animate-spin" />
            Querying Yahoo ({scanProgress.done} / {scanProgress.total})…
          </div>
        )}

        {!scanning && total === 0 && (
          <div className="flex items-center gap-2 rounded border p-3 text-xs text-green-700 dark:text-green-300">
            <Icons.CheckCircle className="h-4 w-4 shrink-0" />
            <span>No pending corrections — your imported holdings match Yahoo's events.</span>
          </div>
        )}

        {findings && findings.splits.length > 0 && (
          <SplitsTable
            splits={findings.splits}
            onApply={handleApplySplit}
            pendingAction={pendingAction}
          />
        )}

        {findings && findings.tickerMigrations.length > 0 && (
          <TickerMigrationsTable migrations={findings.tickerMigrations} />
        )}

        {findings && findings.dripGaps.length > 0 && <DripGapsTable gaps={findings.dripGaps} />}
      </CardContent>
    </Card>
  );
}

function SplitsTable({
  splits,
  onApply,
  pendingAction,
}: {
  splits: PendingSplit[];
  onApply: (s: PendingSplit) => void;
  pendingAction: string | null;
}) {
  return (
    <div>
      <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Icons.AlertCircle className="h-4 w-4 text-amber-600" />
        New stock splits ({splits.length})
      </h4>
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stock</TableHead>
              <TableHead>Ticker</TableHead>
              <TableHead>Split date</TableHead>
              <TableHead className="text-right">Ratio</TableHead>
              <TableHead className="text-right">DB qty</TableHead>
              <TableHead className="text-right">After split</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {splits.map((s) => {
              const key = `split:${s.isin}:${s.date}`;
              const isPending = pendingAction === key;
              return (
                <TableRow key={key}>
                  <TableCell className="max-w-xs truncate" title={s.name}>
                    {s.name}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.ticker}</TableCell>
                  <TableCell className="font-mono text-xs">{s.date}</TableCell>
                  <TableCell className="text-right font-mono">
                    <Badge variant="outline" className="text-xs">
                      {s.ratio}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">{s.dbQty.toFixed(4)}</TableCell>
                  <TableCell className="text-right font-mono">
                    {(s.dbQty * s.ratioMul).toFixed(4)}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => onApply(s)}
                      disabled={isPending}
                    >
                      {isPending ? (
                        <>
                          <Icons.Spinner className="mr-2 h-3 w-3 animate-spin" />
                          Applying…
                        </>
                      ) : (
                        "Apply"
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function TickerMigrationsTable({ migrations }: { migrations: PendingTickerMigration[] }) {
  return (
    <div>
      <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Icons.AlertCircle className="h-4 w-4 text-blue-600" />
        Ticker migrations ({migrations.length})
      </h4>
      <p className="text-muted-foreground mb-2 text-xs">
        Yahoo no longer returns data for these tickers. The ISIN search suggests a replacement —
        verify before changing in Donkeyfolio (manual asset symbol edit).
      </p>
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stock</TableHead>
              <TableHead>ISIN</TableHead>
              <TableHead>Old ticker</TableHead>
              <TableHead>Suggested new</TableHead>
              <TableHead>Verify</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {migrations.map((m) => (
              <TableRow key={`${m.isin}-${m.toTicker}`}>
                <TableCell className="max-w-xs truncate" title={m.name}>
                  {m.name}
                </TableCell>
                <TableCell className="font-mono text-xs">{m.isin}</TableCell>
                <TableCell className="font-mono text-xs text-amber-600">{m.fromTicker}</TableCell>
                <TableCell className="font-mono text-xs text-green-700 dark:text-green-400">
                  {m.toTicker}
                </TableCell>
                <TableCell>
                  <a
                    href={`https://finance.yahoo.com/quote/${encodeURIComponent(m.toTicker)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400"
                  >
                    Yahoo →
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function DripGapsTable({ gaps }: { gaps: PendingDripGap[] }) {
  return (
    <div>
      <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Icons.AlertCircle className="h-4 w-4 text-amber-600" />
        Possible DRIP gaps ({gaps.length})
      </h4>
      <p className="text-muted-foreground mb-2 text-xs">
        Best-effort: dividend × shares is materially above what we found in DB on or near the
        ex-date. Could be a missed DRIP buy or simply a different broker — investigate before
        manually adding activities.
      </p>
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stock</TableHead>
              <TableHead>Ticker</TableHead>
              <TableHead>Ex-date</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Gap</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {gaps.map((g) => (
              <TableRow key={`${g.isin}-${g.date}`}>
                <TableCell className="max-w-xs truncate" title={g.name}>
                  {g.name}
                </TableCell>
                <TableCell className="font-mono text-xs">{g.ticker}</TableCell>
                <TableCell className="font-mono text-xs">{g.date}</TableCell>
                <TableCell className="text-right font-mono">{formatEur(g.expectedEur)}</TableCell>
                <TableCell className="text-right font-mono">{formatEur(g.actualEur)}</TableCell>
                <TableCell className="text-right font-mono text-amber-700">
                  {formatEur(g.gapEur)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
