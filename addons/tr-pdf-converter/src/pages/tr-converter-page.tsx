import type { Account, ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
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
  enforceChainConsistency,
  enrichTradingWithQuantity,
  mergeContinuationRows,
  parsePDF,
  parseTradingTransactions,
  recoverCashAmounts,
  type CashTransaction,
  type EnhancedPnLResult,
  type InterestTransaction,
  type StatementSummary,
  type TradingTransaction,
} from "../lib/tr-parser";
import { ensureTRAccount } from "../lib/tr-account";
import { analyzeSecurities, lookupTicker, type SecurityAnalysis } from "../lib/tr-isin-tickers";
import {
  buildActivitiesFromParsed,
  buildDonkeyfolioCsv,
  buildTradingCashKeys,
} from "../lib/tr-to-activities";
import { detectSplitsForPositions, type SplitEvent } from "../lib/tr-splits";
import { buildReconciliation, type ReconcileResult } from "../lib/tr-reconcile";

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
  /** Page-1 SUMMARY block — authoritative period totals from TR. */
  summary: StatementSummary | null;
}

type ImportState =
  | { status: "idle" }
  | { status: "running"; message: string }
  | {
      status: "done";
      imported: number;
      skipped: number;
      accountCreated: boolean;
      /** Up to 3 sample failure messages, shown when skipped > 0 so the user
       * can diagnose which assets failed (e.g. "Quote currency required"). */
      failureExamples?: string[];
    }
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
  summary: null,
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

  // Account selection. We load all accounts on mount so the user can pick the
  // target account explicitly (better than always auto-creating one — lets
  // users reuse an existing TR account, and avoids the "needs setup" state if
  // they had created one manually with the wrong trackingMode). The fallback
  // path remains: a "Create Trade Republic account" button if nothing fits.
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [accountsLoaded, setAccountsLoaded] = React.useState(false);
  const [selectedAccountId, setSelectedAccountId] = React.useState<string>("");
  const [creatingAccount, setCreatingAccount] = React.useState(false);

  // Split detection (Yahoo Finance). Opt-in: the network round-trip can take
  // ~1 minute on large portfolios, so we only run it when the user clicks
  // "Check for splits". Results live in component state until reset.
  const [splitState, setSplitState] = React.useState<
    | { status: "idle" }
    | { status: "running"; checked: number; total: number }
    | { status: "done"; splits: SplitEvent[]; checked: number; errors: number; skipped: number }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const loadAccounts = React.useCallback(async () => {
    try {
      const all = await ctx.api.accounts.getAll();
      // Prefer active, non-archived accounts; SECURITIES first.
      const sorted = [...all]
        .filter((a) => a.isActive && !a.isArchived)
        .sort((a, b) => {
          if (a.accountType === "SECURITIES" && b.accountType !== "SECURITIES") return -1;
          if (b.accountType === "SECURITIES" && a.accountType !== "SECURITIES") return 1;
          return a.name.localeCompare(b.name);
        });
      setAccounts(sorted);
      // Default selection: an existing "Trade Republic" account if present.
      const trMatch = sorted.find((a) => a.name.trim().toLowerCase() === "trade republic");
      if (trMatch) {
        setSelectedAccountId(trMatch.id);
      } else if (sorted.length > 0) {
        // No TR account → leave unselected so the user has to opt in.
        setSelectedAccountId("");
      }
    } catch (err) {
      ctx.api.logger.warn(`[TR PDF] failed to load accounts: ${(err as Error).message}`);
    } finally {
      setAccountsLoaded(true);
    }
  }, [ctx]);

  React.useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const handleCreateTRAccount = React.useCallback(async () => {
    setCreatingAccount(true);
    try {
      const acct = await ensureTRAccount(ctx);
      await loadAccounts();
      setSelectedAccountId(acct.accountId);
    } catch (err) {
      ctx.api.logger.error(`[TR PDF] Failed to create TR account: ${(err as Error).message}`);
    } finally {
      setCreatingAccount(false);
    }
  }, [ctx, loadAccounts]);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  const handleCheckSplits = React.useCallback(async () => {
    if (state.status !== "done" || state.trading.length === 0) return;
    setSplitState({ status: "running", checked: 0, total: 0 });
    try {
      const result = await detectSplitsForPositions(state.trading, (checked, total) => {
        setSplitState({ status: "running", checked, total });
      });
      setSplitState({
        status: "done",
        splits: result.splits,
        checked: result.checked,
        errors: result.errors,
        skipped: result.skipped,
      });
      ctx.api.logger.info(
        `[TR PDF] split check: ${result.splits.length} splits found across ${result.checked} positions (${result.errors} errors, ${result.skipped} skipped).`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.api.logger.error(`[TR PDF] split check failed: ${message}`);
      setSplitState({ status: "error", message });
    }
  }, [ctx, state.status, state.trading]);

  const handleFile = React.useCallback(async (file: File) => {
    setImportState({ status: "idle" });
    setShowOnlyFailed(false);
    setSplitState({ status: "idle" });
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

      // (v2.7.8) Merge continuation rows BEFORE everything else. Some TR PDF
      // rows split the "quantity: X" fragment onto a separate visual line;
      // pdf.js then emits it as an orphan cash row with no amount/saldo. We
      // merge those fragments back into the previous transaction's
      // beschreibung so the QTY_LABEL_RE in enrichTradingWithQuantity can
      // pick them up.
      const { cash: mergedCash, merged: mergedRows } = mergeContinuationRows(result.cash);

      // Auto-recover trade rows with column-swapped or missing amounts BEFORE
      // running the sanity check — so rows we can recover no longer surface as
      // failures.
      const { cash: recoveredCash, recovered: recoveredRows } = recoverCashAmounts(mergedCash);

      // (v2.7.4) Enforce row-level chain consistency: for each row, if the
      // parsed In/Out doesn't match the saldo delta, rewrite In/Out to match
      // the chain. This is the structural fix for "phantom OUT" drift caused
      // by column-boundary misclassification on rows with weird layout (e.g.
      // multi-line Card Transactions, very large saldos that overflow).
      //
      // Anchor uses the PDF SUMMARY's openingBalance when available — that's
      // the only authoritative source for what the chain should start at.
      const summaryOpening = result.summary
        ? parseEurDisplay(result.summary.openingBalance)
        : undefined;
      const { cash: chainConsistentCash, corrected: chainCorrected } = enforceChainConsistency(
        recoveredCash,
        summaryOpening,
      );
      const { transactions: cashWithChainSanity } = computeCashSanityChecks(chainConsistentCash);
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
        // Roll the chain-consistency corrections into the visible "auto-
        // corrected rows" counter — both are forms of post-parse repair.
        // Visible "auto-corrected rows" counter rolls together all three
        // post-parse repairs: PDF column-swap recoveries, saldo-chain
        // re-writes, and continuation-row merges (v2.7.8).
        recoveredRows: recoveredRows + chainCorrected + mergedRows,
        fileName: file.name,
        summary: result.summary ?? null,
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
    if (!selectedAccountId) {
      setImportState({
        status: "error",
        message: "Pick a target account first (or use 'Create Trade Republic account' below).",
      });
      return;
    }
    const acct = accounts.find((a) => a.id === selectedAccountId);
    if (!acct) {
      setImportState({ status: "error", message: "Selected account not found." });
      return;
    }
    if (acct.trackingMode !== "TRANSACTIONS") {
      setImportState({
        status: "error",
        message: `Account "${acct.name}" has trackingMode "${acct.trackingMode}". Set it to "Transactions" in account settings before importing — otherwise activities won't generate Holdings.`,
      });
      return;
    }
    setImportState({ status: "running", message: "Preparing activities…" });
    try {
      const skipKeys = buildTradingCashKeys(state.trading);
      // ISIN → WKN map so failure samples can show the WKN — makes it trivial
      // for the user to look the security up by WKN (the German ID) when a
      // mapping is missing or wrong.
      const isinToWkn = new Map<string, string>();
      for (const t of state.trading) {
        if (t.isin && t.wkn && !isinToWkn.has(t.isin)) isinToWkn.set(t.isin, t.wkn);
      }
      const activities = buildActivitiesFromParsed({
        accountId: acct.id,
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
      const isCashOnlySymbol = (s: string) => /^\$CASH/.test(s);

      ctx.api.logger.info(`[TR PDF] single-create import for ${activities.length} activities`);

      let imported = 0;
      let failures = 0;
      const failureExamples: string[] = [];
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
          // Build the SymbolInput payload for the Rust SDK.
          //
          // Order of preference:
          //   1. ISIN→ticker map (lookupTicker) — gives Yahoo a real ticker
          //      (AAPL, BTC-EUR, CSPX.L) that resolves to live prices and
          //      matching ticker-logos. This is the path that produces a
          //      pretty Holdings page with logos and current values.
          //   2. ISIN-as-symbol fallback — when no mapping exists. The
          //      activity still imports correctly (cost basis preserved),
          //      but Yahoo can't price it and no logo is shown.
          //   3. Pure cash (no symbol or "$CASH…") — symbol omitted; the
          //      Rust backend treats DEPOSIT/WITHDRAWAL as account-level.
          //
          // For the fallback we still set quoteCcy/instrumentType because
          // validate_persisted_symbol_metadata REJECTS new EQUITY assets
          // without explicit quoteCcy. CRYPTO bypasses that branch.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let symbolPayload: any;
          const mapped = sym ? lookupTicker(sym) : null;
          if (mapped) {
            symbolPayload = {
              symbol: mapped.symbol,
              exchangeMic: mapped.exchangeMic,
              // (v2.7.8) Prefer the friendly displayName from our map when
              // present (e.g. "iShares Core S&P 500" instead of TR's verbose
              // "iShares VII plc - iShares Core S&P 500 UCITS ETF USD (Acc)").
              // Falls back to whatever the PDF description gave us.
              name: mapped.displayName || a.symbolName,
              instrumentType: mapped.instrumentType,
              quoteCcy: mapped.quoteCcy ?? acct.currency,
            };
          } else if (sym && isISIN(sym) && isCryptoPseudo(sym)) {
            symbolPayload = {
              symbol: sym,
              name: a.symbolName,
              instrumentType: "CRYPTO",
              quoteMode: "MANUAL",
              quoteCcy: acct.currency,
            };
          } else if (sym && isISIN(sym)) {
            symbolPayload = {
              symbol: sym,
              exchangeMic: sym.startsWith("IE") ? TR_EQUITY_EU_EXCHANGE : undefined,
              name: a.symbolName,
              instrumentType: "EQUITY",
              quoteCcy: acct.currency,
            };
          } else if (sym && !isCashOnlySymbol(sym)) {
            // Non-ISIN symbol (rare). Treat as equity with EUR quote.
            symbolPayload = {
              symbol: sym,
              name: a.symbolName,
              instrumentType: "EQUITY",
              quoteCcy: acct.currency,
            };
          } else {
            symbolPayload = undefined; // pure cash flow
          }
          // (v2.7.9) Pass an explicit idempotencyKey per activity. Without
          // this, the Rust backend computes a content-based key from
          // (account, type, date, asset, qty, price, amount, currency,
          // source_record_id, notes). When TR has multiple savings-plan
          // executions on the SAME day for the SAME ETF at the SAME amount
          // (e.g. 3 AMD buys of €100.98 on Dec 20), even though they have
          // distinct quantities, Decimal normalization ("100.98" vs "100.980")
          // and float precision can collapse the keys. Result: only one of
          // the N trades survives, and the remaining shares disappear from
          // the imported portfolio.
          //
          // Our addon assigns a sequential `lineNumber` per activity inside
          // buildActivitiesFromParsed, which is unique within a single
          // statement. We combine it with the ISIN+date for human-readable
          // debugging and prefix with "tr-pdf-v2.7.9:" so we can audit/
          // delete this run's activities later.
          const idemKey = `tr-pdf-v2.7.9:${state.fileName || "unknown"}:${a.lineNumber ?? "?"}:${
            a.symbol || "cash"
          }:${(a.date as string).slice(0, 10)}`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const createPayload: any = {
            accountId: acct.id,
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
            idempotencyKey: idemKey,
            sourceSystem: "TR_PDF",
            sourceRecordId: idemKey,
          };
          await ctx.api.activities.create(createPayload);
          imported += 1;
        } catch (err) {
          failures += 1;
          // Tauri IPC errors come back as STRINGS (not Error objects), so
          // (err as Error).message is undefined and msg.slice() would throw,
          // killing the whole import loop. Coerce defensively.
          const errAny = err as { message?: unknown } | string | null | undefined;
          const rawMsg =
            typeof errAny === "string"
              ? errAny
              : typeof errAny === "object" && errAny !== null && typeof errAny.message === "string"
                ? errAny.message
                : String(err);
          const msg = rawMsg || "(empty error)";
          if (failures <= 10) {
            // Log only the first 10 failures so we don't flood the log.
            ctx.api.logger.warn(`[TR PDF] create failed (row ${i + 1}, ${a.symbol}): ${msg}`);
          }
          if (failureExamples.length < 3) {
            const wkn = a.symbol ? isinToWkn.get(a.symbol) : undefined;
            const tag = a.symbol ? (wkn ? `${a.symbol} (WKN ${wkn})` : a.symbol) : "(cash)";
            failureExamples.push(`${tag}: ${msg.slice(0, 200)}`);
          }
        }
      }

      const totalElapsed = Math.round((Date.now() - startMs) / 1000);
      ctx.api.logger.info(
        `[TR PDF] import done: ${imported} imported, ${failures} failed, ${totalElapsed}s`,
      );

      // (v2.7.6) After import, trigger Donkeyfolio's portfolio recalculation
      // so the Performance chart, TWR and historical valuations populate
      // immediately. Otherwise the user has to dig into Settings → Market
      // Data and click Rebuild History manually. This is a fire-and-forget:
      // the call can take ~1-3 minutes for a yearly statement worth of
      // history, but we don't block the import-done UI on it.
      setImportState({
        status: "done",
        imported,
        skipped: failures,
        accountCreated: false,
        failureExamples: failures > 0 ? failureExamples : undefined,
      });
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const portfolio = (ctx.api as any).portfolio;
        if (portfolio?.recalculate) {
          ctx.api.logger.info(
            "[TR PDF] triggering portfolio.recalculate() to rebuild historical snapshots…",
          );
          portfolio
            .recalculate()
            .then(() => {
              ctx.api.logger.info("[TR PDF] portfolio recalculation complete.");
            })
            .catch((err: unknown) => {
              const m = err instanceof Error ? err.message : String(err);
              ctx.api.logger.warn(`[TR PDF] portfolio.recalculate() failed (non-fatal): ${m}`);
            });
        } else if (portfolio?.update) {
          // Fallback: older SDKs only expose `update()`.
          portfolio.update().catch(() => undefined);
        }
      } catch (err) {
        ctx.api.logger.warn(
          `[TR PDF] could not trigger portfolio recalc: ${(err as Error).message}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.api.logger.error(`[TR PDF] Import failed: ${message}`);
      setImportState({
        status: "error",
        message: message.length > 300 ? message.slice(0, 300) + "…" : message,
      });
    }
  }, [ctx, accounts, selectedAccountId, state.cash, state.status, state.trading]);

  const reset = () => {
    setState(initialState);
    setImportState({ status: "idle" });
    setShowOnlyFailed(false);
    setSplitState({ status: "idle" });
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

  // Reconciliation: compute statement totals + activity-type breakdown +
  // expected net cash delta, so the user can spot a parser/classification
  // mismatch BEFORE clicking import. Memoised — re-runs only when parsed
  // data changes.
  const reconcile: ReconcileResult | null = React.useMemo(() => {
    if (state.status !== "done" || state.cash.length === 0) return null;
    const skipKeys = buildTradingCashKeys(state.trading);
    const activities = buildActivitiesFromParsed({
      // accountId/currency don't affect totals — placeholders are fine.
      accountId: "_reconcile",
      currency: "EUR",
      cash: state.cash,
      trading: state.trading,
      skipCashKeys: skipKeys,
    });
    return buildReconciliation(state.cash, activities, state.summary);
  }, [state.status, state.cash, state.trading, state.summary]);

  // (v2.7.11) Per-ISIN classification: which securities are mapped to a
  // Yahoo ticker, which are crypto (mapped via pseudo-ISIN), and which are
  // unmapped — the user wants to see the unmapped ones explicitly so we
  // can extend the ticker map together.
  const securityAnalysis: SecurityAnalysis[] = React.useMemo(() => {
    if (state.status !== "done" || state.trading.length === 0) return [];
    return analyzeSecurities(state.trading);
  }, [state.status, state.trading]);

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
                    Pick the target account, then import activities directly — or export a CSV
                    shaped for the Import Activities wizard.
                  </CardDescription>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    onClick={handleImport}
                    disabled={
                      importState.status === "running" || !selectedAccountId || !accountsLoaded
                    }
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
            <CardContent className="space-y-3 pt-0 text-sm">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[260px] flex-1">
                  <label
                    htmlFor="tr-account-select"
                    className="text-muted-foreground mb-1 block text-xs font-medium"
                  >
                    Target account
                  </label>
                  <select
                    id="tr-account-select"
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                    disabled={
                      importState.status === "running" || !accountsLoaded || creatingAccount
                    }
                    className="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="">
                      {accountsLoaded
                        ? accounts.length === 0
                          ? "No accounts found — create one below"
                          : "Select an account…"
                        : "Loading accounts…"}
                    </option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.accountType} · {a.currency}
                        {a.trackingMode !== "TRANSACTIONS" ? " ⚠" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  onClick={handleCreateTRAccount}
                  variant="outline"
                  size="sm"
                  disabled={importState.status === "running" || creatingAccount || !accountsLoaded}
                >
                  {creatingAccount ? (
                    <>
                      <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                      Creating…
                    </>
                  ) : (
                    <>
                      <Icons.Plus className="mr-2 h-4 w-4" />
                      Create Trade Republic account
                    </>
                  )}
                </Button>
              </div>
              {selectedAccount && selectedAccount.trackingMode !== "TRANSACTIONS" && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  ⚠ This account uses trackingMode <code>{selectedAccount.trackingMode}</code>. Set
                  it to <strong>Transactions</strong> in Donkeyfolio account settings before
                  importing — otherwise activities won't generate Holdings.
                </p>
              )}
              {accountsLoaded && accounts.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  No accounts found in this Donkeyfolio install. Click{" "}
                  <strong>Create Trade Republic account</strong> to add one with the right tracking
                  mode.
                </p>
              )}
            </CardContent>
            {(importState.status === "running" ||
              importState.status === "done" ||
              importState.status === "error") && (
              <CardContent className="text-sm">
                {importState.status === "running" && (
                  <p className="text-muted-foreground">{importState.message}</p>
                )}
                {importState.status === "done" && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                      <Icons.CheckCircle className="h-4 w-4 shrink-0" />
                      <span>
                        Imported <strong>{importState.imported}</strong> activities
                        {importState.skipped > 0 && ` · ${importState.skipped} skipped`}
                        {importState.accountCreated && " · account created"}
                      </span>
                    </div>
                    {importState.failureExamples && importState.failureExamples.length > 0 && (
                      <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                        <div className="font-medium">Sample failures:</div>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4">
                          {importState.failureExamples.map((msg, i) => (
                            <li key={i} className="font-mono">
                              {msg}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
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

          {/* ─── Cash reconciliation (statement vs activities) ─── */}
          {reconcile && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cash reconciliation</CardTitle>
                <CardDescription>
                  {reconcile.pdfSummary
                    ? "PDF summary block (page 1) is the authoritative ground-truth — what TR officially says about the period. We compare our row-by-row parsing against it to catch parser drift, then compare our import activities against the summary."
                    : "Couldn't locate the PDF summary block on page 1. Falling back to row-by-row totals (less reliable)."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                {/* PDF summary tiles (preferred) — falls back to row-derived. */}
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <ReconcileTile
                    label="Opening balance"
                    value={formatEur(
                      reconcile.pdfSummary
                        ? reconcile.pdfSummary.opening
                        : reconcile.rowDerived.opening,
                    )}
                  />
                  <ReconcileTile
                    label="Money IN"
                    value={formatEur(
                      reconcile.pdfSummary
                        ? reconcile.pdfSummary.moneyIn
                        : reconcile.rowDerived.totalIn,
                    )}
                    tone="positive"
                  />
                  <ReconcileTile
                    label="Money OUT"
                    value={formatEur(
                      reconcile.pdfSummary
                        ? reconcile.pdfSummary.moneyOut
                        : reconcile.rowDerived.totalOut,
                    )}
                    tone="negative"
                  />
                  <ReconcileTile
                    label="Closing balance"
                    value={formatEur(
                      reconcile.pdfSummary
                        ? reconcile.pdfSummary.ending
                        : reconcile.rowDerived.closing,
                    )}
                  />
                </div>

                {/* Parser-drift warning: when our row-by-row sums disagree
                    with the PDF summary, the parser has dropped or
                    double-counted rows. Show how much we're off so the user
                    can see the diagnosis directly. */}
                {reconcile.parserDrift &&
                  (Math.abs(reconcile.parserDrift.inDrift) > 0.01 ||
                    Math.abs(reconcile.parserDrift.outDrift) > 0.01 ||
                    Math.abs(reconcile.parserDrift.closingDrift) > 0.01) && (
                    <div className="rounded-md border border-orange-200 bg-orange-50 p-3 text-xs dark:border-orange-900 dark:bg-orange-950/30">
                      <div className="flex items-start gap-2">
                        <Icons.AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-orange-700 dark:text-orange-300" />
                        <div className="space-y-1">
                          <p className="font-medium text-orange-900 dark:text-orange-200">
                            Parser drift detected — our row-by-row sum disagrees with the PDF
                            summary block.
                          </p>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-orange-800 dark:text-orange-300">
                            <span>
                              IN drift: <strong>{formatEur(reconcile.parserDrift.inDrift)}</strong>
                            </span>
                            <span>
                              OUT drift:{" "}
                              <strong>{formatEur(reconcile.parserDrift.outDrift)}</strong>
                            </span>
                            <span>
                              Closing drift:{" "}
                              <strong>{formatEur(reconcile.parserDrift.closingDrift)}</strong>
                            </span>
                          </div>
                          <p className="text-orange-800 dark:text-orange-300">
                            Positive = parser counted MORE than the summary. Negative = parser
                            MISSED rows. The reconciliation below uses the PDF summary as
                            ground-truth, so the import will still aim at the correct closing
                            balance.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                {/* Breakdown */}
                {reconcile.breakdown.length > 0 && (
                  <div className="overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Activity type</TableHead>
                          <TableHead className="text-right">Count</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                          <TableHead className="text-right">Cash impact</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {reconcile.breakdown.map((r) => (
                          <TableRow key={r.activityType}>
                            <TableCell>
                              <Badge variant="outline" className="font-mono text-xs">
                                {r.activityType}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono">{r.count}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatEur(r.total)}
                            </TableCell>
                            <TableCell
                              className={`text-right font-mono font-medium ${
                                r.cashImpact > 0
                                  ? "text-green-600 dark:text-green-400"
                                  : r.cashImpact < 0
                                    ? "text-red-600 dark:text-red-400"
                                    : ""
                              }`}
                            >
                              {(r.cashImpact > 0 ? "+" : "") + formatEur(r.cashImpact)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {/* Verdict */}
                <div
                  className={`flex items-start gap-2 rounded-md border p-3 ${
                    Math.abs(reconcile.reconciliationGap) < 0.01
                      ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30"
                      : "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
                  }`}
                >
                  {Math.abs(reconcile.reconciliationGap) < 0.01 ? (
                    <Icons.CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-700 dark:text-green-300" />
                  ) : (
                    <Icons.AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
                  )}
                  <div className="space-y-1 text-xs">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono">
                      <span>
                        {reconcile.pdfSummary ? "PDF Δ" : "Statement Δ"}:{" "}
                        <strong>{formatEur(reconcile.authoritativeNetDelta)}</strong> (
                        {reconcile.pdfSummary ? "ending − opening" : "closing − opening"})
                      </span>
                      <span>
                        Activities Δ: <strong>{formatEur(reconcile.activitiesNetDelta)}</strong>
                      </span>
                      <span>
                        Gap:{" "}
                        <strong
                          className={
                            Math.abs(reconcile.reconciliationGap) < 0.01
                              ? "text-green-700 dark:text-green-300"
                              : "text-amber-700 dark:text-amber-300"
                          }
                        >
                          {formatEur(reconcile.reconciliationGap)}
                        </strong>
                      </span>
                    </div>
                    {Math.abs(reconcile.reconciliationGap) < 0.01 ? (
                      <p className="text-green-700 dark:text-green-300">
                        ✓ The activities we'll import reconcile to the PDF closing balance.
                      </p>
                    ) : (
                      <p className="text-amber-700 dark:text-amber-300">
                        Off by {formatEur(reconcile.reconciliationGap)} — likely a cash row with an
                        unrecognised type, or a parser drop-out. Check rows tagged "Refund" /
                        "Settlement" / "Rounding" — those need a CREDIT subtype mapping.
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ─── Stock-split detection (Yahoo Finance, opt-in) ─── */}
          {state.trading.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="text-base">Stock splits</CardTitle>
                    <CardDescription>
                      TR PDFs record pre-split quantities. After a 2:1 split your imported holding
                      will be half of reality unless a SPLIT activity is added. This check queries
                      Yahoo Finance for splits that happened after each position's first trade.
                    </CardDescription>
                  </div>
                  <Button
                    onClick={handleCheckSplits}
                    variant="outline"
                    size="sm"
                    disabled={splitState.status === "running" || importState.status === "running"}
                  >
                    {splitState.status === "running" ? (
                      <>
                        <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                        Checking…
                      </>
                    ) : (
                      <>
                        <Icons.Search className="mr-2 h-4 w-4" />
                        Check for splits
                      </>
                    )}
                  </Button>
                </div>
              </CardHeader>
              {splitState.status !== "idle" && (
                <CardContent className="text-sm">
                  {splitState.status === "running" && (
                    <div className="text-muted-foreground">
                      Querying Yahoo… {splitState.checked}
                      {splitState.total > 0 ? ` / ${splitState.total}` : ""} positions checked.
                    </div>
                  )}
                  {splitState.status === "error" && (
                    <div className="flex items-start gap-2 text-red-700 dark:text-red-300">
                      <Icons.AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{splitState.message}</span>
                    </div>
                  )}
                  {splitState.status === "done" && splitState.splits.length === 0 && (
                    <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                      <Icons.CheckCircle className="h-4 w-4 shrink-0" />
                      <span>
                        No splits detected — checked {splitState.checked} position
                        {splitState.checked === 1 ? "" : "s"}
                        {splitState.errors > 0 ? ` (${splitState.errors} couldn't be queried)` : ""}
                        .
                      </span>
                    </div>
                  )}
                  {splitState.status === "done" && splitState.splits.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                        <Icons.AlertCircle className="h-4 w-4 shrink-0" />
                        <span>
                          Found <strong>{splitState.splits.length}</strong> split
                          {splitState.splits.length === 1 ? "" : "s"} affecting your TR holdings.
                          Add a <code>SPLIT</code> activity in Donkeyfolio for each one (or your
                          imported quantity will stay at the pre-split amount).
                        </span>
                      </div>
                      <div className="overflow-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Stock</TableHead>
                              <TableHead>Ticker</TableHead>
                              <TableHead>WKN</TableHead>
                              <TableHead>Split date</TableHead>
                              <TableHead className="text-right">Ratio</TableHead>
                              <TableHead>First trade</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {splitState.splits.map((s, i) => (
                              <TableRow key={`${s.isin}-${s.date}-${i}`}>
                                <TableCell className="max-w-xs truncate" title={s.stockName}>
                                  {s.stockName}
                                </TableCell>
                                <TableCell className="font-mono text-xs">{s.ticker}</TableCell>
                                <TableCell className="text-muted-foreground font-mono text-xs">
                                  {s.wkn || "—"}
                                </TableCell>
                                <TableCell className="font-mono text-xs">{s.date}</TableCell>
                                <TableCell className="text-right font-mono">
                                  <Badge
                                    variant={s.ratioMul > 1 ? "outline" : "secondary"}
                                    className="text-xs"
                                  >
                                    {s.ratio}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-muted-foreground font-mono text-xs">
                                  {s.firstTradeDate}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      {splitState.errors > 0 && (
                        <p className="text-muted-foreground text-xs">
                          Note: {splitState.errors} ticker
                          {splitState.errors === 1 ? "" : "s"} couldn't be queried (network /
                          rate-limit). Re-run if needed.
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          )}

          {/* ─── Unmapped securities panel (v2.7.11) ─── */}
          {securityAnalysis.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Securities mapping status</CardTitle>
                <CardDescription>
                  Each ISIN in your statement is classified by whether the addon has a Yahoo ticker
                  mapping. Unmapped securities still import (cost basis is preserved) but Yahoo may
                  not find live prices automatically. Click "Lookup on Yahoo" to find the correct
                  ticker and tell me which ones to add to the map.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                {/* Summary tiles */}
                <div className="grid grid-cols-3 gap-3">
                  <ReconcileTile
                    label="Mapped to Yahoo"
                    value={`${securityAnalysis.filter((s) => s.status === "mapped").length}`}
                    tone="positive"
                  />
                  <ReconcileTile
                    label="Crypto (pseudo-ISIN)"
                    value={`${securityAnalysis.filter((s) => s.status === "crypto").length}`}
                  />
                  <ReconcileTile
                    label="Unmapped (verify)"
                    value={`${securityAnalysis.filter((s) => s.status === "unmapped").length}`}
                    tone="negative"
                  />
                </div>

                {/* Table — show unmapped first (sorted by spend), then crypto, then mapped */}
                <div className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>Stock</TableHead>
                        <TableHead>ISIN</TableHead>
                        <TableHead>WKN</TableHead>
                        <TableHead>Yahoo ticker</TableHead>
                        <TableHead className="text-right">Net qty</TableHead>
                        <TableHead className="text-right">Spent</TableHead>
                        <TableHead>Verify</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {securityAnalysis.map((s) => (
                        <TableRow
                          key={s.isin}
                          className={
                            s.status === "unmapped"
                              ? "bg-amber-50/50 dark:bg-amber-950/10"
                              : undefined
                          }
                        >
                          <TableCell>
                            <Badge
                              variant={
                                s.status === "mapped"
                                  ? "outline"
                                  : s.status === "crypto"
                                    ? "secondary"
                                    : "destructive"
                              }
                              className="text-xs"
                            >
                              {s.status === "mapped"
                                ? "✓ Mapped"
                                : s.status === "crypto"
                                  ? "Crypto"
                                  : "⚠ Unmapped"}
                            </Badge>
                          </TableCell>
                          <TableCell
                            className="max-w-xs truncate"
                            title={s.mappedName || s.stockName}
                          >
                            {s.mappedName || s.stockName}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{s.isin}</TableCell>
                          <TableCell className="text-muted-foreground font-mono text-xs">
                            {s.wkn || "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {s.mappedSymbol || "—"}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatQty(s.netQty)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatEur(s.totalSpent)}
                          </TableCell>
                          <TableCell>
                            <a
                              href={s.yahooLookupUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                            >
                              Lookup on Yahoo →
                            </a>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <p className="text-muted-foreground text-xs">
                  💡 Tip: when you find the correct Yahoo ticker for an unmapped security, send me
                  the ISIN + ticker and I&apos;ll add it to the addon&apos;s map so future imports
                  resolve it automatically.
                </p>
              </CardContent>
            </Card>
          )}

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

function ReconcileTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? "text-green-600 dark:text-green-400"
      : tone === "negative"
        ? "text-red-600 dark:text-red-400"
        : "";
  return (
    <div className="bg-muted/40 rounded-md border p-3">
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      <div className={`mt-1 font-mono text-lg font-bold ${toneClass}`}>{value}</div>
    </div>
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
              <TableHead>WKN</TableHead>
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
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {p.wkn || "—"}
                </TableCell>
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
