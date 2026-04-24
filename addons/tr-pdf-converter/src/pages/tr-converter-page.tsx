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
  Progress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@wealthfolio/ui";
import React from "react";

import {
  buildGenericCsv,
  buildLexwareCsv,
  calculatePnL,
  computeCashSanityChecks,
  enrichTradingWithQuantity,
  parsePDF,
  parseTradingTransactions,
  recoverCashAmounts,
  type CashTransaction,
  type InterestTransaction,
  type PnLResult,
  type TradingTransaction,
} from "../lib/tr-parser";
import { ensureTRAccount } from "../lib/tr-account";
import { buildActivitiesFromParsed, buildTradingCashKeys } from "../lib/tr-to-activities";

interface ParseState {
  status: "idle" | "parsing" | "done" | "error";
  message?: string;
  progress?: { page: number; total: number };
  cash: CashTransaction[];
  interest: InterestTransaction[];
  trading: TradingTransaction[];
  pnl: PnLResult | null;
  failedChecks: number;
  recoveredRows: number;
  fileName: string;
}

type ImportState =
  | { status: "idle" }
  | { status: "running"; message: string }
  | { status: "done"; imported: number; skipped: number; accountCreated: boolean }
  | { status: "error"; message: string };

const initialState: ParseState = {
  status: "idle",
  cash: [],
  interest: [],
  trading: [],
  pnl: null,
  failedChecks: 0,
  recoveredRows: 0,
  fileName: "",
};

// ─── Status translation (jcmpagel's parser emits German labels) ─────────
const STATUS_EN: Record<string, string> = {
  Offen: "Open",
  Geschlossen: "Closed",
  Teilweise: "Partial",
  Verkauf: "Sold",
  Ausgeglichen: "Balanced",
};
const translateStatus = (s: string | undefined): string => (s && STATUS_EN[s]) || s || "";

// German TR transaction types → English (for older/mixed TR statement formats)
const TYPE_EN: Record<string, string> = {
  Handel: "Trade",
  Kartenzahlung: "Card payment",
  Karte: "Card",
  Sparplan: "Savings plan",
  Überweisung: "Transfer",
  Einzahlung: "Deposit",
  Auszahlung: "Withdrawal",
  Lastschrift: "Direct debit",
  Zinsen: "Interest",
  Dividende: "Dividend",
  Dividenden: "Dividends",
  Steuern: "Taxes",
  Steuer: "Tax",
  Gebühr: "Fee",
  Gebühren: "Fees",
  Umbuchung: "Rebooking",
  Rundung: "Rounding",
  Prämie: "Bonus",
  Rückzahlung: "Repayment",
  Ausgleich: "Settlement",
  Erstattung: "Refund",
  Zahlung: "Payment",
  Kauf: "Buy",
  Verkauf: "Sell",
  Ertrag: "Income",
};
const translateType = (s: string | undefined): string => {
  if (!s) return "";
  return s
    .split(/\s+/)
    .map((w) => TYPE_EN[w] ?? w)
    .join(" ");
};

// Map jcmpagel cash transaction shape → analytics shape used by parseTradingTransactions
function toAnalyticsShape(tx: CashTransaction) {
  return {
    date: tx.datum,
    type: tx.typ,
    description: tx.beschreibung,
    incoming: tx.zahlungseingang,
    outgoing: tx.zahlungsausgang,
    balance: tx.saldo,
  };
}

function downloadBlob(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

function formatEur(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  });
}

function formatQty(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

interface TrConverterPageProps {
  ctx: AddonContext;
}

export default function TrConverterPage({ ctx }: TrConverterPageProps) {
  const [state, setState] = React.useState<ParseState>(initialState);
  const [importState, setImportState] = React.useState<ImportState>({ status: "idle" });
  const [showOnlyFailed, setShowOnlyFailed] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);

  const handleFile = React.useCallback(async (file: File) => {
    setImportState({ status: "idle" });
    setShowOnlyFailed(false);
    setState({
      ...initialState,
      status: "parsing",
      message: "Reading PDF…",
      fileName: file.name,
    });
    try {
      const buffer = await file.arrayBuffer();
      const result = await parsePDF(buffer, (page, total) => {
        setState((s) => ({
          ...s,
          progress: { page, total },
          message: `Parsing page ${page} of ${total}`,
        }));
      });

      // Auto-recover trade rows with column-swapped or missing amounts BEFORE
      // running the sanity check — so rows we can recover no longer surface as
      // failures.
      const { cash: recoveredCash, recovered: recoveredRows } = recoverCashAmounts(result.cash);
      const { transactions: cashWithSanity, failedChecks } = computeCashSanityChecks(recoveredCash);
      const analyticsCash = cashWithSanity.map(toAnalyticsShape);
      const rawTrading = analyticsCash.length
        ? (parseTradingTransactions(analyticsCash) as TradingTransaction[])
        : [];
      const trading = enrichTradingWithQuantity(rawTrading, analyticsCash);
      const pnl = trading.length ? calculatePnL(trading) : null;

      setState({
        status: "done",
        message: undefined,
        progress: undefined,
        cash: cashWithSanity,
        interest: result.interest,
        trading,
        pnl,
        failedChecks,
        recoveredRows,
        fileName: file.name,
      });
    } catch (err) {
      setState({
        ...initialState,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        fileName: file.name,
      });
    }
  }, []);

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.type === "application/pdf") {
        void handleFile(file);
      }
    },
    [handleFile],
  );

  const onFileInput = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      e.target.value = "";
    },
    [handleFile],
  );

  const baseName = state.fileName.replace(/\.pdf$/i, "") || "tr-statements";

  const exportCsv = () => {
    if (state.cash.length === 0) return;
    downloadBlob(
      `${baseName}-cash.csv`,
      buildGenericCsv(state.cash as unknown as Record<string, unknown>[]),
      "text/csv;charset=utf-8",
    );
  };
  const exportLexwareCsv = () => {
    if (state.cash.length === 0) return;
    downloadBlob(
      `${baseName}-lexware.csv`,
      buildLexwareCsv(state.cash as unknown as Record<string, unknown>[]),
      "text/csv;charset=utf-8",
    );
  };
  const exportJson = (kind: "cash" | "mmf" | "trading") => {
    const data = kind === "cash" ? state.cash : kind === "mmf" ? state.interest : state.trading;
    if (data.length === 0) return;
    downloadBlob(`${baseName}-${kind}.json`, JSON.stringify(data, null, 2), "application/json");
  };

  const handleImport = React.useCallback(async () => {
    if (state.status !== "done") return;
    setImportState({ status: "running", message: "Finding Trade Republic account…" });
    try {
      const acct = await ensureTRAccount(ctx);

      setImportState({ status: "running", message: "Preparing activities…" });
      const skipKeys = buildTradingCashKeys(state.trading);
      const activities = buildActivitiesFromParsed({
        accountId: acct.accountId,
        currency: acct.currency,
        cash: state.cash,
        trading: state.trading,
        skipCashKeys: skipKeys,
      });

      if (activities.length === 0) {
        setImportState({
          status: "error",
          message: "No importable activities found in this PDF.",
        });
        return;
      }

      setImportState({
        status: "running",
        message: `Importing ${activities.length} activities…`,
      });
      ctx.api.logger.info(`[TR PDF] Importing ${activities.length} activities`);
      const result = await ctx.api.activities.import(activities);
      const imported = result?.summary?.imported ?? 0;
      const skipped = (result?.summary?.skipped ?? 0) + (result?.summary?.duplicates ?? 0);

      setImportState({
        status: "done",
        imported,
        skipped,
        accountCreated: acct.created,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.api.logger.error(`[TR PDF] Import failed: ${message}`);
      setImportState({
        status: "error",
        message: message.length > 300 ? message.slice(0, 300) + "…" : message,
      });
    }
  }, [ctx, state.cash, state.status, state.trading]);

  const reset = () => {
    setState(initialState);
    setImportState({ status: "idle" });
    setShowOnlyFailed(false);
  };
  const progressPct =
    state.progress && state.progress.total > 0
      ? (state.progress.page / state.progress.total) * 100
      : 0;

  const tabsAvailable: Array<"cash" | "mmf" | "trading"> = [];
  if (state.cash.length > 0) tabsAvailable.push("cash");
  if (state.interest.length > 0) tabsAvailable.push("mmf");
  if (state.trading.length > 0) tabsAvailable.push("trading");

  const visibleCash = showOnlyFailed
    ? state.cash.filter((r) => r._sanityCheckOk === false)
    : state.cash;

  const tradingImportable = state.trading.filter((t) => t.quantity && t.quantity > 0).length;
  const tradingTotal = state.trading.length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      {/* ─── Header ─── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trade Republic PDF Converter</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Extract cash transactions, money market funds, and trading P&L from Trade Republic
            statements. Runs 100% locally on your device.
          </p>
        </div>
        {state.status === "done" && (
          <Button variant="outline" size="sm" onClick={reset}>
            <Icons.RefreshCw className="mr-2 h-4 w-4" />
            New PDF
          </Button>
        )}
      </div>

      {/* ─── Upload zone (idle + error) ─── */}
      {(state.status === "idle" || state.status === "error") && (
        <Card>
          <CardContent className="pt-6">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`group flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-8 py-12 transition ${
                dragOver
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-muted/40"
              }`}
            >
              <div className="bg-muted group-hover:bg-primary/10 flex h-12 w-12 items-center justify-center rounded-full transition">
                <Icons.Upload className="text-muted-foreground group-hover:text-primary h-6 w-6 transition" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">Drop a Trade Republic PDF here</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  or click to browse · no size limit · 100% local
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={onFileInput}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Parsing progress ─── */}
      {state.status === "parsing" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Icons.Spinner className="h-4 w-4 animate-spin" />
              Processing {state.fileName}
            </CardTitle>
            <CardDescription>{state.message}</CardDescription>
          </CardHeader>
          <CardContent>
            <Progress value={progressPct} className="h-2" />
            {state.progress && (
              <p className="text-muted-foreground mt-2 text-xs">
                Page {state.progress.page} of {state.progress.total}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Error ─── */}
      {state.status === "error" && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-red-900 dark:text-red-200">
              <Icons.AlertCircle className="h-4 w-4" />
              Parsing failed
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-red-800 dark:text-red-300">
            {state.message}
          </CardContent>
        </Card>
      )}

      {/* ─── Results ─── */}
      {state.status === "done" && (
        <>
          {/* Stats cards */}
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard
              label="Cash transactions"
              value={state.cash.length}
              icon={<Icons.CreditCard className="h-4 w-4" />}
            />
            <StatCard
              label="Money market funds"
              value={state.interest.length}
              icon={<Icons.BarChart className="h-4 w-4" />}
            />
            <StatCard
              label="Trades"
              value={state.trading.length}
              icon={<Icons.TrendingUp className="h-4 w-4" />}
            />
            {state.pnl ? (
              <StatCard
                label="Realized P&L"
                value={formatEur(state.pnl.totalRealized)}
                icon={<Icons.DollarSign className="h-4 w-4" />}
                tone={state.pnl.totalRealized >= 0 ? "positive" : "negative"}
              />
            ) : (
              <StatCard
                label="Realized P&L"
                value="—"
                icon={<Icons.DollarSign className="h-4 w-4" />}
              />
            )}
          </div>

          {/* ─── Direct import to Donkeyfolio ─── */}
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-base">Import to Donkeyfolio</CardTitle>
                  <CardDescription>
                    Creates (or reuses) a <strong>Trade Republic</strong> account and imports
                    activities directly — no CSV roundtrip needed.
                  </CardDescription>
                </div>
                <Button
                  onClick={handleImport}
                  disabled={importState.status === "running"}
                  size="sm"
                >
                  {importState.status === "running" ? (
                    <>
                      <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                      Importing…
                    </>
                  ) : (
                    <>
                      <Icons.Download className="mr-2 h-4 w-4" />
                      Import to Donkeyfolio
                    </>
                  )}
                </Button>
              </div>
            </CardHeader>
            {(importState.status === "running" ||
              importState.status === "done" ||
              importState.status === "error") && (
              <CardContent className="text-sm">
                {importState.status === "running" && (
                  <p className="text-muted-foreground">{importState.message}</p>
                )}
                {importState.status === "done" && (
                  <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                    <Icons.CheckCircle className="h-4 w-4 shrink-0" />
                    <span>
                      Imported <strong>{importState.imported}</strong> activities
                      {importState.skipped > 0 && ` · ${importState.skipped} skipped`}
                      {importState.accountCreated && " · account created"}
                    </span>
                  </div>
                )}
                {importState.status === "error" && (
                  <div className="flex items-start gap-2 text-red-700 dark:text-red-300">
                    <Icons.AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{importState.message}</span>
                  </div>
                )}
                {tradingTotal > tradingImportable && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    Note: {tradingTotal - tradingImportable} trade(s) lack a quantity and will be
                    skipped during import.
                  </p>
                )}
              </CardContent>
            )}
          </Card>

          {state.recoveredRows > 0 && (
            <Card className="border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30">
              <CardContent className="flex items-center gap-2 pt-4 text-sm text-blue-900 dark:text-blue-200">
                <Icons.CheckCircle className="h-4 w-4 shrink-0" />
                <span>
                  Auto-corrected <strong>{state.recoveredRows}</strong> trade row
                  {state.recoveredRows === 1 ? "" : "s"} where the PDF parser placed the amount in
                  the wrong column or dropped it — recovered from the trade direction and balance
                  delta.
                </span>
              </CardContent>
            </Card>
          )}

          {state.failedChecks > 0 && (
            <Card className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30">
              <CardContent className="flex items-center justify-between gap-2 pt-4 text-sm text-amber-900 dark:text-amber-200">
                <div className="flex items-center gap-2">
                  <Icons.AlertCircle className="h-4 w-4 shrink-0" />
                  <span>
                    <strong>{state.failedChecks}</strong> balance sanity check
                    {state.failedChecks === 1 ? "" : "s"} still failed after auto-recovery — check
                    the highlighted rows.
                  </span>
                </div>
                <Button
                  size="sm"
                  variant={showOnlyFailed ? "default" : "outline"}
                  onClick={() => setShowOnlyFailed((v) => !v)}
                >
                  {showOnlyFailed ? "Show all" : "Show only failed"}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Tabs with tables */}
          {tabsAvailable.length > 0 && (
            <Tabs defaultValue={tabsAvailable[0]} className="space-y-4">
              <TabsList>
                {tabsAvailable.includes("cash") && (
                  <TabsTrigger value="cash">
                    Cash
                    <Badge variant="secondary" className="ml-2">
                      {state.cash.length}
                    </Badge>
                  </TabsTrigger>
                )}
                {tabsAvailable.includes("mmf") && (
                  <TabsTrigger value="mmf">
                    Money Market
                    <Badge variant="secondary" className="ml-2">
                      {state.interest.length}
                    </Badge>
                  </TabsTrigger>
                )}
                {tabsAvailable.includes("trading") && (
                  <TabsTrigger value="trading">
                    Trading P&L
                    <Badge variant="secondary" className="ml-2">
                      {state.trading.length}
                    </Badge>
                    <Badge variant="outline" className="ml-2 text-[10px] uppercase">
                      Beta
                    </Badge>
                  </TabsTrigger>
                )}
              </TabsList>

              {tabsAvailable.includes("cash") && (
                <TabsContent value="cash" className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={exportCsv}>
                      <Icons.Download className="mr-2 h-4 w-4" />
                      Export CSV
                    </Button>
                    <Button size="sm" variant="outline" onClick={exportLexwareCsv}>
                      Lexware CSV
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => exportJson("cash")}>
                      JSON
                    </Button>
                    {state.failedChecks > 0 && (
                      <Button
                        size="sm"
                        variant={showOnlyFailed ? "default" : "outline"}
                        onClick={() => setShowOnlyFailed((v) => !v)}
                      >
                        {showOnlyFailed
                          ? `Showing ${state.failedChecks} failed`
                          : "Only failed sanity checks"}
                      </Button>
                    )}
                  </div>
                  <CashTable rows={visibleCash} />
                </TabsContent>
              )}

              {tabsAvailable.includes("mmf") && (
                <TabsContent value="mmf" className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => exportJson("mmf")}>
                      <Icons.Download className="mr-2 h-4 w-4" />
                      Export JSON
                    </Button>
                  </div>
                  <InterestTable rows={state.interest} />
                </TabsContent>
              )}

              {tabsAvailable.includes("trading") && state.pnl && (
                <TabsContent value="trading" className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => exportJson("trading")}>
                      <Icons.Download className="mr-2 h-4 w-4" />
                      Export JSON
                    </Button>
                  </div>
                  <TradingTable pnl={state.pnl} trades={state.trading} />
                </TabsContent>
              )}
            </Tabs>
          )}
        </>
      )}

      {/* ─── Footer credit ─── */}
      <div className="text-muted-foreground border-t pt-4 text-xs">
        Built on{" "}
        <a
          href="https://kontoauszug.jonathanpagel.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground underline"
        >
          kontoauszug.jonathanpagel.com
        </a>{" "}
        by{" "}
        <a
          href="https://github.com/jcmpagel/Trade-Republic-CSV-Excel"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground underline"
        >
          @jcmpagel
        </a>{" "}
        — parser logic vendored with attribution. React UI ported for Donkeyfolio.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  tone?: "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? "text-green-600 dark:text-green-400"
      : tone === "negative"
        ? "text-red-600 dark:text-red-400"
        : "";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-muted-foreground flex items-center justify-between text-xs font-medium">
          <span>{label}</span>
          {icon}
        </div>
        <div className={`mt-2 text-2xl font-bold ${toneClass}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function CashTable({ rows }: { rows: CashTransaction[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground pt-6 text-center text-sm">
          No rows to show with the current filter.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">In</TableHead>
              <TableHead className="text-right">Out</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow
                key={i}
                className={
                  r._sanityCheckOk === false
                    ? "bg-amber-50 dark:bg-amber-950/30"
                    : r._recovered
                      ? "bg-blue-50/60 dark:bg-blue-950/20"
                      : undefined
                }
                title={
                  r._sanityCheckOk === false
                    ? "Balance sanity check failed"
                    : r._recovered === "swapped"
                      ? "Auto-corrected: amount was in the wrong column"
                      : r._recovered === "filled-from-balance"
                        ? "Auto-corrected: amount recovered from balance delta"
                        : undefined
                }
              >
                <TableCell className="font-mono text-xs">{r.datum}</TableCell>
                <TableCell>{translateType(r.typ)}</TableCell>
                <TableCell className="max-w-md truncate" title={r.beschreibung}>
                  {r.beschreibung}
                </TableCell>
                <TableCell className="text-right font-mono text-green-600 dark:text-green-400">
                  {r.zahlungseingang || ""}
                </TableCell>
                <TableCell className="text-right font-mono text-red-600 dark:text-red-400">
                  {r.zahlungsausgang || ""}
                </TableCell>
                <TableCell className="text-right font-mono">{r.saldo}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function InterestTable({ rows }: { rows: InterestTransaction[] }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Fund</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell className="font-mono text-xs">{r.datum}</TableCell>
                <TableCell>{translateType(r.zahlungsart)}</TableCell>
                <TableCell className="max-w-md truncate" title={r.geldmarktfonds}>
                  {r.geldmarktfonds}
                </TableCell>
                <TableCell className="text-right font-mono">{r.stueck}</TableCell>
                <TableCell className="text-right font-mono">{r.kurs}</TableCell>
                <TableCell className="text-right font-mono">{r.betrag}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function TradingTable({ pnl, trades }: { pnl: PnLResult; trades: TradingTransaction[] }) {
  // Aggregate quantity/unitPrice per ISIN from enriched trades
  const qtyByIsin = React.useMemo(() => {
    const map = new Map<string, { totalQty: number; count: number; name: string }>();
    for (const t of trades) {
      if (!t.isin) continue;
      const entry = map.get(t.isin) || {
        totalQty: 0,
        count: 0,
        name: t.cleanStockName || t.stockName,
      };
      if (t.quantity) entry.totalQty += t.isBuy ? t.quantity : -t.quantity;
      entry.count += 1;
      // Prefer the cleanest name we have
      if (!entry.name && t.cleanStockName) entry.name = t.cleanStockName;
      map.set(t.isin, entry);
    }
    return map;
  }, [trades]);

  return (
    <Card>
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stock</TableHead>
              <TableHead>ISIN</TableHead>
              <TableHead className="text-right">Net qty</TableHead>
              <TableHead className="text-right">Bought</TableHead>
              <TableHead className="text-right">Sold</TableHead>
              <TableHead className="text-right">Realized P&L</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pnl.pnlSummary.map((p) => {
              const agg = qtyByIsin.get(p.isin);
              const displayName = agg?.name || p.stockName;
              return (
                <TableRow key={p.isin}>
                  <TableCell className="max-w-xs truncate" title={displayName}>
                    {displayName}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.isin}</TableCell>
                  <TableCell className="text-right font-mono">{formatQty(agg?.totalQty)}</TableCell>
                  <TableCell className="text-right font-mono">{formatEur(p.totalBought)}</TableCell>
                  <TableCell className="text-right font-mono">{formatEur(p.totalSold)}</TableCell>
                  <TableCell
                    className={`text-right font-mono font-medium ${
                      p.realizedGainLoss >= 0
                        ? "text-green-600 dark:text-green-400"
                        : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {formatEur(p.realizedGainLoss)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.isOpen ? "outline" : "secondary"} className="text-xs">
                      {translateStatus(p.statusIcon)}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
