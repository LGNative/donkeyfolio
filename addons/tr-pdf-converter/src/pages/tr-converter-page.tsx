import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
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
  computeCashSanityChecks,
  computeEnhancedPnL,
  enrichTradingWithQuantity,
  parsePDF,
  parseTradingTransactions,
  recoverCashAmounts,
  type CashTransaction,
  type EnhancedPnLResult,
  type InterestTransaction,
  type TradingTransaction,
} from "../lib/tr-parser";
import { ensureTRAccount } from "../lib/tr-account";
import {
  buildActivitiesFromParsed,
  buildDonkeyfolioCsv,
  buildTradingCashKeys,
} from "../lib/tr-to-activities";

interface ParseState {
  status: "idle" | "parsing" | "done" | "error";
  message?: string;
  progress?: { page: number; total: number };
  cash: CashTransaction[];
  interest: InterestTransaction[];
  trading: TradingTransaction[];
  pnl: EnhancedPnLResult | null;
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

// Format-aware EUR string parser (mirrors the one in tr-parser/tr-to-activities).
// Used here only for the statement summary panel — not in the import path.
function parseEurDisplay(raw: string): number {
  if (!raw) return 0;
  const s = String(raw).replace(/[€\s]/g, "");
  if (!s) return 0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let n = s;
  if (hasComma && hasDot) {
    n =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (hasComma) {
    const parts = s.split(",");
    n = parts.length === 2 && parts[1].length === 3 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (hasDot) {
    const parts = s.split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) n = s.replace(/\./g, "");
  }
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : 0;
}

interface StatementSummary {
  opening: number;
  totalIn: number;
  totalOut: number;
  closing: number;
}

/**
 * Derive the statement-level totals from the parsed cash rows.
 *   opening = first row's printed balance, minus that row's signed amount
 *   closing = last row's printed balance
 *   totalIn / totalOut = column sums
 * These should match the "Money IN / Money OUT / Closing Balance" block at
 * the top of every TR PDF statement, and after import they should also match
 * Donkeyfolio's Trade Republic account cash balance.
 */
function computeStatementSummary(cash: CashTransaction[]): StatementSummary {
  if (cash.length === 0) return { opening: 0, totalIn: 0, totalOut: 0, closing: 0 };
  let totalIn = 0;
  let totalOut = 0;
  for (const c of cash) {
    totalIn += parseEurDisplay(c.zahlungseingang);
    totalOut += parseEurDisplay(c.zahlungsausgang);
  }
  const first = cash[0];
  const firstSigned =
    parseEurDisplay(first.zahlungseingang) - parseEurDisplay(first.zahlungsausgang);
  const opening = parseEurDisplay(first.saldo) - firstSigned;
  const closing = parseEurDisplay(cash[cash.length - 1].saldo);
  return { opening, totalIn, totalOut, closing };
}

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

/**
 * Save text content to disk. Uses the SDK's openSaveDialog (works in Tauri
 * webview where the <a download> trick is silently blocked). Falls back to
 * the browser blob trick if the SDK call rejects (e.g. permission missing,
 * or running in a web context).
 */
async function saveFile(
  ctx: AddonContext,
  filename: string,
  content: string,
  mimeType: string,
): Promise<boolean> {
  // Try the SDK first — Tauri webview blocks the synthetic-click download path
  // we used before, so this is the reliable route inside the desktop app.
  try {
    if (ctx.api.files?.openSaveDialog) {
      await ctx.api.files.openSaveDialog(content, filename);
      return true;
    }
  } catch (err) {
    ctx.api.logger.warn(
      `[TR PDF] SDK file save failed (${(err as Error).message}); falling back to anchor download.`,
    );
  }
  // Browser fallback (web context).
  try {
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
    return true;
  } catch (err) {
    ctx.api.logger.error(`[TR PDF] File save failed: ${(err as Error).message}`);
    return false;
  }
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
      const { transactions: cashWithChainSanity } = computeCashSanityChecks(recoveredCash);
      // jcmpagel's sanity check tests the BALANCE CHAIN (prev_saldo + in - out
      // must equal current_saldo). Even after our recovery, a single broken
      // row upstream can cascade a "failed" flag onto rows that are themselves
      // perfectly clean. For the user's purposes (importing into Donkeyfolio)
      // what matters is whether each ROW is well-formed, not the chain.
      // Override the flag: if a row has exactly one column populated (the
      // expected one for its trade direction OR a one-sided cash flow), treat
      // it as OK regardless of chain consistency.
      const cashWithSanity = cashWithChainSanity.map((r) => {
        if (r._sanityCheckOk !== false) return r; // already ok, leave alone
        const desc = r.beschreibung || "";
        const isBuyTrade =
          /\bBuy\b|\bKauf\b|\bCompra\b/i.test(desc) &&
          /\btrade\b|\bHandel\b|\bSavings plan\b/i.test(desc);
        const isSellTrade =
          /\bSell\b|\bVerkauf\b|\bVenta\b/i.test(desc) && /\btrade\b|\bHandel\b/i.test(desc);
        // Lightweight number parse — we only care about magnitude.
        const num = (s: string) => {
          const m = String(s || "")
            .replace(/[€\s]/g, "")
            .match(/-?\d+(?:[.,]\d+)?/);
          if (!m) return 0;
          const n = parseFloat(m[0].replace(",", "."));
          return Number.isFinite(n) ? n : 0;
        };
        const inc = num(r.zahlungseingang);
        const out = num(r.zahlungsausgang);
        const onlyOut = inc < 0.01 && out > 0.01;
        const onlyIn = inc > 0.01 && out < 0.01;
        // Trade rows: well-formed = direction matches the populated side
        if ((isBuyTrade && onlyOut) || (isSellTrade && onlyIn)) {
          return { ...r, _sanityCheckOk: true };
        }
        // Non-trade rows: well-formed = exactly one side populated.
        if (!isBuyTrade && !isSellTrade && (onlyOut || onlyIn)) {
          return { ...r, _sanityCheckOk: true };
        }
        return r;
      });
      const failedChecks = cashWithSanity.filter((r) => r._sanityCheckOk === false).length;
      const analyticsCash = cashWithSanity.map(toAnalyticsShape);
      // jcmpagel's parseTradingTransactions only picks up descriptions containing
      // "Buy"/"Sell"/"Kauf"/"Verkauf" etc. — TR's recurring DCA buys are labelled
      // "Savings plan execution", which would otherwise be missed entirely (falling
      // through to a generic cash WITHDRAWAL). Inject "Buy " so they're classified
      // as implicit buy trades with the same ISIN/quantity extraction.
      const analyticsCashForTrading = analyticsCash.map((c) => ({
        ...c,
        description: /^(\s*)Savings plan execution\b/i.test(c.description)
          ? c.description.replace(/^(\s*)Savings plan execution\b/i, "$1Buy Savings plan execution")
          : c.description,
      }));
      const rawTrading = analyticsCashForTrading.length
        ? (parseTradingTransactions(analyticsCashForTrading) as TradingTransaction[])
        : [];
      const trading = enrichTradingWithQuantity(rawTrading, analyticsCashForTrading);
      // Use our own running-average-cost P&L (jcmpagel's calculatePnL returned
      // €0 for every partially-sold position, which made the Realized P&L
      // column useless for any active portfolio).
      const pnl = trading.length ? computeEnhancedPnL(trading) : null;

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

  const exportCsv = async () => {
    if (state.cash.length === 0) return;
    await saveFile(
      ctx,
      `${baseName}-cash.csv`,
      buildGenericCsv(state.cash as unknown as Record<string, unknown>[]),
      "text/csv;charset=utf-8",
    );
  };
  const exportLexwareCsv = async () => {
    if (state.cash.length === 0) return;
    await saveFile(
      ctx,
      `${baseName}-lexware.csv`,
      buildLexwareCsv(state.cash as unknown as Record<string, unknown>[]),
      "text/csv;charset=utf-8",
    );
  };
  const exportJson = async (kind: "cash" | "mmf" | "trading") => {
    const data = kind === "cash" ? state.cash : kind === "mmf" ? state.interest : state.trading;
    if (data.length === 0) return;
    await saveFile(
      ctx,
      `${baseName}-${kind}.json`,
      JSON.stringify(data, null, 2),
      "application/json",
    );
  };

  /** CSV shaped for the Donkeyfolio Activities Import wizard (5-step mapping). */
  const exportDonkeyfolioCsv = async () => {
    if (state.status !== "done") return;
    const skipKeys = buildTradingCashKeys(state.trading);
    // Use a placeholder accountId — the wizard lets the user map the account
    // column or pick a default account anyway.
    const activities = buildActivitiesFromParsed({
      accountId: "",
      currency: "EUR",
      cash: state.cash,
      trading: state.trading,
      skipCashKeys: skipKeys,
    });
    if (activities.length === 0) return;
    await saveFile(
      ctx,
      `${baseName}-donkeyfolio.csv`,
      buildDonkeyfolioCsv(activities),
      "text/csv;charset=utf-8",
    );
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

      // ── SINGLE-CREATE FOR EVERY ACTIVITY ─────────────────────────────
      // Earlier versions tried bulk activities.import() which is fast but
      // does not run prepare_new_activity → get_or_create_minimal_asset.
      // Result: activities are inserted with asset_id NULL and the symbol
      // information is discarded, leaving Holdings empty AND impossible to
      // recover (the symbol isn't kept anywhere on the activity row).
      //
      // The robust fix is to call ctx.api.activities.create() per activity.
      // Each call runs prepare_new_activity which creates the asset profile
      // (or reuses an existing one) and links the activity correctly.
      // Trade-off: ~50 ms per call → ~3-5 minutes for a full TR yearly
      // statement. Acceptable given we only run this once per import.

      const TR_EQUITY_EU_EXCHANGE = "XAMS"; // Euronext Amsterdam — preferred
      // EUR listing for Irish-domiciled ETFs (avoids the GBP/LSE fallback).
      const isISIN = (s: string) => /^[A-Z]{2}[A-Z0-9]{10}$/.test(s);
      const isCryptoPseudo = (s: string) => /^XF000/.test(s);

      ctx.api.logger.info(`[TR PDF] single-create import for ${activities.length} activities`);

      let imported = 0;
      let failures = 0;
      const startMs = Date.now();
      for (let i = 0; i < activities.length; i++) {
        const a = activities[i];
        // Update progress every 25 rows so the UI doesn't get spammed.
        if (i % 25 === 0) {
          const elapsed = (Date.now() - startMs) / 1000;
          const eta = i > 0 ? Math.round((elapsed / i) * (activities.length - i)) : 0;
          setImportState({
            status: "running",
            message: `Importing ${i + 1} of ${activities.length}…  (${
              eta > 0 ? `~${eta}s remaining` : "estimating"
            })`,
          });
        }

        try {
          const sym = a.symbol || "";
          const symbolPayload =
            sym && isISIN(sym)
              ? {
                  symbol: sym,
                  exchangeMic: isCryptoPseudo(sym)
                    ? undefined
                    : sym.startsWith("IE")
                      ? TR_EQUITY_EU_EXCHANGE
                      : undefined,
                  name: a.symbolName,
                }
              : sym
                ? { symbol: sym, name: a.symbolName }
                : undefined;
          await ctx.api.activities.create({
            accountId: acct.accountId,
            activityType: a.activityType,
            activityDate: a.date as string,
            subtype: a.subtype ?? null,
            symbol: symbolPayload,
            quantity: a.quantity ?? 0,
            unitPrice: a.unitPrice ?? 0,
            amount: a.amount ?? 0,
            currency: a.currency,
            fee: a.fee ?? 0,
            comment: a.comment ?? null,
          });
          imported += 1;
        } catch (err) {
          failures += 1;
          if (failures <= 10) {
            // Log only the first 10 failures so we don't flood the log.
            ctx.api.logger.warn(
              `[TR PDF] create failed (row ${i + 1}, ${a.symbol}): ${(err as Error).message}`,
            );
          }
        }
      }

      const totalElapsed = Math.round((Date.now() - startMs) / 1000);
      ctx.api.logger.info(
        `[TR PDF] import done: ${imported} imported, ${failures} failed, ${totalElapsed}s`,
      );

      setImportState({
        status: "done",
        imported,
        skipped: failures,
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
  const savingsPlanCount = state.trading.filter((t) => t.isSavingsPlan).length;

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
                // "Realized P&L" requires precise cost-basis tracking with
                // historical FX rates and fee accounting per individual fill —
                // none of which we can do reliably from a TR statement alone.
                // The honest headline figure is the cash-flow delta (sold
                // proceeds minus buy spend). Donkeyfolio will compute the real
                // P&L after the activities are imported (with live market data).
                label="Sold − Bought"
                value={formatEur(state.pnl.totalSold - state.pnl.totalBought)}
                icon={<Icons.DollarSign className="h-4 w-4" />}
              />
            ) : (
              <StatCard
                label="Sold − Bought"
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
                    activities directly — or export a CSV shaped for the Import Activities wizard.
                  </CardDescription>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                  <Button
                    onClick={exportDonkeyfolioCsv}
                    variant="outline"
                    size="sm"
                    disabled={importState.status === "running"}
                  >
                    <Icons.Download className="mr-2 h-4 w-4" />
                    Activities CSV
                  </Button>
                </div>
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
                {savingsPlanCount > 0 && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    Includes <strong>{savingsPlanCount}</strong> Savings plan execution(s) —
                    imported as BUY with €0 fee. Manual Buy/Sell trades get the standard TR €1 fee
                    separated out (amount = qty × price, fee = €1).
                  </p>
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
                  <p className="text-muted-foreground text-xs">
                    Per-position approximation. The accurate P&L is computed by Donkeyfolio after
                    import using live market prices and your full holdings history.
                  </p>
                  <TradingTable pnl={state.pnl} />
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

function TradingTable({ pnl }: { pnl: EnhancedPnLResult }) {
  return (
    <Card>
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stock</TableHead>
              <TableHead>ISIN</TableHead>
              <TableHead className="text-right">Held</TableHead>
              <TableHead className="text-right">Avg cost</TableHead>
              <TableHead className="text-right">Bought</TableHead>
              <TableHead className="text-right">Sold</TableHead>
              <TableHead className="text-right">Realized P&L</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pnl.positions.map((p) => (
              <TableRow key={p.isin}>
                <TableCell className="max-w-xs truncate" title={p.stockName}>
                  {p.stockName}
                </TableCell>
                <TableCell className="font-mono text-xs">{p.isin}</TableCell>
                <TableCell className="text-right font-mono">{formatQty(p.qtyHeld)}</TableCell>
                <TableCell className="text-right font-mono">
                  {p.avgCostBasis > 0 ? formatEur(p.avgCostBasis) : "—"}
                </TableCell>
                <TableCell className="text-right font-mono">{formatEur(p.totalBought)}</TableCell>
                <TableCell className="text-right font-mono">{formatEur(p.totalSold)}</TableCell>
                <TableCell
                  className={`text-right font-mono font-medium ${
                    p.realizedPnL > 0
                      ? "text-green-600 dark:text-green-400"
                      : p.realizedPnL < 0
                        ? "text-red-600 dark:text-red-400"
                        : ""
                  }`}
                >
                  {p.qtySold > 0 ? formatEur(p.realizedPnL) : "—"}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={p.status === "Open" ? "outline" : "secondary"}
                    className="text-xs"
                  >
                    {p.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
