/**
 * EUR View panel (v4.7.0).
 *
 * Renders a Donkeyfolio-style holdings table where every monetary
 * column is in EUR — Today's Price, Book Cost, Avg Cost, Total Value,
 * Unrealized Gain. Numbers come from the Wealthfolio SDK (no external
 * APIs) and are recomputed in the browser; nothing is written back to
 * the database.
 *
 * Trade-off: this panel doesn't replace Wealthfolio's native Holdings
 * page nor the per-asset detail page. It's an independent EUR-aligned
 * view inside the addon.
 */
import type { Account, ActivityDetails, AddonContext, Holding } from "@wealthfolio/addon-sdk";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
  Input,
} from "@wealthfolio/ui";
import React from "react";

import {
  computeEurHoldings,
  listMissingRates,
  summariseEurHoldings,
  type EurHoldingRow,
  type EurHoldingsTotals,
} from "../lib/tr-eur-holdings";
import { loadFxRates, type FxRateMap } from "../lib/tr-fx-rates";
import { ensureEurFxPairs } from "../lib/tr-fx-pairs";

interface AccountSummary {
  id: string;
  name: string;
  currency: string;
  holdingsCount: number;
  activitiesCount: number;
}

interface Props {
  ctx: AddonContext;
  onClose: () => void;
}

interface LoadedData {
  // Raw inputs kept around so the user can switch the account filter
  // without re-fetching from the SDK.
  allHoldings: Holding[];
  allActivities: ActivityDetails[];
  fx: FxRateMap;
  accounts: AccountSummary[];
  fetchedAt: Date;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: LoadedData };

export function EurHoldingsView({ ctx, onClose }: Props): React.JSX.Element {
  const [state, setState] = React.useState<ViewState>({ kind: "loading" });
  const [filter, setFilter] = React.useState("");
  // null = all accounts aggregated (default). Account id otherwise.
  const [selectedAccountId, setSelectedAccountId] = React.useState<string | null>(null);
  // null = idle; a string is the in-progress message while creating FX pairs.
  const [fixing, setFixing] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setState({ kind: "loading" });
    try {
      // v4.8.1 — aggregate across ALL active accounts. Earlier versions
      // scoped to a single "Trade Republic" account looked up by name,
      // which silently returned an empty view when the user's account
      // was named differently or activities lived in another account.
      // Using all accounts also makes the view useful for non-TR users.
      const accounts = (await ctx.api.accounts.getAll()) as Account[];
      const activeAccounts = accounts.filter((a) => a.isActive !== false);

      const allHoldings: Holding[] = [];
      const allActivities: ActivityDetails[] = [];
      const summaries: AccountSummary[] = [];

      for (const a of activeAccounts) {
        const [hs, acts] = (await Promise.all([
          ctx.api.portfolio.getHoldings(a.id),
          ctx.api.activities.getAll(a.id),
        ])) as [Holding[], ActivityDetails[]];
        allHoldings.push(...hs);
        allActivities.push(...acts);
        summaries.push({
          id: a.id,
          name: a.name,
          currency: a.currency || "EUR",
          holdingsCount: hs.length,
          activitiesCount: acts.length,
        });
      }

      const fx = (await loadFxRates(ctx)) as FxRateMap;
      setState({
        kind: "loaded",
        data: {
          allHoldings,
          allActivities,
          fx,
          accounts: summaries,
          fetchedAt: new Date(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.api.logger.error(`EUR View load failed: ${message}`);
      setState({ kind: "error", message });
    }
  }, [ctx]);

  // Fix the EUR conversion: re-align mislabelled asset currencies to native,
  // create the missing FX:<ccy>/EUR pairs (source YAHOO, ECB-seeded), then sync
  // + recalculate. Reloads when done. See tr-fx-pairs.ts.
  const handleCreateMissingRates = React.useCallback(async () => {
    setFixing("Fixing…");
    try {
      const res = await ensureEurFxPairs(ctx, (msg) => setFixing(msg));
      ctx.api.logger.info(
        `[TR fx] currencies=${res.currencies.join(",") || "—"} created=${res.created.join(",") || "—"} ` +
          `skipped=${res.skipped.length} failed=${res.failed.length} sync=${res.synced} recalc=${res.recalculated}`,
      );
      await load();
    } catch (e) {
      ctx.api.logger.error(`[TR fx] ${(e as Error).message}`);
    } finally {
      setFixing(null);
    }
  }, [ctx, load]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Hooks MUST be called unconditionally on every render. Recompute the
  // table whenever the selected account changes — instant filter without
  // re-fetching from the SDK.
  const computed = React.useMemo(() => {
    if (state.kind !== "loaded") {
      return {
        rows: [] as EurHoldingRow[],
        totals: null as EurHoldingsTotals | null,
        missingRates: [] as string[],
      };
    }
    const { allHoldings, allActivities, fx } = state.data;
    const scopedHoldings = selectedAccountId
      ? allHoldings.filter((h) => h.accountId === selectedAccountId)
      : allHoldings;
    const scopedActivities = selectedAccountId
      ? allActivities.filter((a) => a.accountId === selectedAccountId)
      : allActivities;
    const rows = computeEurHoldings(scopedHoldings, scopedActivities, fx);
    return {
      rows,
      totals: summariseEurHoldings(rows),
      missingRates: listMissingRates(rows, fx),
    };
  }, [state, selectedAccountId]);

  const filtered = React.useMemo(() => {
    const rows = computed.rows;
    if (!filter.trim()) return rows;
    const q = filter.trim().toLowerCase();
    return rows.filter(
      (r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
    );
  }, [computed.rows, filter]);

  if (state.kind === "loading") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16">
          <Icons.Spinner className="text-muted-foreground mb-4 h-10 w-10 animate-spin" />
          <p className="text-sm font-medium">Computing holdings in €…</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Reads positions, activities and FX rates from the Donkeyfolio DB.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.AlertCircle className="text-destructive h-5 w-5" />
            Failed to load EUR View
          </CardTitle>
          <CardDescription>{state.message}</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button variant="outline" onClick={load}>
            <Icons.Refresh className="mr-2 h-4 w-4" />
            Try again
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { accounts, fetchedAt } = state.data;
  const { rows, totals, missingRates } = computed;
  // `totals` is non-null whenever state.kind === "loaded".
  if (totals == null) return <></>;
  const accountsWithData = accounts.filter((a) => a.holdingsCount > 0 || a.activitiesCount > 0);
  const selectedAccount = selectedAccountId
    ? accounts.find((a) => a.id === selectedAccountId)
    : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Icons.Globe className="text-primary h-5 w-5" />
              EUR View — aligned with TR
            </CardTitle>
            <CardDescription className="mt-1">
              Today's Price, Book Cost, Avg Cost and Total Value computed in € using Donkeyfolio's
              internal FX rates. Computed at runtime, nothing is written back. Updated{" "}
              {fmtTime(fetchedAt)}.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button
              variant="default"
              size="sm"
              disabled={fixing != null}
              onClick={handleCreateMissingRates}
            >
              {fixing != null ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {fixing}
                </>
              ) : (
                <>
                  <Icons.Sparkles className="mr-2 h-4 w-4" />
                  Fix EUR conversion
                </>
              )}
            </Button>
            <Button variant="outline" size="sm" onClick={load}>
              <Icons.Refresh className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </CardHeader>
      </Card>

      {/* Account selector — only show when there's something to choose */}
      {accounts.length > 1 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Filter by account
              {selectedAccount && (
                <span className="text-muted-foreground ml-2 text-xs font-normal">
                  · {selectedAccount.name}
                </span>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              By default the EUR View shows the aggregated portfolio across all accounts. Click an
              account to isolate the view to that account — useful when you have several brokers and
              want to see each one separately.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="flex flex-wrap gap-2">
              <AccountChip
                label="All accounts"
                sublabel={`${accountsWithData.length}/${accounts.length} with data`}
                active={selectedAccountId == null}
                onClick={() => setSelectedAccountId(null)}
              />
              {accounts.map((a) => (
                <AccountChip
                  key={a.id}
                  label={a.name}
                  sublabel={`${a.holdingsCount} hold · ${a.activitiesCount} act · ${a.currency}`}
                  active={selectedAccountId === a.id}
                  empty={a.holdingsCount === 0 && a.activitiesCount === 0}
                  onClick={() => setSelectedAccountId(a.id)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Single-account user — just show what we found */}
      {accounts.length === 1 && (
        <Card className="bg-muted/20">
          <CardContent className="flex items-center gap-3 py-2 text-xs">
            <Icons.CheckCircle className="text-success h-4 w-4 shrink-0" />
            <span>
              <strong>{accounts[0].name}</strong> ({accounts[0].currency}) ·{" "}
              {accounts[0].holdingsCount} holdings · {accounts[0].activitiesCount} activities
            </span>
          </CardContent>
        </Card>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-3">
        <Card className="border-blue-500/10 bg-blue-500/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Positions</CardTitle>
            <span className="text-xl font-bold tabular-nums sm:text-2xl">{rows.length}</span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <Row label="Unique" value={rows.length.toLocaleString("pt-PT")} />
            <Row
              label="With FX gap"
              value={totals.positionsWithFxGap.toLocaleString("pt-PT")}
              accent={totals.positionsWithFxGap > 0 ? "warn" : ""}
            />
          </CardContent>
        </Card>

        <Card
          className={
            totals.unrealizedGainEur >= 0
              ? "border-success/10 bg-success/10"
              : "border-destructive/10 bg-destructive/10"
          }
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Total Value</CardTitle>
            <span className="text-xl font-bold tabular-nums sm:text-2xl">
              {fmtEur(totals.totalValueEur)}
            </span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <Row label="Book Cost" value={fmtEur(totals.bookCostEur)} />
            <Row
              label="Unrealized Gain"
              value={`${fmtEur(totals.unrealizedGainEur)} (${(totals.unrealizedGainPct * 100).toFixed(2)}%)`}
              accent={totals.unrealizedGainEur >= 0 ? "good" : "bad"}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">How it works</CardTitle>
            <Icons.Sparkles className="text-primary h-5 w-5" />
          </CardHeader>
          <CardContent className="space-y-1 pt-2 text-xs">
            <p className="text-muted-foreground">
              Book Cost = sum of the <code>amount</code> of BUY/SELL in the original currency,
              converted to EUR via the current FX. Avg Cost = Book Cost / qty. Today's Price EUR =
              Yahoo price × FX. No core patches, nothing hardcoded.
            </p>
          </CardContent>
        </Card>
      </div>

      {missingRates.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 py-3 text-sm">
            <Icons.AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div className="space-y-2">
              <p className="font-medium">FX rates missing in the Donkeyfolio DB</p>
              <p className="text-muted-foreground text-xs">
                Could not convert: {missingRates.join(", ")}. Affected positions show "—" instead of
                a EUR value. Create the missing pairs (source Yahoo, seeded live from the ECB —
                nothing hardcoded); the daily history is then synced by the core.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={fixing != null}
                onClick={handleCreateMissingRates}
              >
                {fixing != null ? (
                  <>
                    <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                    {fixing}
                  </>
                ) : (
                  <>
                    <Icons.Refresh className="mr-2 h-4 w-4" />
                    Create missing rates
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filter */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by ticker or name..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-sm"
        />
        <span className="text-muted-foreground ml-auto text-xs">
          {filtered.length} of {rows.length}
        </span>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0">
                <tr className="text-muted-foreground text-xs uppercase tracking-wider">
                  <th className="p-3 text-left font-medium">Position</th>
                  <th className="p-3 text-right font-medium">Qty</th>
                  <th className="p-3 text-right font-medium">Today's Price</th>
                  <th className="p-3 text-right font-medium">Avg Cost</th>
                  <th className="p-3 text-right font-medium">Book Cost</th>
                  <th className="p-3 text-right font-medium">Total Value</th>
                  <th className="p-3 text-right font-medium">Unrealized</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.symbol} className="hover:bg-muted/20 border-t">
                    <td className="p-3">
                      <p className="font-medium">{r.name}</p>
                      <p className="text-muted-foreground text-xs">
                        {r.symbol}
                        {r.localCurrency !== "EUR" && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            native {r.localCurrency}
                          </Badge>
                        )}
                      </p>
                    </td>
                    <td className="text-muted-foreground p-3 text-right tabular-nums">
                      {r.quantity.toLocaleString("pt-PT", {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 6,
                      })}
                    </td>
                    <td className="p-3 text-right">
                      <p className="font-medium tabular-nums">
                        {r.todayPriceEur != null ? fmtEur(r.todayPriceEur) : "—"}
                      </p>
                      {r.todayPriceLocal != null && r.localCurrency !== "EUR" && (
                        <p className="text-muted-foreground text-[11px] tabular-nums">
                          {fmtCcy(r.todayPriceLocal, r.localCurrency)}
                        </p>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      <p className="font-medium tabular-nums">{fmtEur(r.avgCostEur)}</p>
                    </td>
                    <td className="p-3 text-right">
                      <p className="font-medium tabular-nums">{fmtEur(r.bookCostEur)}</p>
                    </td>
                    <td className="p-3 text-right">
                      <p className="font-medium tabular-nums">
                        {r.totalValueEur != null ? fmtEur(r.totalValueEur) : "—"}
                      </p>
                    </td>
                    <td className="p-3 text-right">
                      {r.unrealizedGainEur != null && r.unrealizedGainPct != null ? (
                        <>
                          <p
                            className={
                              "font-medium tabular-nums " +
                              (r.unrealizedGainEur >= 0 ? "text-success" : "text-destructive")
                            }
                          >
                            {fmtEur(r.unrealizedGainEur)}
                          </p>
                          <p
                            className={
                              "text-xs tabular-nums " +
                              (r.unrealizedGainPct >= 0 ? "text-success" : "text-destructive")
                            }
                          >
                            {(r.unrealizedGainPct * 100).toFixed(2)}%
                          </p>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-muted-foreground p-8 text-center text-sm">
                      No positions to show.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Account chip used in the account-selector card. Highlighted when
 * active. Greyed out / dashed border when the account has no data
 * (helps the user quickly see which accounts are empty).
 */
function AccountChip({
  label,
  sublabel,
  active,
  empty,
  onClick,
}: {
  label: string;
  sublabel: string;
  active: boolean;
  empty?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const base =
    "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-xs transition-colors";
  const variant = active
    ? "border-primary bg-primary/15 text-foreground"
    : empty
      ? "border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10 text-muted-foreground"
      : "border-border bg-muted/20 hover:bg-muted/40";
  return (
    <button onClick={onClick} className={`${base} ${variant}`}>
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground text-[10px]">{sublabel}</span>
    </button>
  );
}

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span
        className={
          "font-medium tabular-nums " +
          (accent === "good"
            ? "text-success"
            : accent === "bad"
              ? "text-destructive"
              : accent === "warn"
                ? "text-amber-500"
                : "")
        }
      >
        {value}
      </span>
    </div>
  );
}

const eurFmt = new Intl.NumberFormat("pt-PT", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 2,
});

function fmtEur(n: number): string {
  return eurFmt.format(n);
}

function fmtCcy(n: number, ccy: string): string {
  try {
    return new Intl.NumberFormat("pt-PT", {
      style: "currency",
      currency: ccy,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${ccy}`;
  }
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}
