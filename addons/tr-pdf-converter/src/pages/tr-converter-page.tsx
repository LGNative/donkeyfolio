import type { Account, ActivityCreate, AddonContext } from "@wealthfolio/addon-sdk";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Icons,
  Input,
  Progress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import React from "react";

import {
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
  buildManualHoldingActivities,
  buildQtyAdjustments,
  buildStakingActivities,
  buildTradingCashKeys,
  scaleCryptoBuysToTarget,
  toIsoDate,
  type ManualHoldingEntry,
  type QtyAdjustmentEntry,
  type StakingReconcileEntry,
} from "../lib/tr-to-activities";
import {
  buildCryptoReconcileEntries,
  type CryptoReconcileEntry,
} from "../components/crypto-reconcile-panel";
import { detectSplitsForPositions, type SplitEvent } from "../lib/tr-splits";
import {
  extractCryptoDirectBuysFromCash,
  resolveCryptoDirectBuys,
} from "../lib/tr-crypto-resolver";
import {
  discoverTickers,
  buildDiscoveryMap,
  type DiscoveryResult,
} from "../lib/tr-ticker-discovery";
import { buildReconciliation, type ReconcileResult } from "../lib/tr-reconcile";
import {
  countPending,
  loadLastFullScan,
  loadSettings,
  runWatcherScan,
  saveSettings,
  writeLastAppliedSplit,
  type WatcherFindings,
  type WatcherSettings,
} from "../lib/tr-splits-watcher";
import WatcherPanel from "../components/watcher-panel";

// ─── Phase labels ───────────────────────────────────────────────────────
type ParsePhase =
  | "reading"
  | "parsing"
  | "resolving-crypto"
  | "discovering-tickers"
  | "detecting-splits"
  | "building"
  | "done"
  | "error";

interface ParseState {
  status: "idle" | "parsing" | "done" | "error";
  phase?: ParsePhase;
  message?: string;
  progress?: { page: number; total: number };
  cash: CashTransaction[];
  interest: InterestTransaction[];
  trading: TradingTransaction[];
  pnl: EnhancedPnLResult | null;
  failedChecks: number;
  recoveredRows: number;
  fileName: string;
  summary: StatementSummary | null;
  discoveredTickers: DiscoveryResult[];
  autoSplits: SplitEvent[];
  cryptoResolved: number;
  /** (v2.17.0) per-crypto holdings to reconcile against TR app values. */
  cryptoReconcile: CryptoReconcileEntry[];
}

type ImportState =
  | { status: "idle" }
  | { status: "running"; message: string; progress?: { done: number; total: number } }
  | {
      status: "done";
      imported: number;
      skipped: number;
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
  discoveredTickers: [],
  autoSplits: [],
  cryptoResolved: 0,
  cryptoReconcile: [],
};

// Format-aware EUR string parser (mirrors the one in tr-parser/tr-to-activities).
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

// ─── DB holding shape used by the holdings audit panel ──────────────────
interface DbHolding {
  symbol: string;
  name: string;
  qty: number;
  assetId: string | null;
}

export default function TrConverterPage({ ctx }: TrConverterPageProps) {
  const [state, setState] = React.useState<ParseState>(initialState);
  const [importState, setImportState] = React.useState<ImportState>({ status: "idle" });
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);
  // (v2.19.7) Removed crypto-reconcile + manual-holdings state — those
  // panels were retired. Staking and spin-offs are now added by hand
  // directly in Donkeyfolio after import.

  // Account selection — load on mount, prefer existing TR account.
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [accountsLoaded, setAccountsLoaded] = React.useState(false);
  const [selectedAccountId, setSelectedAccountId] = React.useState<string>("");
  const [creatingAccount, setCreatingAccount] = React.useState(false);

  // Issues panel — collapsible.
  const [issuesOpen, setIssuesOpen] = React.useState(true);
  // Parsed-details disclosure (cash / mmf / trading tables).
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [activeDetailsTab, setActiveDetailsTab] = React.useState<"cash" | "mmf" | "trading">(
    "cash",
  );

  // Manual reconciliation panel state — keyed by ticker.
  const [dbHoldings, setDbHoldings] = React.useState<DbHolding[]>([]);
  const [holdingsLoading, setHoldingsLoading] = React.useState(false);
  const [trQtyInputs, setTrQtyInputs] = React.useState<Record<string, string>>({});
  const [reconcilePending, setReconcilePending] = React.useState<string | null>(null);
  const [reconcileMessages, setReconcileMessages] = React.useState<Record<string, string>>({});
  const [rebuildingHistory, setRebuildingHistory] = React.useState(false);

  // Watcher.
  const [watcherSettings, setWatcherSettings] = React.useState<WatcherSettings>(() =>
    loadSettings(),
  );
  const [watcherFindings, setWatcherFindings] = React.useState<WatcherFindings | null>(null);
  const [watcherScanning, setWatcherScanning] = React.useState(false);
  const [watcherProgress, setWatcherProgress] = React.useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [watcherOpen, setWatcherOpen] = React.useState(false);

  const loadAccounts = React.useCallback(async () => {
    try {
      const all = await ctx.api.accounts.getAll();
      const sorted = [...all]
        .filter((a) => a.isActive && !a.isArchived)
        .sort((a, b) => {
          if (a.accountType === "SECURITIES" && b.accountType !== "SECURITIES") return -1;
          if (b.accountType === "SECURITIES" && a.accountType !== "SECURITIES") return 1;
          return a.name.localeCompare(b.name);
        });
      setAccounts(sorted);
      const trMatch = sorted.find((a) => a.name.trim().toLowerCase() === "trade republic");
      if (trMatch) setSelectedAccountId(trMatch.id);
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

  // ─── PDF parsing ──────────────────────────────────────────────────────
  const handleFile = React.useCallback(async (file: File) => {
    setImportState({ status: "idle" });
    setDbHoldings([]);
    setTrQtyInputs({});
    setReconcileMessages({});
    setState({
      ...initialState,
      status: "parsing",
      phase: "reading",
      message: "Reading PDF…",
      fileName: file.name,
    });
    try {
      const buffer = await file.arrayBuffer();
      const result = await parsePDF(buffer, (page, total) => {
        setState((s) => ({
          ...s,
          phase: "parsing",
          progress: { page, total },
          message: `Parsing page ${page} of ${total}…`,
        }));
      });

      const { cash: mergedCash, merged: mergedRows } = mergeContinuationRows(result.cash);
      const { cash: recoveredCash, recovered: recoveredRows } = recoverCashAmounts(mergedCash);
      const summaryOpening = result.summary
        ? parseEurDisplay(result.summary.openingBalance)
        : undefined;
      const { cash: chainConsistentCash, corrected: chainCorrected } = enforceChainConsistency(
        recoveredCash,
        summaryOpening,
      );
      const { transactions: cashWithChainSanity } = computeCashSanityChecks(chainConsistentCash);
      const cashWithSanity = cashWithChainSanity.map((r) => {
        if (r._sanityCheckOk !== false) return r;
        const desc = r.beschreibung || "";
        const isBuyTrade =
          /\bBuy\b|\bKauf\b|\bCompra\b/i.test(desc) &&
          /\btrade\b|\bHandel\b|\bSavings plan\b/i.test(desc);
        const isSellTrade =
          /\bSell\b|\bVerkauf\b|\bVenta\b/i.test(desc) && /\btrade\b|\bHandel\b/i.test(desc);
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
        if ((isBuyTrade && onlyOut) || (isSellTrade && onlyIn)) {
          return { ...r, _sanityCheckOk: true };
        }
        if (!isBuyTrade && !isSellTrade && (onlyOut || onlyIn)) {
          return { ...r, _sanityCheckOk: true };
        }
        return r;
      });
      const failedChecks = cashWithSanity.filter((r) => r._sanityCheckOk === false).length;
      const analyticsCash = cashWithSanity.map(toAnalyticsShape);
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

      // (v2.19.7) Skip "Compra direta" crypto extraction + Yahoo resolver.
      // TR's PDF doesn't include qty for these rows, and Yahoo's daily close
      // is NOT TR's actual execution price — using it produced inflated qty
      // and unitPrice that didn't match the TR app. Worse, fees got folded
      // into the trade value because we had no separate fee column for them.
      //
      // What this means in practice:
      //   - Savings plan crypto BUYs (qty IS in PDF) → still imported ✅
      //   - "Compra direta" / "Direct buy" crypto rows → flow through as
      //     plain WITHDRAWAL cash legs (matches TR app's cash view).
      //   - User adds the corresponding crypto BUY activities by hand in
      //     Donkeyfolio with the exact qty + avg price the TR app shows.
      const cryptoTrading = trading;
      const cryptoResolved = 0;

      setState((s) => ({ ...s, phase: "discovering-tickers", message: "Discovering tickers…" }));
      const unmappedRequests: { isin: string; name: string; wkn?: string }[] = [];
      const seenIsins = new Set<string>();
      for (const t of cryptoTrading) {
        if (!t.isin || seenIsins.has(t.isin)) continue;
        seenIsins.add(t.isin);
        if (lookupTicker(t.isin) || t.isin.startsWith("XF000")) continue;
        unmappedRequests.push({
          isin: t.isin,
          name: t.cleanStockName || t.stockName,
          wkn: t.wkn,
        });
      }
      let discoveredTickers: DiscoveryResult[] = [];
      if (unmappedRequests.length > 0) {
        try {
          discoveredTickers = await discoverTickers(unmappedRequests);
        } catch (err) {
          ctx.api.logger.warn(
            `[TR PDF] ticker discovery failed (non-fatal): ${(err as Error).message}`,
          );
        }
      }

      setState((s) => ({ ...s, phase: "detecting-splits", message: "Detecting splits…" }));
      let autoSplits: SplitEvent[] = [];
      try {
        const splitResult = await detectSplitsForPositions(cryptoTrading);
        autoSplits = splitResult.splits;
      } catch (err) {
        ctx.api.logger.warn(
          `[TR PDF] split detector failed (non-fatal): ${(err as Error).message}`,
        );
      }

      setState((s) => ({ ...s, phase: "building", message: "Building activities…" }));
      const pnl = cryptoTrading.length ? computeEnhancedPnL(cryptoTrading) : null;

      setState({
        status: "done",
        phase: "done",
        message: undefined,
        progress: undefined,
        cash: cashWithSanity,
        interest: result.interest,
        trading: cryptoTrading,
        pnl,
        failedChecks,
        recoveredRows: recoveredRows + chainCorrected + mergedRows,
        fileName: file.name,
        summary: result.summary ?? null,
        discoveredTickers,
        autoSplits,
        cryptoResolved,
        cryptoReconcile: buildCryptoReconcileEntries(cryptoTrading),
      });
    } catch (err) {
      setState({
        ...initialState,
        status: "error",
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
        fileName: file.name,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.type === "application/pdf") void handleFile(file);
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

  // ─── Reconciliation pre-import ────────────────────────────────────────
  const reconcile: ReconcileResult | null = React.useMemo(() => {
    if (state.status !== "done" || state.cash.length === 0) return null;
    const skipKeys = buildTradingCashKeys(state.trading);
    const activities = buildActivitiesFromParsed({
      accountId: "_reconcile",
      currency: "EUR",
      cash: state.cash,
      trading: state.trading,
      skipCashKeys: skipKeys,
    });
    return buildReconciliation(state.cash, activities, state.summary);
  }, [state.status, state.cash, state.trading, state.summary]);

  const securityAnalysis: SecurityAnalysis[] = React.useMemo(() => {
    if (state.status !== "done" || state.trading.length === 0) return [];
    return analyzeSecurities(state.trading);
  }, [state.status, state.trading]);

  const unmappedSecurities = securityAnalysis.filter((s) => s.status === "unmapped");

  // Summary KPIs.
  const cashCount = state.cash.length;
  const tradingCount = state.trading.length;
  const netPnl = state.pnl ? state.pnl.totalSold - state.pnl.totalBought : 0;
  const pdfEnding = state.summary ? parseEurDisplay(state.summary.endingBalance) : null;

  // Parser drift magnitude (for the "issues" line).
  const parserDriftEur = reconcile?.parserDrift
    ? Math.max(
        Math.abs(reconcile.parserDrift.inDrift),
        Math.abs(reconcile.parserDrift.outDrift),
        Math.abs(reconcile.parserDrift.closingDrift),
      )
    : 0;

  const issuesCount =
    unmappedSecurities.length +
    state.autoSplits.length +
    (state.cryptoResolved > 0 ? 1 : 0) +
    (parserDriftEur > 50 ? 1 : 0);

  // ─── Import ───────────────────────────────────────────────────────────
  const handleImport = React.useCallback(async () => {
    if (state.status !== "done") return;
    if (!selectedAccountId) {
      setImportState({
        status: "error",
        message: "Pick a target account first (or create a Trade Republic account).",
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
        message: `Account "${acct.name}" has trackingMode "${acct.trackingMode}". Set it to "Transactions" before importing.`,
      });
      return;
    }
    setImportState({ status: "running", message: "Preparing activities…" });
    try {
      const skipKeys = buildTradingCashKeys(state.trading);
      const isinToWkn = new Map<string, string>();
      for (const t of state.trading) {
        if (t.isin && t.wkn && !isinToWkn.has(t.isin)) isinToWkn.set(t.isin, t.wkn);
      }
      const discoveryMap = buildDiscoveryMap(state.discoveredTickers);
      const pdfSummaryNumeric = state.summary
        ? {
            opening: parseEurDisplay(state.summary.openingBalance),
            moneyIn: parseEurDisplay(state.summary.moneyIn),
            moneyOut: parseEurDisplay(state.summary.moneyOut),
            ending: parseEurDisplay(state.summary.endingBalance),
          }
        : undefined;
      const lastActivityDate =
        state.cash.length > 0 ? state.cash[state.cash.length - 1].datum : undefined;
      const activities = buildActivitiesFromParsed({
        accountId: acct.id,
        currency: acct.currency,
        cash: state.cash,
        trading: state.trading,
        skipCashKeys: skipKeys,
        pdfSummary: pdfSummaryNumeric,
        lastActivityDate,
        autoSplits: state.autoSplits,
      });

      // (v2.19.7) Removed crypto reconciliation + manual holdings — user
      // adds staking and spin-off rows by hand directly in Donkeyfolio
      // after the PDF import. The addon now focuses on what the PDF
      // actually contains.

      if (activities.length === 0) {
        setImportState({ status: "error", message: "No importable activities found in this PDF." });
        return;
      }

      const TR_EQUITY_EU_EXCHANGE = "XAMS";
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
        if (i % 25 === 0) {
          const elapsed = (Date.now() - startMs) / 1000;
          const eta = i > 0 ? Math.round((elapsed / i) * (activities.length - i)) : 0;
          setImportState({
            status: "running",
            message: `Importing ${i + 1} of ${activities.length}…  (${
              eta > 0 ? `~${eta}s remaining` : "estimating"
            })`,
            progress: { done: i, total: activities.length },
          });
        }
        try {
          const sym = a.symbol || "";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let symbolPayload: any;
          // (v2.19.6) Aligned with Rust source-of-truth structs:
          //   - NewActivity   (crates/core/src/activities/activities_model.rs:241)
          //   - SymbolInput   (crates/core/src/activities/activities_model.rs:219)
          //
          // SDK's TS types are INCOMPLETE. Rust accepts at top level:
          //   idempotencyKey, sourceSystem, sourceRecordId, sourceGroupId,
          //   status, needsReview (kept at top — valid).
          // Rust SymbolInput accepts INSIDE symbol:
          //   id, symbol, exchangeMic, kind, name, quoteMode,
          //   quoteCcy ✅, instrumentType ✅ (both DO exist in Rust, just
          //   not in the TS type).
          //
          // Net: every meaningful TR hint has a proper home — nothing
          // hidden in `metadata` anymore. Specifically:
          //   - quoteCcy        → symbol.quoteCcy (was: metadata blob)
          //   - instrumentType  → symbol.instrumentType (was: dropped)
          //   - kind            → symbol.kind (preserved)
          //   - name            → symbol.name (preserved)
          const mapped = sym ? lookupTicker(sym) || discoveryMap.get(sym) || null : null;
          if (mapped) {
            symbolPayload = {
              symbol: mapped.symbol,
              exchangeMic: mapped.exchangeMic,
              name: mapped.displayName || a.symbolName,
              kind: mapped.instrumentType,
              instrumentType: mapped.instrumentType,
              quoteCcy: mapped.quoteCcy ?? acct.currency,
            };
          } else if (sym && isISIN(sym) && isCryptoPseudo(sym)) {
            symbolPayload = {
              symbol: sym,
              name: a.symbolName,
              kind: "CRYPTO",
              instrumentType: "CRYPTO",
              quoteMode: "MANUAL",
              quoteCcy: acct.currency,
            };
          } else if (sym && isISIN(sym)) {
            symbolPayload = {
              symbol: sym,
              exchangeMic: sym.startsWith("IE") ? TR_EQUITY_EU_EXCHANGE : undefined,
              name: a.symbolName,
              kind: "EQUITY",
              instrumentType: "EQUITY",
              quoteCcy: acct.currency,
            };
          } else if (sym && !isCashOnlySymbol(sym)) {
            symbolPayload = {
              symbol: sym,
              name: a.symbolName,
              kind: "EQUITY",
              instrumentType: "EQUITY",
              quoteCcy: acct.currency,
            };
          } else {
            symbolPayload = undefined;
          }

          // Defensive: ensure activityDate is a YYYY-MM-DD string. Rust
          // NewActivity.activity_date validates as RFC3339 or YYYY-MM-DD;
          // a Date object stringified by JSON is fine, but a missing/empty
          // date silently leaves the column blank in the activities UI.
          const rawDate = a.date;
          const activityDate =
            typeof rawDate === "string"
              ? rawDate.slice(0, 10)
              : rawDate instanceof Date
                ? rawDate.toISOString().slice(0, 10)
                : new Date().toISOString().slice(0, 10);

          const idemKey = `tr-pdf-v2.19.6:${state.fileName || "unknown"}:${a.lineNumber ?? "?"}:${
            a.symbol || "cash"
          }:${activityDate}`;

          // Every meaningful field now has its proper Rust home:
          //   - asset hints (name, kind, instrumentType, quoteCcy) → symbol
          //   - dedupe & audit (idem/source*) → top-level
          //   - free-form audit trail (PDF filename, parsed line) → metadata
          //
          // The SDK TS type doesn't enumerate idempotencyKey/sourceSystem
          // but the Rust deserializer accepts them — `as ActivityCreate`
          // satisfies TS, runtime contract is what counts.
          const createPayload = {
            accountId: acct.id,
            activityType: a.activityType,
            activityDate,
            subtype: a.subtype ?? null,
            symbol: symbolPayload,
            quantity: a.quantity ?? 0,
            unitPrice: a.unitPrice ?? 0,
            amount: a.amount ?? 0,
            currency: a.currency,
            // EUR-account: every TR row is already in EUR so fxRate=1.
            // USD assets are FX-converted at the asset/quote layer, not here.
            fxRate: 1,
            fee: a.fee ?? 0,
            comment: a.comment ?? null,
            // metadata is a JSON blob (Rust: Option<String>). Audit trail
            // only — the structured asset hints already travel via `symbol`.
            metadata: JSON.stringify({
              source: "TR_PDF",
              file: state.fileName ?? null,
              line: a.lineNumber ?? null,
              isin: a.symbol ?? null,
            }),
            // SDK 3.1.0+ types these properly — no cast needed.
            idempotencyKey: idemKey,
            sourceSystem: "TR_PDF",
            sourceRecordId: idemKey,
          } satisfies ActivityCreate;
          await ctx.api.activities.create(createPayload);
          imported += 1;
        } catch (err) {
          failures += 1;
          const errAny = err as { message?: unknown } | string | null | undefined;
          const rawMsg =
            typeof errAny === "string"
              ? errAny
              : typeof errAny === "object" && errAny !== null && typeof errAny.message === "string"
                ? errAny.message
                : String(err);
          const msg = rawMsg || "(empty error)";
          if (failures <= 10) {
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

      setImportState({
        status: "done",
        imported,
        skipped: failures,
        failureExamples: failures > 0 ? failureExamples : undefined,
      });

      // Fire-and-forget post-import sync chain.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const market = (ctx.api as any).market;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const portfolio = (ctx.api as any).portfolio;
        const runRecalc = () => {
          if (portfolio?.recalculate) {
            portfolio
              .recalculate()
              .then(() => ctx.api.logger.info("[TR PDF] portfolio recalculation complete."))
              .catch((err: unknown) =>
                ctx.api.logger.warn(
                  `[TR PDF] portfolio.recalculate() failed (non-fatal): ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
              );
          } else if (portfolio?.update) {
            portfolio.update().catch(() => undefined);
          }
        };
        if (market?.syncHistory) {
          market
            .syncHistory()
            .then(() => runRecalc())
            .catch(() => runRecalc());
        } else {
          runRecalc();
        }
      } catch (err) {
        ctx.api.logger.warn(
          `[TR PDF] could not trigger market/portfolio sync: ${(err as Error).message}`,
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
  }, [ctx, accounts, selectedAccountId, state]);

  // ─── Holdings audit (manual reconciliation) ───────────────────────────
  const loadDbHoldings = React.useCallback(async () => {
    if (!selectedAccountId) return;
    setHoldingsLoading(true);
    try {
      const dbActivities = await ctx.api.activities.getAll(selectedAccountId);
      // Aggregate net qty by symbol, applying SPLIT factors.
      const bySymbol = new Map<
        string,
        {
          qty: number;
          name: string;
          assetId: string | null;
          splits: { date: string; factor: number }[];
        }
      >();
      // First pass: collect splits per symbol.
      for (const a of dbActivities) {
        if (a.activityType !== "SPLIT") continue;
        const sym = a.assetSymbol || "";
        if (!sym) continue;
        const factor = parseFloat(String(a.amount ?? 0));
        if (!Number.isFinite(factor) || factor <= 0) continue;
        const date = String(a.date ?? "").slice(0, 10);
        if (!bySymbol.has(sym)) {
          bySymbol.set(sym, { qty: 0, name: "", assetId: a.assetId ?? null, splits: [] });
        }
        bySymbol.get(sym)!.splits.push({ date, factor });
      }
      // Second pass: BUY/SELL with split factor applied to pre-split qty.
      for (const a of dbActivities) {
        if (a.activityType !== "BUY" && a.activityType !== "SELL") continue;
        const sym = a.assetSymbol || "";
        if (!sym) continue;
        const qty = parseFloat(String(a.quantity ?? 0));
        if (!Number.isFinite(qty) || qty === 0) continue;
        const date = String(a.date ?? "").slice(0, 10);
        const entry = bySymbol.get(sym) ?? {
          qty: 0,
          name: "",
          assetId: a.assetId ?? null,
          splits: [],
        };
        // Multiply by all splits dated AFTER this activity.
        let effQty = qty;
        for (const s of entry.splits) {
          if (s.date > date) effQty *= s.factor;
        }
        entry.qty += a.activityType === "BUY" ? effQty : -effQty;
        if (!entry.assetId && a.assetId) entry.assetId = a.assetId;
        bySymbol.set(sym, entry);
      }
      // (v2.16.1) Pull canonical asset names from Donkeyfolio's assets API.
      // The agent's first version only had the PDF-parsed names indexed
      // by ISIN, but most holdings show as `display_code` ("AAPL", "AMD")
      // not by ISIN — so the lookup missed and we showed the ticker as
      // the name. Use the assets API as the primary name source.
      const assetNameById = new Map<string, string>();
      const assetNameBySymbol = new Map<string, string>();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const assets: Array<any> = await (ctx.api as any).assets.getAll();
        for (const a of assets) {
          if (a?.name) {
            if (a.id) assetNameById.set(a.id, a.name);
            const candidates = [a.displayCode, a.instrumentSymbol, a.symbol].filter(Boolean);
            for (const c of candidates) assetNameBySymbol.set(String(c), a.name);
          }
        }
      } catch {
        // ignore — fall back to parsed PDF names
      }
      const tradingNameByIsin = new Map<string, string>();
      for (const t of state.trading) {
        if (t.isin) tradingNameByIsin.set(t.isin, t.cleanStockName || t.stockName);
      }
      const holdings: DbHolding[] = [];
      for (const [sym, v] of bySymbol.entries()) {
        if (Math.abs(v.qty) < 1e-6) continue; // skip closed positions
        const name =
          (v.assetId && assetNameById.get(v.assetId)) ||
          assetNameBySymbol.get(sym) ||
          tradingNameByIsin.get(sym) ||
          sym;
        holdings.push({ symbol: sym, name, qty: v.qty, assetId: v.assetId });
      }
      holdings.sort((a, b) => a.symbol.localeCompare(b.symbol));
      setDbHoldings(holdings);
    } catch (err) {
      ctx.api.logger.warn(`[TR PDF] failed to load DB holdings: ${(err as Error).message}`);
    } finally {
      setHoldingsLoading(false);
    }
  }, [ctx, selectedAccountId, state.trading]);

  // After import completes, load holdings for the audit panel.
  React.useEffect(() => {
    if (importState.status === "done" && selectedAccountId) {
      void loadDbHoldings();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importState.status]);

  const handleApplyReconcile = React.useCallback(
    async (holding: DbHolding) => {
      const raw = trQtyInputs[holding.symbol] ?? "";
      const trQty = parseFloat(raw.replace(",", "."));
      if (!Number.isFinite(trQty) || trQty <= 0) {
        setReconcileMessages((m) => ({
          ...m,
          [holding.symbol]: "Enter a positive quantity from your TR app.",
        }));
        return;
      }
      if (Math.abs(holding.qty) < 1e-6) {
        setReconcileMessages((m) => ({
          ...m,
          [holding.symbol]: "DB qty is zero — can't compute ratio.",
        }));
        return;
      }
      const ratio = trQty / holding.qty;
      if (!Number.isFinite(ratio) || ratio <= 0) {
        setReconcileMessages((m) => ({
          ...m,
          [holding.symbol]: "Computed ratio is invalid.",
        }));
        return;
      }
      const acct = accounts.find((a) => a.id === selectedAccountId);
      if (!acct) return;
      setReconcilePending(holding.symbol);
      setReconcileMessages((m) => ({ ...m, [holding.symbol]: "" }));
      try {
        // SPLIT activity: Rust core reads `amount` as the ratio. Date = today
        // so the ratio applies to ALL prior activities for this asset.
        const today = new Date().toISOString();
        await ctx.api.activities.create({
          accountId: acct.id,
          activityType: "SPLIT",
          activityDate: today,
          symbol: { symbol: holding.symbol, name: holding.name },
          quantity: 0,
          unitPrice: 0,
          amount: ratio,
          currency: acct.currency,
          fee: 0,
          comment: `TR PDF v2.16.0 manual reconcile: TR ${trQty} / DB ${holding.qty.toFixed(6)} = ratio ${ratio.toFixed(4)}`,
        });
        setReconcileMessages((m) => ({
          ...m,
          [holding.symbol]: `Applied ratio ${ratio.toFixed(4)} — recalculate history to refresh.`,
        }));
        // Refresh holdings + portfolio so DB qty updates.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const portfolio = (ctx.api as any).portfolio;
        if (portfolio?.recalculate) {
          portfolio.recalculate().catch(() => undefined);
        }
        await loadDbHoldings();
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        ctx.api.logger.warn(`[TR PDF] manual reconcile failed for ${holding.symbol}: ${m}`);
        setReconcileMessages((mm) => ({ ...mm, [holding.symbol]: `Failed: ${m}` }));
      } finally {
        setReconcilePending(null);
      }
    },
    [accounts, ctx, loadDbHoldings, selectedAccountId, trQtyInputs],
  );

  const handleRebuildHistory = React.useCallback(async () => {
    setRebuildingHistory(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const portfolio = (ctx.api as any).portfolio;
      if (portfolio?.recalculate) {
        await portfolio.recalculate();
      }
    } catch (err) {
      ctx.api.logger.warn(`[TR PDF] rebuild history failed: ${(err as Error).message}`);
    } finally {
      setRebuildingHistory(false);
    }
  }, [ctx]);

  // ─── Watcher lifecycle ────────────────────────────────────────────────
  const runWatcher = React.useCallback(async () => {
    if (!selectedAccountId) return;
    if (!watcherSettings.autoCheckSplits) return;
    setWatcherScanning(true);
    setWatcherProgress({ done: 0, total: 0 });
    try {
      const dbActivities = await ctx.api.activities.getAll(selectedAccountId);
      const findings = await runWatcherScan({
        dbActivities: dbActivities.map((a) => ({
          id: a.id,
          activityType: a.activityType,
          quantity: a.quantity,
          amount: a.amount,
          unitPrice: a.unitPrice,
          assetSymbol: a.assetSymbol,
          assetId: a.assetId,
          comment: a.comment,
          date: a.date,
        })),
        settings: watcherSettings,
        onProgress: (done, total) => setWatcherProgress({ done, total }),
      });
      setWatcherFindings(findings);
      ctx.api.logger.info(
        `[TR PDF watcher] scan: ${findings.splits.length} splits, ${findings.tickerMigrations.length} migrations, ${findings.dripGaps.length} drip gaps.`,
      );
      if (watcherSettings.autoApplySplits && findings.splits.length > 0) {
        const acct = accounts.find((a) => a.id === selectedAccountId);
        const ccy = acct?.currency || "EUR";
        for (const s of findings.splits) {
          try {
            const factor = s.numerator / s.denominator;
            await ctx.api.activities.create({
              accountId: selectedAccountId,
              activityType: "SPLIT",
              activityDate: s.date,
              symbol: { symbol: s.ticker, name: s.name },
              quantity: 0,
              unitPrice: 0,
              amount: factor,
              currency: ccy,
              fee: 0,
              comment: `TR PDF v2.16.0 watcher — auto-applied ${s.ratio} split (${s.date}).`,
            });
            writeLastAppliedSplit(s.ticker, s.date);
          } catch (err) {
            ctx.api.logger.warn(
              `[TR PDF watcher] auto-apply failed for ${s.ticker} ${s.date}: ${
                (err as Error).message
              }`,
            );
          }
        }
      }
    } catch (err) {
      ctx.api.logger.warn(`[TR PDF watcher] scan failed: ${(err as Error).message}`);
    } finally {
      setWatcherScanning(false);
    }
  }, [accounts, ctx, selectedAccountId, watcherSettings]);

  React.useEffect(() => {
    if (!selectedAccountId) return;
    if (!watcherSettings.autoCheckSplits) return;
    let cancelled = false;
    const initialDelay = 30_000;
    const dayMs = 24 * 60 * 60 * 1000;
    const lastScan = loadLastFullScan();
    const dueImmediately = Date.now() - lastScan > dayMs;
    const t1 = setTimeout(
      () => {
        if (cancelled) return;
        if (dueImmediately) void runWatcher();
      },
      dueImmediately ? initialDelay : 1_000,
    );
    const interval = setInterval(() => {
      if (!cancelled) void runWatcher();
    }, dayMs);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearInterval(interval);
    };
  }, [ctx, runWatcher, selectedAccountId, watcherSettings.autoCheckSplits]);

  const handleWatcherSettingsChange = React.useCallback((next: WatcherSettings) => {
    setWatcherSettings(next);
    saveSettings(next);
  }, []);

  const watcherPendingCount = countPending(watcherFindings);
  const watcherLastScan = loadLastFullScan();

  const reset = () => {
    setState(initialState);
    setImportState({ status: "idle" });
    setDbHoldings([]);
    setTrQtyInputs({});
    setReconcileMessages({});
  };

  // ─── Phase progress ───────────────────────────────────────────────────
  const phaseProgress = (() => {
    if (state.status !== "parsing") return 0;
    switch (state.phase) {
      case "reading":
        return 5;
      case "parsing":
        if (state.progress && state.progress.total > 0) {
          return 10 + (state.progress.page / state.progress.total) * 60;
        }
        return 30;
      case "resolving-crypto":
        return 75;
      case "discovering-tickers":
        return 82;
      case "detecting-splits":
        return 90;
      case "building":
        return 96;
      default:
        return 0;
    }
  })();

  // Match the post-import preferred tab.
  const isImported = importState.status === "done";

  // ─── RENDER ───────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trade Republic PDF Converter</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Drop a TR PDF, review issues, import. Manual reconciliation finishes the job.
          </p>
        </div>
        {state.status === "done" && (
          <Button variant="outline" size="sm" onClick={reset}>
            <Icons.RefreshCw className="mr-2 h-4 w-4" />
            Import another PDF
          </Button>
        )}
      </div>

      {/* ─── STATE 1: Empty (idle / error) ─── */}
      {(state.status === "idle" || state.status === "error") && (
        <>
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
                className={`group flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-8 py-16 transition ${
                  dragOver
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50 hover:bg-muted/40"
                }`}
              >
                <div className="bg-muted group-hover:bg-primary/10 flex h-14 w-14 items-center justify-center rounded-full transition">
                  <Icons.Upload className="text-muted-foreground group-hover:text-primary h-7 w-7 transition" />
                </div>
                <div className="text-center">
                  <p className="text-base font-semibold">Drop a Trade Republic PDF</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    or click to choose · 100% local · no upload
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

          {state.status === "error" && (
            <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
              <CardContent className="flex items-start gap-2 pt-4 text-sm text-red-800 dark:text-red-300">
                <Icons.AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{state.message}</span>
              </CardContent>
            </Card>
          )}

          {/* Self-healing watcher — collapsed when nothing pending. */}
          {selectedAccountId && (
            <WatcherSummaryCard
              pendingCount={watcherPendingCount}
              scanning={watcherScanning}
              lastScan={watcherLastScan}
              open={watcherOpen || watcherPendingCount > 0}
              onOpenChange={setWatcherOpen}
            >
              <WatcherPanel
                ctx={ctx}
                findings={watcherFindings}
                scanning={watcherScanning}
                scanProgress={watcherProgress}
                settings={watcherSettings}
                onSettingsChange={handleWatcherSettingsChange}
                onRunNow={runWatcher}
                onAfterApply={runWatcher}
                accountId={selectedAccountId}
                accountCurrency={selectedAccount?.currency || "EUR"}
              />
            </WatcherSummaryCard>
          )}
        </>
      )}

      {/* ─── STATE 2: Parsing ─── */}
      {state.status === "parsing" && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Icons.Spinner className="h-4 w-4 animate-spin" />
                {state.message || "Working…"}
              </CardTitle>
              <CardDescription>{state.fileName}</CardDescription>
            </CardHeader>
            <CardContent>
              <Progress value={phaseProgress} className="h-2" />
            </CardContent>
          </Card>
          <div className="grid grid-cols-3 gap-3">
            <SkeletonTile />
            <SkeletonTile />
            <SkeletonTile />
          </div>
        </>
      )}

      {/* ─── STATE 3 & 5: Done parse → ready to import / imported ─── */}
      {state.status === "done" && (
        <>
          {/* Account picker (compact). */}
          <Card>
            <CardContent className="flex flex-wrap items-end gap-3 pt-6 text-sm">
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
                  disabled={importState.status === "running" || !accountsLoaded || creatingAccount}
                  className="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">
                    {accountsLoaded
                      ? accounts.length === 0
                        ? "No accounts found — create one →"
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
                    Create TR account
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* ─── Ready-to-import card (pre-import only) ─── */}
          {!isImported && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ready to import</CardTitle>
                <CardDescription>{state.fileName} · all checks ran automatically</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                {/* KPI tiles */}
                <div className="grid grid-cols-3 gap-3">
                  <KpiTile
                    label="Cash transactions"
                    value={cashCount.toLocaleString("en-US")}
                    icon={<Icons.CreditCard className="h-4 w-4" />}
                  />
                  <KpiTile
                    label="Trades"
                    value={tradingCount.toLocaleString("en-US")}
                    icon={<Icons.TrendingUp className="h-4 w-4" />}
                  />
                  <KpiTile
                    label="Net (sold − bought)"
                    value={state.pnl ? formatEur(netPnl) : "—"}
                    tone={netPnl >= 0 ? "positive" : "negative"}
                    icon={<Icons.DollarSign className="h-4 w-4" />}
                  />
                </div>

                {/* Cash reconciliation summary */}
                {pdfEnding != null && (
                  <div className="bg-muted/40 flex items-start gap-2 rounded-md border p-3 text-xs">
                    <Icons.CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                    <span>
                      PDF says <strong>{formatEur(pdfEnding)}</strong> ending balance — we'll match
                      it exactly via auto-reconciliation activity.
                    </span>
                  </div>
                )}

                {/* Issues panel */}
                {issuesCount > 0 ? (
                  <Collapsible open={issuesOpen} onOpenChange={setIssuesOpen}>
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/60"
                      >
                        {issuesOpen ? (
                          <Icons.ChevronDown className="mr-2 h-4 w-4" />
                        ) : (
                          <Icons.ChevronRight className="mr-2 h-4 w-4" />
                        )}
                        <Icons.AlertCircle className="mr-2 h-4 w-4" />
                        {issuesCount} issue{issuesCount === 1 ? "" : "s"} to review
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-3 space-y-2">
                      {/* Unmapped securities */}
                      {unmappedSecurities.length > 0 && (
                        <div className="rounded-md border p-3 text-xs">
                          <div className="mb-2 flex items-center gap-2 font-medium">
                            <Icons.AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                            {unmappedSecurities.length} unmapped securit
                            {unmappedSecurities.length === 1 ? "y" : "ies"}
                          </div>
                          <p className="text-muted-foreground mb-2">
                            These import correctly (cost basis preserved) but Yahoo may not price
                            them automatically. Lookup the ticker and report it for inclusion.
                          </p>
                          <div className="overflow-auto">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Stock</TableHead>
                                  <TableHead>ISIN</TableHead>
                                  <TableHead>WKN</TableHead>
                                  <TableHead className="text-right">Spent</TableHead>
                                  <TableHead>Action</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {unmappedSecurities.map((s) => (
                                  <TableRow key={s.isin}>
                                    <TableCell
                                      className="max-w-[260px] truncate"
                                      title={s.stockName}
                                    >
                                      {s.stockName}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">{s.isin}</TableCell>
                                    <TableCell className="text-muted-foreground font-mono text-xs">
                                      {s.wkn || "—"}
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
                        </div>
                      )}

                      {/* Detected splits */}
                      {state.autoSplits.length > 0 && (
                        <div className="rounded-md border p-3 text-xs">
                          <div className="mb-2 flex items-center gap-2 font-medium">
                            <Icons.AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                            {state.autoSplits.length} stock split
                            {state.autoSplits.length === 1 ? "" : "s"} detected
                          </div>
                          <p className="text-muted-foreground mb-2">
                            SPLIT activities will be created automatically on import — pre-split BUY
                            quantities scale to today's share count.
                          </p>
                          <div className="overflow-auto">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Stock</TableHead>
                                  <TableHead>Ticker</TableHead>
                                  <TableHead>Date</TableHead>
                                  <TableHead className="text-right">Ratio</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {state.autoSplits.map((s, i) => (
                                  <TableRow key={`${s.isin}-${s.date}-${i}`}>
                                    <TableCell
                                      className="max-w-[260px] truncate"
                                      title={s.stockName}
                                    >
                                      {s.stockName}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">{s.ticker}</TableCell>
                                    <TableCell className="font-mono text-xs">{s.date}</TableCell>
                                    <TableCell className="text-right font-mono">
                                      <Badge variant="outline" className="text-xs">
                                        {s.ratio}
                                      </Badge>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      )}

                      {/* Crypto resolved */}
                      {state.cryptoResolved > 0 && (
                        <div className="flex items-start gap-2 rounded-md border p-3 text-xs">
                          <Icons.CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                          <span>
                            <strong>{state.cryptoResolved}</strong> crypto Compra direta trade
                            {state.cryptoResolved === 1 ? "" : "s"} resolved via DB cache — qty
                            computed from cached daily closes.
                          </span>
                        </div>
                      )}

                      {/* Parser drift */}
                      {parserDriftEur > 50 && (
                        <div className="flex items-start gap-2 rounded-md border p-3 text-xs">
                          <Icons.CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                          <span>
                            Parser drift <strong>{formatEur(parserDriftEur)}</strong> detected —
                            auto-reconciliation activity will close it on import.
                          </span>
                        </div>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-300">
                    <Icons.CheckCircle className="h-4 w-4" />
                    No issues — clean import.
                  </div>
                )}

                {selectedAccount && selectedAccount.trackingMode !== "TRANSACTIONS" && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    ⚠ Account uses trackingMode <code>{selectedAccount.trackingMode}</code>. Set it
                    to <strong>Transactions</strong> in Donkeyfolio account settings before
                    importing.
                  </p>
                )}

                {/* (v2.19.7) Removed Crypto Reconciliation + Manual Holdings
                    panel — user reported the staking/spin-off rows are easier
                    to add by hand directly in Donkeyfolio after import. The
                    addon now goes straight from "ready" to "import". */}

                {/* Big import button */}
                <div className="pt-2">
                  <Button
                    onClick={handleImport}
                    disabled={
                      importState.status === "running" || !selectedAccountId || !accountsLoaded
                    }
                    size="lg"
                    className="w-full bg-green-600 text-white hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-800"
                  >
                    {importState.status === "running" ? (
                      <>
                        <Icons.Spinner className="mr-2 h-5 w-5 animate-spin" />
                        Importing…
                      </>
                    ) : (
                      <>
                        <Icons.Download className="mr-2 h-5 w-5" />
                        Import to Donkeyfolio
                      </>
                    )}
                  </Button>
                </div>

                {/* STATE 4: Importing — progress */}
                {importState.status === "running" && (
                  <div className="space-y-2 text-xs">
                    <p className="text-muted-foreground">{importState.message}</p>
                    {importState.progress && importState.progress.total > 0 && (
                      <Progress
                        value={(importState.progress.done / importState.progress.total) * 100}
                        className="h-2"
                      />
                    )}
                  </div>
                )}
                {importState.status === "error" && (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                    <Icons.AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{importState.message}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ─── STATE 5: Imported (success) ─── */}
          {isImported && importState.status === "done" && (
            <>
              <Card className="border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/20">
                <CardContent className="space-y-3 pt-6 text-sm">
                  <div className="flex items-center gap-2 text-green-800 dark:text-green-200">
                    <Icons.CheckCircle className="h-5 w-5 shrink-0" />
                    <span className="text-base font-semibold">
                      Imported {importState.imported} activities
                      {importState.skipped > 0 ? ` · ${importState.skipped} skipped` : ""}
                    </span>
                  </div>
                  {importState.failureExamples && importState.failureExamples.length > 0 && (
                    <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
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
                </CardContent>
              </Card>

              {/* Holdings audit / manual reconciliation */}
              <Card>
                <CardHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-base">Holdings audit</CardTitle>
                      <CardDescription>
                        Compare DB qty against what your TR app shows. Type the TR qty for any
                        holding that drifts and click Apply — a SPLIT activity is emitted to align
                        Donkeyfolio with TR.
                      </CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadDbHoldings}
                      disabled={holdingsLoading}
                    >
                      {holdingsLoading ? (
                        <>
                          <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                          Loading…
                        </>
                      ) : (
                        <>
                          <Icons.RefreshCw className="mr-2 h-4 w-4" />
                          Refresh
                        </>
                      )}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {dbHoldings.length === 0 && !holdingsLoading && (
                    <p className="text-muted-foreground text-xs">
                      No open holdings found in DB for this account.
                    </p>
                  )}
                  {dbHoldings.length > 0 && (
                    <div className="overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Ticker</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead className="text-right">DB qty</TableHead>
                            <TableHead className="w-[160px]">TR app qty</TableHead>
                            <TableHead className="text-right">Drift</TableHead>
                            <TableHead className="w-[140px]">Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {dbHoldings.map((h) => {
                            const raw = trQtyInputs[h.symbol] ?? "";
                            const trQty = parseFloat(raw.replace(",", "."));
                            const drift =
                              Number.isFinite(trQty) && trQty > 0 ? trQty - h.qty : null;
                            const driftPct =
                              drift != null && h.qty !== 0 ? Math.abs(drift / h.qty) : 0;
                            const msg = reconcileMessages[h.symbol];
                            return (
                              <TableRow key={h.symbol}>
                                <TableCell className="font-mono text-xs">{h.symbol}</TableCell>
                                <TableCell className="max-w-[260px] truncate" title={h.name}>
                                  {h.name}
                                </TableCell>
                                <TableCell className="text-right font-mono">
                                  {formatQty(h.qty)}
                                </TableCell>
                                <TableCell>
                                  <Input
                                    value={raw}
                                    onChange={(e) =>
                                      setTrQtyInputs((m) => ({
                                        ...m,
                                        [h.symbol]: e.target.value,
                                      }))
                                    }
                                    placeholder="—"
                                    className="h-8 font-mono text-xs"
                                    inputMode="decimal"
                                  />
                                </TableCell>
                                <TableCell
                                  className={`text-right font-mono text-xs ${
                                    drift == null
                                      ? "text-muted-foreground"
                                      : Math.abs(drift) < 1e-6
                                        ? "text-green-600 dark:text-green-400"
                                        : driftPct >= 0.01
                                          ? "text-red-600 dark:text-red-400"
                                          : "text-amber-600 dark:text-amber-400"
                                  }`}
                                >
                                  {drift == null
                                    ? "—"
                                    : `${drift > 0 ? "+" : ""}${formatQty(drift)}`}
                                </TableCell>
                                <TableCell>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={
                                      reconcilePending === h.symbol ||
                                      drift == null ||
                                      Math.abs(drift) < 1e-6
                                    }
                                    onClick={() => handleApplyReconcile(h)}
                                  >
                                    {reconcilePending === h.symbol ? (
                                      <>
                                        <Icons.Spinner className="mr-1 h-3 w-3 animate-spin" />…
                                      </>
                                    ) : (
                                      "Apply fix"
                                    )}
                                  </Button>
                                  {msg && (
                                    <p className="text-muted-foreground mt-1 text-[10px]">{msg}</p>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRebuildHistory}
                      disabled={rebuildingHistory}
                    >
                      {rebuildingHistory ? (
                        <>
                          <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                          Rebuilding…
                        </>
                      ) : (
                        <>
                          <Icons.RefreshCw className="mr-2 h-4 w-4" />
                          Rebuild History
                        </>
                      )}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={reset}>
                      <Icons.Plus className="mr-2 h-4 w-4" />
                      Import another PDF
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Watcher (post-import). */}
              {selectedAccountId && (
                <WatcherSummaryCard
                  pendingCount={watcherPendingCount}
                  scanning={watcherScanning}
                  lastScan={watcherLastScan}
                  open={watcherOpen || watcherPendingCount > 0}
                  onOpenChange={setWatcherOpen}
                >
                  <WatcherPanel
                    ctx={ctx}
                    findings={watcherFindings}
                    scanning={watcherScanning}
                    scanProgress={watcherProgress}
                    settings={watcherSettings}
                    onSettingsChange={handleWatcherSettingsChange}
                    onRunNow={runWatcher}
                    onAfterApply={runWatcher}
                    accountId={selectedAccountId}
                    accountCurrency={selectedAccount?.currency || "EUR"}
                  />
                </WatcherSummaryCard>
              )}
            </>
          )}

          {/* Show parsed details (collapsed). */}
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground -ml-2">
                {detailsOpen ? (
                  <Icons.ChevronDown className="mr-2 h-4 w-4" />
                ) : (
                  <Icons.ChevronRight className="mr-2 h-4 w-4" />
                )}
                {detailsOpen ? "Hide" : "Show"} parsed details ({cashCount} cash · {tradingCount}{" "}
                trades · {state.interest.length} MMF)
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-1 border-b">
                {(["cash", "trading", "mmf"] as const).map((t) =>
                  (t === "cash" && cashCount === 0) ||
                  (t === "trading" && tradingCount === 0) ||
                  (t === "mmf" && state.interest.length === 0) ? null : (
                    <button
                      key={t}
                      onClick={() => setActiveDetailsTab(t)}
                      className={`border-b-2 px-3 py-2 text-xs font-medium transition ${
                        activeDetailsTab === t
                          ? "border-primary text-foreground"
                          : "text-muted-foreground hover:text-foreground border-transparent"
                      }`}
                    >
                      {t === "cash"
                        ? `Cash (${cashCount})`
                        : t === "trading"
                          ? `Trading (${tradingCount})`
                          : `MMF (${state.interest.length})`}
                    </button>
                  ),
                )}
              </div>
              {activeDetailsTab === "cash" && cashCount > 0 && <CashTable rows={state.cash} />}
              {activeDetailsTab === "trading" && state.pnl && <TradingTable pnl={state.pnl} />}
              {activeDetailsTab === "mmf" && state.interest.length > 0 && (
                <InterestTable rows={state.interest} />
              )}
            </CollapsibleContent>
          </Collapsible>
        </>
      )}

      {/* Footer credit */}
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
        </a>
        .
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
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
    <div className="bg-muted/40 rounded-md border p-3">
      <div className="text-muted-foreground flex items-center justify-between text-xs font-medium">
        <span>{label}</span>
        {icon}
      </div>
      <div className={`mt-1 text-xl font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}

function SkeletonTile() {
  return (
    <div className="bg-muted/40 animate-pulse rounded-md border p-3">
      <div className="bg-muted h-3 w-1/2 rounded" />
      <div className="bg-muted mt-3 h-6 w-3/4 rounded" />
    </div>
  );
}

function WatcherSummaryCard({
  pendingCount,
  scanning,
  lastScan,
  open,
  onOpenChange,
  children,
}: {
  pendingCount: number;
  scanning: boolean;
  lastScan: number;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  children: React.ReactNode;
}) {
  const lastScanLabel =
    lastScan > 0 ? `${Math.round((Date.now() - lastScan) / 3600_000)}h ago` : "never";
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardContent className="flex cursor-pointer items-center justify-between gap-3 pb-4 pt-4 text-sm">
            <div className="flex items-center gap-2">
              {scanning ? (
                <Icons.Spinner className="h-4 w-4 animate-spin" />
              ) : pendingCount > 0 ? (
                <Icons.AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              ) : (
                <Icons.CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
              )}
              <span className="font-medium">Self-healing watcher</span>
              <span className="text-muted-foreground text-xs">
                · last scan {lastScanLabel}
                {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
              </span>
            </div>
            {open ? (
              <Icons.ChevronDown className="h-4 w-4" />
            ) : (
              <Icons.ChevronRight className="h-4 w-4" />
            )}
          </CardContent>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t p-4">{children}</div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function CashTable({ rows }: { rows: CashTransaction[] }) {
  // (v2.19.4) Default view is a SUMMARY of cash totals per type — TR's full
  // cash log (4000+ rows) is overwhelming and not useful per-row. The
  // interesting numbers are the cumulative buckets: deposits, dividends,
  // interest, etc. Toggle "Show all" still exposes the raw detail.
  const [showAll, setShowAll] = React.useState(false);
  const isTrade = (r: CashTransaction) =>
    (r.typ || "").toLowerCase().trim() === "trade" ||
    (r.typ || "").toLowerCase().trim() === "handel" ||
    (r.typ || "").toLowerCase().trim() === "operar";
  const filtered = showAll ? rows : rows.filter((r) => !isTrade(r));
  const tradeCount = rows.length - rows.filter((r) => !isTrade(r)).length;

  // Compute totals per cash type (excluding trades).
  const summary = React.useMemo(() => {
    const buckets = new Map<string, { count: number; in: number; out: number }>();
    const parseEur = (s: string) => {
      if (!s) return 0;
      const cleaned = s.replace(/[€\s]/g, "").replace(/\./g, "").replace(",", ".");
      const n = parseFloat(cleaned);
      return Number.isFinite(n) ? n : 0;
    };
    for (const r of rows) {
      if (isTrade(r)) continue;
      const t = (r.typ || "Other").trim();
      const b = buckets.get(t) ?? { count: 0, in: 0, out: 0 };
      b.count += 1;
      b.in += parseEur(r.zahlungseingang);
      b.out += parseEur(r.zahlungsausgang);
      buckets.set(t, b);
    }
    return buckets;
  }, [rows]);
  const totalIn = Array.from(summary.values()).reduce((s, b) => s + b.in, 0);
  const totalOut = Array.from(summary.values()).reduce((s, b) => s + b.out, 0);

  // Extract structured fields from the raw description for display columns.
  // The PDF crams ISIN/qty/name/etc. into one beschreibung string — this
  // pulls them apart so each datum gets its own column.
  const parseRow = (r: CashTransaction) => {
    const desc = r.beschreibung || "";
    const isinMatch = desc.match(/\b([A-Z]{2}[A-Z0-9]{10}|XF000[A-Z0-9]{6,7})\b/);
    const isin = isinMatch ? isinMatch[1] : "";
    // Origin = ISO country code from the first 2 chars of a real ISIN.
    // XF000 is TR's pseudo-ISIN for crypto — show as "Crypto".
    let origin = "";
    if (isin) {
      origin = isin.startsWith("XF000") ? "Crypto" : isin.slice(0, 2);
    }
    const qtyMatch = desc.match(
      /(?:quantity|quantidade|qtd|stück|stueck|stk|anzahl|cantidad|quantità|pezzi)\.?\s*:\s*([\d.,]+)/i,
    );
    const quantity = qtyMatch ? qtyMatch[1] : "";
    return { isin, origin, quantity };
  };

  return (
    <Card>
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          {showAll
            ? `Showing all ${rows.length} raw cash rows (incl. trades)`
            : `Cash flow summary by type · ${rows.length} total rows · ${tradeCount} trades`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAll((v) => !v)}
          className="h-6 text-xs"
        >
          {showAll ? "Hide raw" : "Show raw"}
        </Button>
      </div>

      {!showAll && (
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">Total In</TableHead>
                <TableHead className="text-right">Total Out</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">Currency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from(summary.entries())
                .sort((a, b) => Math.abs(b[1].in - b[1].out) - Math.abs(a[1].in - a[1].out))
                .map(([typ, b]) => {
                  const net = b.in - b.out;
                  return (
                    <TableRow key={typ}>
                      <TableCell className="font-medium">{typ}</TableCell>
                      <TableCell className="text-right font-mono">{b.count}</TableCell>
                      <TableCell className="text-right font-mono text-green-600 dark:text-green-400">
                        {b.in > 0 ? formatEur(b.in) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-red-600 dark:text-red-400">
                        {b.out > 0 ? formatEur(b.out) : "—"}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono ${
                          net >= 0
                            ? "text-green-600 dark:text-green-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {net >= 0 ? "+" : ""}
                        {formatEur(net)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">EUR</TableCell>
                    </TableRow>
                  );
                })}
              <TableRow className="bg-muted/30 font-bold">
                <TableCell>TOTAL (non-trade)</TableCell>
                <TableCell className="text-right font-mono">{filtered.length}</TableCell>
                <TableCell className="text-right font-mono text-green-600 dark:text-green-400">
                  {formatEur(totalIn)}
                </TableCell>
                <TableCell className="text-right font-mono text-red-600 dark:text-red-400">
                  {formatEur(totalOut)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {totalIn - totalOut >= 0 ? "+" : ""}
                  {formatEur(totalIn - totalOut)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">EUR</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}

      {showAll && (
        <div className="max-h-[480px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead>ISIN</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Currency</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r, i) => {
                const p = parseRow(r);
                return (
                  <TableRow
                    key={i}
                    className={
                      r._sanityCheckOk === false
                        ? "bg-amber-50 dark:bg-amber-950/30"
                        : r._recovered
                          ? "bg-blue-50/60 dark:bg-blue-950/20"
                          : undefined
                    }
                  >
                    <TableCell className="font-mono text-xs">{r.datum}</TableCell>
                    <TableCell>{r.typ}</TableCell>
                    <TableCell className="font-mono text-xs">{p.origin || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{p.isin || "—"}</TableCell>
                    <TableCell className="max-w-md truncate" title={r.beschreibung}>
                      {r.beschreibung}
                    </TableCell>
                    <TableCell className="text-right font-mono">{p.quantity || "—"}</TableCell>
                    <TableCell className="text-right font-mono text-green-600 dark:text-green-400">
                      {r.zahlungseingang || ""}
                    </TableCell>
                    <TableCell className="text-right font-mono text-red-600 dark:text-red-400">
                      {r.zahlungsausgang || ""}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">EUR</TableCell>
                    <TableCell className="text-right font-mono">{r.saldo}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
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
                <TableCell>{r.zahlungsart}</TableCell>
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
      <div className="max-h-[480px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stock</TableHead>
              <TableHead>ISIN</TableHead>
              <TableHead className="text-right">Held</TableHead>
              <TableHead className="text-right">Avg cost</TableHead>
              <TableHead className="text-right">Bought</TableHead>
              <TableHead className="text-right">Sold</TableHead>
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
