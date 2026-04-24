import { Button, Icons } from "@wealthfolio/ui";
import React from "react";

import {
  buildGenericCsv,
  buildLexwareCsv,
  calculatePnL,
  computeCashSanityChecks,
  parsePDF,
  parseTradingTransactions,
  type CashTransaction,
  type InterestTransaction,
  type PnLResult,
  type TradingTransaction,
} from "../lib/tr-parser";

type Tab = "cash" | "mmf" | "trading";

interface ParseState {
  status: "idle" | "parsing" | "done" | "error";
  message?: string;
  progress?: { page: number; total: number };
  cash: CashTransaction[];
  interest: InterestTransaction[];
  trading: TradingTransaction[];
  pnl: PnLResult | null;
  failedChecks: number;
  fileName: string;
}

const initialState: ParseState = {
  status: "idle",
  cash: [],
  interest: [],
  trading: [],
  pnl: null,
  failedChecks: 0,
  fileName: "",
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

export default function TrConverterPage() {
  const [state, setState] = React.useState<ParseState>(initialState);
  const [tab, setTab] = React.useState<Tab>("cash");
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);

  const handleFile = React.useCallback(async (file: File) => {
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
          message: `Parsing page ${page}/${total}`,
        }));
      });

      const { transactions: cashWithSanity, failedChecks } = computeCashSanityChecks(result.cash);
      const analyticsCash = cashWithSanity.map(toAnalyticsShape);
      const trading = analyticsCash.length
        ? (parseTradingTransactions(analyticsCash) as TradingTransaction[])
        : [];
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
      e.target.value = ""; // allow re-selecting same file
    },
    [handleFile],
  );

  const exportCsv = () => {
    if (state.cash.length === 0) return;
    const csv = buildGenericCsv(state.cash as unknown as Record<string, unknown>[]);
    downloadBlob(
      `${state.fileName.replace(/\.pdf$/i, "")}-cash.csv`,
      csv,
      "text/csv;charset=utf-8",
    );
  };

  const exportLexwareCsv = () => {
    if (state.cash.length === 0) return;
    const csv = buildLexwareCsv(state.cash as unknown as Record<string, unknown>[]);
    downloadBlob(
      `${state.fileName.replace(/\.pdf$/i, "")}-lexware.csv`,
      csv,
      "text/csv;charset=utf-8",
    );
  };

  const exportJson = () => {
    const data = tab === "cash" ? state.cash : tab === "mmf" ? state.interest : state.trading;
    if (data.length === 0) return;
    downloadBlob(
      `${state.fileName.replace(/\.pdf$/i, "")}-${tab}.json`,
      JSON.stringify(data, null, 2),
      "application/json",
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Trade Republic PDF Converter</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Extract cash transactions, money market funds, and trading P&L from Trade Republic PDF
          statements. Runs 100% locally.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 transition-colors ${
          dragOver
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50"
        }`}
      >
        <Icons.Upload className="text-muted-foreground h-8 w-8" />
        <p className="text-sm font-medium">Drop a Trade Republic PDF here or click to browse</p>
        <p className="text-muted-foreground text-xs">PDF only · no size limit · 100% local</p>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={onFileInput}
        />
      </div>

      {/* Status */}
      {state.status === "parsing" && (
        <div className="bg-muted flex items-center gap-3 rounded-md px-4 py-3 text-sm">
          <Icons.Spinner className="h-4 w-4 animate-spin" />
          <span>{state.message}</span>
          {state.progress && (
            <span className="text-muted-foreground">
              {state.progress.page}/{state.progress.total}
            </span>
          )}
        </div>
      )}
      {state.status === "error" && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <strong>Error:</strong> {state.message}
        </div>
      )}

      {/* Results */}
      {state.status === "done" && (
        <>
          <div className="bg-card rounded-md border px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <span className="text-muted-foreground">Cash:</span>{" "}
                <strong>{state.cash.length}</strong>
              </div>
              <div>
                <span className="text-muted-foreground">Money market funds:</span>{" "}
                <strong>{state.interest.length}</strong>
              </div>
              <div>
                <span className="text-muted-foreground">Trades:</span>{" "}
                <strong>{state.trading.length}</strong>
              </div>
              {state.pnl && (
                <div>
                  <span className="text-muted-foreground">Realized P&L:</span>{" "}
                  <strong
                    className={state.pnl.totalRealized >= 0 ? "text-green-600" : "text-red-600"}
                  >
                    {state.pnl.totalRealized.toLocaleString("en-US", {
                      style: "currency",
                      currency: "EUR",
                    })}
                  </strong>
                </div>
              )}
              {state.failedChecks > 0 && (
                <div className="text-amber-700 dark:text-amber-400">
                  ⚠️ {state.failedChecks} sanity check(s) failed
                </div>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-2 border-b">
            {(["cash", "mmf", "trading"] as Tab[]).map((t) => {
              const count =
                t === "cash"
                  ? state.cash.length
                  : t === "mmf"
                    ? state.interest.length
                    : state.trading.length;
              if (count === 0) return null;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-2 text-sm font-medium transition-colors ${
                    tab === t
                      ? "border-primary text-foreground border-b-2"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t === "cash" ? "Cash" : t === "mmf" ? "Money Market Funds" : "Trading P&L"} (
                  {count})
                </button>
              );
            })}
          </div>

          {/* Action bar */}
          <div className="flex flex-wrap items-center gap-2">
            {tab === "cash" && (
              <>
                <Button onClick={exportCsv} size="sm">
                  <Icons.Download className="mr-2 h-4 w-4" />
                  Export CSV
                </Button>
                <Button onClick={exportLexwareCsv} size="sm" variant="outline">
                  Lexware CSV
                </Button>
              </>
            )}
            <Button onClick={exportJson} size="sm" variant="outline">
              <Icons.Download className="mr-2 h-4 w-4" />
              Export JSON
            </Button>
          </div>

          {/* Tables */}
          {tab === "cash" && <CashTable rows={state.cash} />}
          {tab === "mmf" && <InterestTable rows={state.interest} />}
          {tab === "trading" && state.pnl && <TradingTable pnl={state.pnl} />}
        </>
      )}

      {/* Credit footer */}
      <div className="text-muted-foreground mt-auto pt-4 text-xs">
        Built on{" "}
        <a
          href="https://kontoauszug.jonathanpagel.com"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:no-underline"
        >
          kontoauszug.jonathanpagel.com
        </a>{" "}
        by{" "}
        <a
          href="https://github.com/jcmpagel/Trade-Republic-CSV-Excel"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:no-underline"
        >
          @jcmpagel
        </a>{" "}
        (parser logic). Native React port for Donkeyfolio.
      </div>
    </div>
  );
}

function CashTable({ rows }: { rows: CashTransaction[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs uppercase">
          <tr>
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Description</th>
            <th className="px-3 py-2 text-right">In</th>
            <th className="px-3 py-2 text-right">Out</th>
            <th className="px-3 py-2 text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className={`border-t ${r._sanityCheckOk === false ? "bg-amber-50 dark:bg-amber-950/30" : ""}`}
              title={r._sanityCheckOk === false ? "Balance sanity check failed" : undefined}
            >
              <td className="px-3 py-2">{r.datum}</td>
              <td className="px-3 py-2">{r.typ}</td>
              <td className="max-w-md truncate px-3 py-2" title={r.beschreibung}>
                {r.beschreibung}
              </td>
              <td className="px-3 py-2 text-right text-green-600">{r.zahlungseingang}</td>
              <td className="px-3 py-2 text-right text-red-600">{r.zahlungsausgang}</td>
              <td className="px-3 py-2 text-right font-mono">{r.saldo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InterestTable({ rows }: { rows: InterestTransaction[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs uppercase">
          <tr>
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Fund</th>
            <th className="px-3 py-2 text-right">Quantity</th>
            <th className="px-3 py-2 text-right">Price</th>
            <th className="px-3 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t">
              <td className="px-3 py-2">{r.datum}</td>
              <td className="px-3 py-2">{r.zahlungsart}</td>
              <td className="max-w-md truncate px-3 py-2" title={r.geldmarktfonds}>
                {r.geldmarktfonds}
              </td>
              <td className="px-3 py-2 text-right font-mono">{r.stueck}</td>
              <td className="px-3 py-2 text-right font-mono">{r.kurs}</td>
              <td className="px-3 py-2 text-right font-mono">{r.betrag}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradingTable({ pnl }: { pnl: PnLResult }) {
  const fmt = (v: number) =>
    v.toLocaleString("en-US", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs uppercase">
          <tr>
            <th className="px-3 py-2 text-left">Stock</th>
            <th className="px-3 py-2 text-left">ISIN</th>
            <th className="px-3 py-2 text-right">Bought</th>
            <th className="px-3 py-2 text-right">Sold</th>
            <th className="px-3 py-2 text-right">Cost Basis</th>
            <th className="px-3 py-2 text-right">Realized P&L</th>
            <th className="px-3 py-2 text-left">Status</th>
          </tr>
        </thead>
        <tbody>
          {pnl.pnlSummary.map((p) => (
            <tr key={p.isin} className="border-t">
              <td className="max-w-xs truncate px-3 py-2" title={p.stockName}>
                {p.stockName}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{p.isin}</td>
              <td className="px-3 py-2 text-right">{fmt(p.totalBought)}</td>
              <td className="px-3 py-2 text-right">{fmt(p.totalSold)}</td>
              <td className="px-3 py-2 text-right">{fmt(p.costBasis)}</td>
              <td
                className={`px-3 py-2 text-right font-medium ${
                  p.realizedGainLoss >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {fmt(p.realizedGainLoss)}
              </td>
              <td className="text-muted-foreground px-3 py-2 text-xs">{p.statusIcon}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
