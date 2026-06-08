import type { ActivityCreate, AddonContext } from "@wealthfolio/addon-sdk";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
  Page,
  PageContent,
  PageHeader,
  Progress,
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@wealthfolio/ui";
import React from "react";

import { ensureTRAccount } from "../lib/tr-account";
import {
  parseTrCsv,
  summarizeCsv,
  TrCsvParseError,
  type CsvSummary,
  type ParseWarning,
  type TrCsvRow,
} from "../lib/tr-csv-parser";
import {
  mapTrCsvToActivities,
  resolveSplitRatios,
  suggestQuoteCcyOverrides,
  sumActivityCashEffect,
  type MapperNote,
  type MapperResult,
} from "../lib/tr-csv-mapper";
import {
  clearImportHistory,
  loadImportHistory,
  partitionByHistory,
  recordImported,
  type ImportHistory,
} from "../lib/tr-import-history";
import { diagnose, pickDuplicatesToDelete, type DiagnosticsReport } from "../lib/tr-diagnostics";
import { buildSamples, type SdkTestResult } from "../lib/tr-sdk-test";
import { EmptyState } from "../components/empty-state";
import { ExpertPanel } from "../components/expert-panel";
import { EurHoldingsView } from "../components/eur-holdings-view";
import { ReviewAssetsView, type AssetOverride } from "../components/review-assets-view";
import { WizardStepper, type WizardStep } from "../components/wizard-stepper";

/**
 * Top-level tabs (v5.0.0). Each tab is an independent destination — switching
 * tabs preserves state inside each tab. The Import tab holds the wizard
 * (with its own state machine); other tabs are tools.
 */
// v5.2.0: simplified to 3 user-facing tabs. The "holdings" tab now also
// hosts the diagnostics report below the EUR table, and the "expert" tab
// hosts the SDK-test panel below the AI panel. The old IDs are kept as
// internal section anchors so the rest of the state machine doesn't have
// to change.
type TabId = "import" | "holdings" | "expert";

interface Props {
  ctx: AddonContext;
}

interface ParsedData {
  filename: string;
  rows: TrCsvRow[];
  summary: CsvSummary;
  warnings: ParseWarning[];
  mapping: MapperResult;
  history: ImportHistory;
  newRows: TrCsvRow[];
  alreadyImported: TrCsvRow[];
}

interface ErrorInfo {
  origin: "parse" | "import";
  title: string;
  message: string;
  detail?: string;
}

type State =
  | { kind: "empty" }
  | { kind: "parsing"; filename: string }
  | { kind: "parsed"; data: ParsedData }
  | {
      kind: "reviewing_assets";
      data: ParsedData;
      overrides: Map<string, AssetOverride>;
    }
  | {
      kind: "importing";
      data: ParsedData;
      overrides: Map<string, AssetOverride>;
      current: number;
      total: number;
    }
  | {
      kind: "imported";
      count: number;
      activitiesCount: number;
      createdCount: number;
      errors: { action: string; message: string; id?: string }[];
      durationMs: number;
      accountCreated: boolean;
    }
  | { kind: "diagnosing" }
  | { kind: "diagnosed"; report: DiagnosticsReport; cleanupCount?: number }
  | { kind: "sdk_testing"; current: number; total: number }
  | { kind: "sdk_tested"; results: SdkTestResult[]; durationMs: number }
  | { kind: "expert"; lastReport?: DiagnosticsReport }
  | { kind: "eur_view" }
  | { kind: "error"; error: ErrorInfo };

/**
 * CHUNK_SIZE = 50.
 *
 * Why not 200: the Rust backend's `bulk_mutate_activities` runs all
 * inserts inside a SINGLE `exec_tx` transaction (see
 * `crates/storage-sqlite/src/activities/repository.rs:621-742`). When ONE
 * INSERT fails (e.g. duplicate idempotency_key), the `?` operator
 * propagates and rolls back the WHOLE transaction — every other row in
 * the chunk is lost too. The previous v4.x at CHUNK_SIZE=200 silently
 * dropped 200 good rows per 1 bad row.
 *
 * v4.2.3 also implements a bisect-on-failure retry below — when a chunk
 * fails, we split it in half and retry each half until we isolate the
 * bad row(s). 50 keeps the worst-case retry depth manageable
 * (log2(50) ≈ 6 retries vs log2(200) ≈ 8) AND keeps individual chunk
 * latency low.
 */
const CHUNK_SIZE = 50;
const PREVIEW_ACCOUNT_ID = "tr-preview";

function describeError(err: unknown): { message: string; detail?: string } {
  if (err instanceof Error) {
    const message = err.message || err.name || "Erro sem mensagem";
    return { message, detail: err.stack };
  }
  if (typeof err === "string") return { message: err };
  if (err && typeof err === "object") {
    try {
      return { message: JSON.stringify(err) };
    } catch {
      return { message: "Non-serialisable error" };
    }
  }
  return { message: String(err ?? "Erro desconhecido") };
}

export default function TrImporterPage({ ctx }: Props): React.JSX.Element {
  const [state, setState] = React.useState<State>({ kind: "empty" });
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // v5.0.0 — top-level tab. Drives which destination is rendered.
  // The state machine still lives in `state`, but it now models the
  // *contents* of each tab rather than the page-level navigation.
  const [currentTab, setCurrentTab] = React.useState<TabId>("import");

  // Confirmation dialog state for "leaving an in-progress wizard step".
  const [pendingTab, setPendingTab] = React.useState<TabId | null>(null);

  // v5.1.0 — AbortController for the import loop. Lets the user cancel a
  // long-running import without killing the addon. Successfully-inserted
  // chunks already in the DB are kept (they're real user data) and their
  // tx_ids are recorded in history so a re-import skips them.
  const abortRef = React.useRef<AbortController | null>(null);

  const handleFile = React.useCallback(async (file: File) => {
    setState({ kind: "parsing", filename: file.name });
    try {
      const text = await file.text();
      const { rows, warnings } = parseTrCsv(text);
      const summary = summarizeCsv(rows);
      const history = loadImportHistory();
      const { newRows, alreadyImported } = partitionByHistory(rows, history);
      const mapping = mapTrCsvToActivities(newRows, { accountId: PREVIEW_ACCOUNT_ID });
      resolveSplitRatios(newRows, mapping.activities, mapping.notes);
      setState({
        kind: "parsed",
        data: {
          filename: file.name,
          rows,
          summary,
          warnings,
          mapping,
          history,
          newRows,
          alreadyImported,
        },
      });
    } catch (err) {
      const { message, detail } = describeError(err);
      setState({
        kind: "error",
        error: {
          origin: "parse",
          title:
            err instanceof TrCsvParseError
              ? "Could not parse the CSV"
              : "Failed to process the file",
          message,
          detail,
        },
      });
    }
  }, []);

  const handleDrop = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleImport = React.useCallback(async () => {
    if (state.kind !== "reviewing_assets") return;
    const data = state.data;
    const overrides = state.overrides;
    if (data.newRows.length === 0) return;

    const startedAt = Date.now();
    let stepLabel = "preparing account";
    // Fresh AbortController per import — cancels at the next chunk boundary.
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      stepLabel = "find or create TR account";
      const account = await ensureTRAccount(ctx);

      stepLabel = "remap with real accountId";
      const mapping = mapTrCsvToActivities(data.newRows, { accountId: account.accountId });
      resolveSplitRatios(data.newRows, mapping.activities, mapping.notes);

      // Apply per-asset quoteCcy overrides chosen in Review Assets step.
      if (overrides.size > 0) {
        stepLabel = "apply quoteCcy overrides";
        applyAssetOverrides(mapping, overrides);
      }

      const total = mapping.activities.length;
      let current = 0;
      let createdCount = 0;
      const allErrors: { action: string; message: string; id?: string }[] = [];
      const successfulTxIds: string[] = [];
      setState({ kind: "importing", data, overrides, current, total });

      // Bisect-on-failure: when a chunk's transaction aborts (1 bad row
      // kills 50), we split it in half and retry each half until we isolate
      // the bad row to size 1. The bad row's error is captured; all other
      // rows succeed.
      type ChunkResult = {
        created: number;
        errors: { action: string; message: string; id?: string }[];
        successfulTxIds: string[];
      };

      const collectTxIds = (sourceChunk: ActivityCreate[], createdN: number): string[] => {
        const ids: string[] = [];
        for (let j = 0; j < createdN; j++) {
          const sourceActivity = sourceChunk[j] as { metadata?: string };
          const meta =
            typeof sourceActivity.metadata === "string"
              ? safeParseJson(sourceActivity.metadata)
              : null;
          const txId = (meta as { tr_transaction_id?: string } | null)?.tr_transaction_id;
          if (txId) ids.push(txId);
        }
        return ids;
      };

      const saveWithBisect = async (
        chunk: ActivityCreate[],
        depth: number,
      ): Promise<ChunkResult> => {
        // Bisect a failed chunk: split + retry until the bad row is isolated
        // to size 1, then skip it. Shared by BOTH failure paths — a returned
        // `errors` array AND a thrown exception.
        const bisect = async (): Promise<ChunkResult> => {
          const mid = Math.floor(chunk.length / 2);
          const a = await saveWithBisect(chunk.slice(0, mid), depth + 1);
          const b = await saveWithBisect(chunk.slice(mid), depth + 1);
          return {
            created: a.created + b.created,
            errors: [...a.errors, ...b.errors],
            successfulTxIds: [...a.successfulTxIds, ...b.successfulTxIds],
          };
        };

        let result: {
          created?: { id?: string }[];
          errors?: { action: string; message: string; id?: string }[];
        };
        try {
          result = (await ctx.api.activities.saveMany({ creates: chunk })) as typeof result;
        } catch (e) {
          // The backend can THROW a bad row (e.g. "Duplicate activity
          // detected") instead of returning it in `errors`. Without this catch
          // the exception aborts the ENTIRE import. Treat a thrown failure
          // exactly like a returned one: bisect to isolate, then skip at size
          // 1 — so a single duplicate never aborts the whole import. The chunk
          // transaction is atomic (rolled back on throw), so retrying the
          // halves cannot double-insert.
          const message = e instanceof Error ? e.message : String(e);
          if (chunk.length === 1) {
            ctx.api.logger.warn(`TR import: row failed (depth=${depth}): ${message}`);
            return {
              created: 0,
              errors: [{ action: "create", message }],
              successfulTxIds: [],
            };
          }
          ctx.api.logger.info(
            `TR import: chunk of ${chunk.length} threw (${message}), bisecting (depth=${depth})`,
          );
          return bisect();
        }

        const createdN = result?.created?.length ?? 0;
        const errorsN = result?.errors?.length ?? 0;

        // Success or atomic-singleton failure → done.
        if (errorsN === 0) {
          return {
            created: createdN,
            errors: [],
            successfulTxIds: collectTxIds(chunk, createdN),
          };
        }
        if (chunk.length === 1) {
          // Single-row chunk that still failed — capture error and move on.
          ctx.api.logger.warn(
            `TR import: row failed (depth=${depth}): ${result.errors?.[0]?.message ?? "unknown"}`,
          );
          return {
            created: 0,
            errors: result.errors ?? [],
            successfulTxIds: [],
          };
        }

        // Backend aborted the whole transaction. Split + retry.
        ctx.api.logger.info(
          `TR import: chunk of ${chunk.length} aborted by backend, bisecting (depth=${depth})`,
        );
        return bisect();
      };

      let cancelled = false;
      for (let i = 0; i < total; i += CHUNK_SIZE) {
        // Check between chunks (we don't try to cancel mid-chunk because
        // the backend transaction is atomic — interrupting it would risk
        // leaving the DB in an inconsistent state).
        if (abort.signal.aborted) {
          cancelled = true;
          break;
        }
        const chunk = mapping.activities.slice(i, i + CHUNK_SIZE);
        stepLabel = `insert activities ${i + 1}–${Math.min(i + chunk.length, total)} of ${total}`;
        const res = await saveWithBisect(chunk, 0);
        createdCount += res.created;
        if (res.errors.length > 0) allErrors.push(...res.errors);
        successfulTxIds.push(...res.successfulTxIds);
        current = Math.min(i + chunk.length, total);
        setState({ kind: "importing", data, overrides, current, total });
      }

      stepLabel = "save IDs to history";
      // Only persist transaction_ids that the backend accepted — failed ones
      // can be retried on next import.
      recordImported(successfulTxIds);

      stepLabel = "trigger recalculation";
      ctx.api.portfolio
        .recalculate()
        .catch((e: Error) => ctx.api.logger.error(`portfolio.recalculate falhou: ${e.message}`));
      ctx.api.market
        .syncHistory()
        .catch((e: Error) => ctx.api.logger.error(`market.syncHistory falhou: ${e.message}`));

      setState({
        kind: "imported",
        count: data.newRows.length,
        activitiesCount: total,
        createdCount,
        errors: cancelled
          ? [
              ...allErrors,
              {
                action: "cancelled",
                message: `Import cancelled by user. ${total - current} activities not attempted; ${createdCount} successfully inserted are already in your account.`,
              },
            ]
          : allErrors,
        durationMs: Date.now() - startedAt,
        accountCreated: account.created,
      });
    } catch (err) {
      const { message, detail } = describeError(err);
      ctx.api.logger.error(`TR import failed at "${stepLabel}": ${message}`);
      setState({
        kind: "error",
        error: {
          origin: "import",
          title: `Failed at: ${stepLabel}`,
          message,
          detail,
        },
      });
    } finally {
      abortRef.current = null;
    }
  }, [state, ctx]);

  const handleCancelImport = React.useCallback(() => {
    abortRef.current?.abort();
    ctx.api.logger.info("TR import: cancel requested by user");
  }, [ctx]);

  const handleDiagnose = React.useCallback(async () => {
    setState({ kind: "diagnosing" });
    try {
      const account = await ensureTRAccount(ctx);
      const activities = await ctx.api.activities.getAll(account.accountId);
      const report = diagnose(activities, account.accountId);
      setState({ kind: "diagnosed", report });
    } catch (err) {
      const { message, detail } = describeError(err);
      ctx.api.logger.error(`TR diagnose falhou: ${message}`);
      setState({
        kind: "error",
        error: {
          origin: "import",
          title: "Diagnostics failed",
          message,
          detail,
        },
      });
    }
  }, [ctx]);

  const handleCleanupDuplicates = React.useCallback(async () => {
    if (state.kind !== "diagnosed") return;
    const ids = pickDuplicatesToDelete(state.report);
    if (ids.length === 0) return;
    try {
      // Delete in chunks of 200 (same convention as inserts).
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        await ctx.api.activities.saveMany({ deleteIds: chunk });
      }
      // Re-run diagnostics to refresh
      const account = await ensureTRAccount(ctx);
      const activities = await ctx.api.activities.getAll(account.accountId);
      const report = diagnose(activities, account.accountId);
      setState({ kind: "diagnosed", report, cleanupCount: ids.length });
      // Trigger recalc since holdings changed
      ctx.api.portfolio
        .recalculate()
        .catch((e: Error) => ctx.api.logger.error(`recalculate after cleanup: ${e.message}`));
    } catch (err) {
      const { message, detail } = describeError(err);
      ctx.api.logger.error(`Cleanup duplicates falhou: ${message}`);
      setState({
        kind: "error",
        error: {
          origin: "import",
          title: "Cleanup duplicates failed",
          message,
          detail,
        },
      });
    }
  }, [state, ctx]);

  const handleExportDiagnostics = React.useCallback(async () => {
    if (state.kind !== "diagnosed") return;
    const r = state.report;
    // Build a friendlier export — strip Activity-level detail (heavy + PII),
    // keep aggregates + duplicates summary.
    const exportData = {
      generated_at: new Date().toISOString(),
      addon_version: "4.2.1",
      account_id: r.accountId,
      summary: {
        total_activities: r.totalActivities,
        tr_activities: r.trActivities,
        foreign_activities: r.foreignActivities,
        unique_transaction_ids: r.uniqueTransactionIds,
        duplicates_count: r.duplicates.length,
        duplicates_to_delete: r.duplicates.reduce((s, g) => s + g.activities.length - 1, 0),
        cash_in_eur: r.cashEffect.cashIn,
        cash_out_eur: r.cashEffect.cashOut,
        cash_net_eur: r.cashEffect.cashIn - r.cashEffect.cashOut,
      },
      by_bucket: r.byBucket,
      by_region: r.byRegion,
      by_asset_type: r.byAssetType,
      by_asset: r.byAsset.map((a) => ({
        symbol: a.symbol,
        name: a.name,
        bucket: a.bucket,
        country: a.country,
        country_name: a.countryName,
        net_quantity: a.netQuantity,
        activity_count: a.activityCount,
      })),
      duplicates: r.duplicates.map((g) => ({
        tr_transaction_id: g.trTransactionId,
        count: g.activities.length,
        activity_ids: g.activities.map((a) => a.id),
        symbols: [...new Set(g.activities.map((a) => a.assetSymbol).filter(Boolean))],
      })),
    };
    try {
      const json = JSON.stringify(exportData, null, 2);
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      await ctx.api.files.openSaveDialog(json, `tr-importer-diagnostics-${ts}.json`);
    } catch (err) {
      const { message } = describeError(err);
      ctx.api.logger.error(`Export diagnostics falhou: ${message}`);
    }
  }, [state, ctx]);

  const handleSdkTest = React.useCallback(async () => {
    try {
      const account = await ensureTRAccount(ctx);
      const samples = buildSamples(account.accountId);
      const startedAt = Date.now();
      setState({ kind: "sdk_testing", current: 0, total: samples.length });

      const results: SdkTestResult[] = [];
      const createdIds: string[] = [];

      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        try {
          const created = (await ctx.api.activities.create(s.activity)) as { id?: string };
          results.push({
            label: s.label,
            activityType: s.activity.activityType,
            status: "pass",
            createdId: created?.id,
          });
          if (created?.id) createdIds.push(created.id);
        } catch (err) {
          const { message } = describeError(err);
          results.push({
            label: s.label,
            activityType: s.activity.activityType,
            status: "fail",
            error: message,
          });
        }
        setState({ kind: "sdk_testing", current: i + 1, total: samples.length });
      }

      // Cleanup — delete every successfully created test activity.
      if (createdIds.length > 0) {
        try {
          await ctx.api.activities.saveMany({ deleteIds: createdIds });
        } catch (err) {
          const { message } = describeError(err);
          ctx.api.logger.error(`SDK test cleanup falhou: ${message}`);
        }
      }

      setState({
        kind: "sdk_tested",
        results,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const { message, detail } = describeError(err);
      ctx.api.logger.error(`SDK test setup falhou: ${message}`);
      setState({
        kind: "error",
        error: { origin: "import", title: "SDK test failed", message, detail },
      });
    }
  }, [ctx]);

  // v5.0.0 — tab switch with confirmation when leaving in-progress work.
  const wizardInProgress =
    state.kind === "parsing" ||
    state.kind === "parsed" ||
    state.kind === "reviewing_assets" ||
    state.kind === "importing";

  const requestTabChange = React.useCallback(
    (tab: TabId) => {
      if (tab === currentTab) return;
      // Block leaving while the import is actively running.
      if (state.kind === "importing") return;
      // Confirm if user has a parsed preview or unsaved review.
      if (
        currentTab === "import" &&
        (state.kind === "parsed" || state.kind === "reviewing_assets")
      ) {
        setPendingTab(tab);
        return;
      }
      switchTabImmediate(tab);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentTab, state],
  );

  const switchTabImmediate = (tab: TabId) => {
    setCurrentTab(tab);
    // Reset Import-tab state if we're navigating away from a stale flow.
    if (tab !== "import" && state.kind !== "imported") {
      // Keep imported state so the user can come back to see the summary.
      // Otherwise reset to empty so the next visit shows the drop zone.
      if (state.kind === "parsed" || state.kind === "reviewing_assets" || state.kind === "error") {
        setState({ kind: "empty" });
      }
    }
    // v5.2.0: Análise tab loads holdings + auto-runs diagnostics (was its
    // own tab). Avançado tab opens the Expert (AI) panel and also exposes
    // the SDK-test panel via a button further down.
    if (tab === "holdings") {
      handleDiagnose();
    } else if (tab === "expert") {
      setState({ kind: "expert" });
    }
  };

  return (
    <Page>
      <PageHeader heading="TR Importer" text={pageSubtitle(state, currentTab)} />
      <PageContent>
        <Tabs
          value={currentTab}
          onValueChange={(v) => requestTabChange(v as TabId)}
          className="w-full"
        >
          {/*
           * v5.2.0 UX simplification: collapsed 5 tabs into 3 so the user
           * isn't bombarded with developer-flavoured tabs (SDK Test) and
           * overlapping analysis screens (Holdings + Diagnostics).
           *
           *   Importar  — CSV upload + review wizard (unchanged)
           *   Análise   — EUR holdings table + diagnostics (merged)
           *   Avançado  — Expert (AI) + SDK Test (dev), one click away
           */}
          <TabsList className="mb-4 grid w-full max-w-md grid-cols-3">
            <TabsTrigger value="import" className="gap-1.5">
              <Icons.Upload className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Importar</span>
            </TabsTrigger>
            <TabsTrigger value="holdings" className="gap-1.5">
              <Icons.Globe className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Análise</span>
            </TabsTrigger>
            <TabsTrigger value="expert" className="gap-1.5">
              <Icons.Sparkles className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Avançado</span>
            </TabsTrigger>
          </TabsList>

          {/* TAB: IMPORT — wizard flow with stepper */}
          {currentTab === "import" && (
            <ImportTabContent
              state={state}
              setState={setState}
              ctx={ctx}
              isDragging={isDragging}
              setIsDragging={setIsDragging}
              fileInputRef={fileInputRef}
              handleFile={handleFile}
              handleDrop={handleDrop}
              handleImport={handleImport}
              handleDiagnose={handleDiagnose}
              handleCancelImport={handleCancelImport}
            />
          )}

          {/* TAB: ANÁLISE — holdings em EUR + diagnostics inline */}
          {currentTab === "holdings" && (
            <div className="space-y-6">
              <EurHoldingsView ctx={ctx} onClose={() => setCurrentTab("import")} />

              {/* Diagnostics section (was its own tab in <=v5.1.x) */}
              {state.kind === "diagnosing" && (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center py-12">
                    <Icons.Spinner className="text-muted-foreground mb-4 h-8 w-8 animate-spin" />
                    <p className="text-sm font-medium">A ler atividades da conta TR…</p>
                  </CardContent>
                </Card>
              )}
              {state.kind === "diagnosed" && state.report.totalActivities > 0 && (
                <DiagnosticsView
                  report={state.report}
                  cleanupCount={state.cleanupCount}
                  onCleanup={handleCleanupDuplicates}
                  onClose={() => switchTabImmediate("import")}
                  onExport={handleExportDiagnostics}
                />
              )}
              {state.kind === "error" && state.error.origin === "import" && (
                <ErrorView error={state.error} onRetry={handleDiagnose} />
              )}
            </div>
          )}

          {/* TAB: AVANÇADO — AI Expert (top) + SDK contract test (collapsed) */}
          {currentTab === "expert" && (
            <div className="space-y-6">
              <ExpertPanel
                secrets={ctx.api.secrets}
                context={undefined}
                onClose={() => setCurrentTab("import")}
              />

              {/* SDK contract test (was a separate top-level tab in <=v5.1.x).
                  Moved here so developer-flavoured tools don't dominate the
                  main nav, but still discoverable for diagnostics. */}
              {state.kind === "sdk_testing" && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Icons.Spinner className="h-5 w-5 animate-spin" />
                      Testing SDK contracts…
                    </CardTitle>
                    <CardDescription>
                      Inserting 1 activity of each type, then deleting them.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Progress value={state.total > 0 ? (state.current / state.total) * 100 : 0} />
                    <p className="text-muted-foreground text-xs">
                      {state.current} of {state.total} tested
                    </p>
                  </CardContent>
                </Card>
              )}
              {state.kind === "sdk_tested" && (
                <SdkTestView
                  results={state.results}
                  durationMs={state.durationMs}
                  onClose={() => setCurrentTab("import")}
                />
              )}
              {state.kind !== "sdk_testing" && state.kind !== "sdk_tested" && (
                <EmptyState
                  icon={<Icons.CheckCircle className="text-muted-foreground h-8 w-8" />}
                  title="Teste de contrato SDK"
                  description="Insere uma atividade de cada tipo via o SDK do addon e apaga-as logo em seguida. Útil para verificar a ponte addon ↔ Donkeyfolio depois de atualizações."
                  primaryAction={{
                    label: "Correr teste",
                    icon: <Icons.CheckCircle className="h-4 w-4" />,
                    onClick: handleSdkTest,
                  }}
                />
              )}
            </div>
          )}
        </Tabs>

        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />

        {/* Confirmation dialog when leaving the import wizard mid-flow */}
        <AlertDialog
          open={pendingTab !== null}
          onOpenChange={(open) => !open && setPendingTab(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard import preview?</AlertDialogTitle>
              <AlertDialogDescription>
                You have a parsed CSV preview that hasn't been imported yet. Switching tabs will
                discard it. The CSV file is still on your computer — you can re-drop it any time.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setPendingTab(null)}>
                Stay on Import
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (pendingTab) switchTabImmediate(pendingTab);
                  setPendingTab(null);
                }}
              >
                Discard and switch
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </PageContent>
    </Page>
  );
}

/**
 * Import-tab content. The state machine drives which sub-view is shown.
 * Wizard stepper is rendered above each step except the initial drop zone.
 */
interface ImportTabContentProps {
  state: State;
  setState: React.Dispatch<React.SetStateAction<State>>;
  ctx: AddonContext;
  isDragging: boolean;
  setIsDragging: React.Dispatch<React.SetStateAction<boolean>>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFile: (file: File) => Promise<void>;
  handleDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  handleImport: () => Promise<void>;
  handleDiagnose: () => Promise<void>;
  handleCancelImport: () => void;
}

function ImportTabContent({
  state,
  setState,
  isDragging,
  setIsDragging,
  fileInputRef,
  handleDrop,
  handleImport,
  handleDiagnose,
  handleCancelImport,
}: ImportTabContentProps): React.JSX.Element {
  const stepper = renderStepper(state);

  return (
    <div className="space-y-4">
      {stepper}

      {state.kind === "empty" && (
        <EmptyView
          isDragging={isDragging}
          history={loadImportHistory()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onPick={() => fileInputRef.current?.click()}
          onClearHistory={() => {
            clearImportHistory();
            setState({ kind: "empty" });
          }}
        />
      )}

      {state.kind === "parsing" && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Icons.Spinner className="text-muted-foreground mb-4 h-10 w-10 animate-spin" />
            <p className="text-sm font-medium">Parsing {state.filename}…</p>
          </CardContent>
        </Card>
      )}

      {state.kind === "error" && (
        <ErrorView error={state.error} onRetry={() => setState({ kind: "empty" })} />
      )}

      {state.kind === "parsed" && (
        <ParsedView
          data={state.data}
          onContinue={() => {
            const suggestions = suggestQuoteCcyOverrides(state.data.mapping.activities);
            const initial = new Map<string, AssetOverride>();
            for (const s of suggestions) {
              initial.set(s.symbol, { quoteCcy: s.suggestedQuoteCcy });
            }
            setState({
              kind: "reviewing_assets",
              data: state.data,
              overrides: initial,
            });
          }}
        />
      )}

      {state.kind === "reviewing_assets" && (
        <ReviewAssetsView
          mapping={state.data.mapping}
          overrides={state.overrides}
          onChange={(next) =>
            setState({ kind: "reviewing_assets", data: state.data, overrides: next })
          }
          onBack={() => setState({ kind: "parsed", data: state.data })}
          onContinue={handleImport}
        />
      )}

      {state.kind === "importing" && (
        <ImportingView
          data={state.data}
          current={state.current}
          total={state.total}
          onCancel={handleCancelImport}
        />
      )}

      {state.kind === "imported" && (
        <ImportedView
          count={state.count}
          activitiesCount={state.activitiesCount}
          createdCount={state.createdCount}
          errors={state.errors}
          durationMs={state.durationMs}
          accountCreated={state.accountCreated}
          onAgain={() => setState({ kind: "empty" })}
          onDiagnose={handleDiagnose}
        />
      )}
    </div>
  );
}

function renderStepper(state: State): React.JSX.Element | null {
  // Don't render on the very first screen (empty drop zone) or after import
  // is fully done — they have their own clear visuals.
  if (state.kind === "empty") return null;
  if (state.kind === "imported") return null;
  if (state.kind === "error") return null;

  // v5.3.0: 5-step stepper mirrors Donkeyfolio's built-in import wizard
  // (Upload → Mapping → Review Assets → Review Activities → Import). The
  // "Mapping" step is a no-op for us because we auto-detect the TR CSV
  // shape, but showing it in the stepper keeps the addon visually
  // consistent with the rest of the app — the same experience the user
  // already knows from the activity wizard.
  const stateOrder: Record<string, number> = {
    parsing: 1, // running through mapper heuristics
    parsed: 2, // summary cards visible, equivalent to "Review Assets" landing
    reviewing_assets: 3, // per-row drill-down
    importing: 4,
    imported: 4,
  };
  const currentIdx = stateOrder[state.kind] ?? 0;

  const steps: WizardStep[] = [
    {
      id: "upload",
      label: "Upload",
      state: currentIdx > 0 ? "done" : "current",
    },
    {
      id: "mapping",
      label: "Mapping",
      state: currentIdx > 1 ? "done" : currentIdx === 1 ? "current" : "future",
    },
    {
      id: "review-assets",
      label: "Review Assets",
      state: currentIdx > 2 ? "done" : currentIdx === 2 ? "current" : "future",
    },
    {
      id: "review-activities",
      label: "Review Activities",
      state: currentIdx > 3 ? "done" : currentIdx === 3 ? "current" : "future",
    },
    {
      id: "import",
      label: "Import",
      state: currentIdx === 4 ? "current" : "future",
    },
  ];
  // The drop step is always behind us once a file was read.
  steps[0].state = "done";

  return (
    <Card>
      <CardContent className="py-3">
        <WizardStepper steps={steps} />
      </CardContent>
    </Card>
  );
}

function pageSubtitle(state: State, currentTab: TabId): string {
  // v5.2.0: subtitles match the new 3-tab IA (Importar / Análise / Avançado).
  if (currentTab === "holdings") {
    return "Posições em EUR + diagnóstico das atividades importadas.";
  }
  if (currentTab === "expert") {
    return "Ferramentas avançadas: assistente AI e teste do SDK.";
  }

  // Import tab — subtitle reflects wizard step.
  switch (state.kind) {
    case "parsed":
      return `${state.data.summary.totalRows.toLocaleString("en-US")} transações em ${state.data.filename} · ${state.data.newRows.length.toLocaleString("en-US")} novas para importar.`;
    case "reviewing_assets":
      return `Rever ${state.data.mapping.activities.length.toLocaleString("en-US")} atividades · ajustar quoteCcy por ativo antes de importar.`;
    case "importing":
      return `A importar ${state.current.toLocaleString("en-US")} de ${state.total.toLocaleString("en-US")} atividades…`;
    case "imported":
      return `Importadas ${state.activitiesCount.toLocaleString("en-US")} atividades em ${(state.durationMs / 1000).toFixed(1)}s.`;
    case "error":
      return state.error.title;
    default:
      return "Importa todas as transações da Trade Republic para o Donkeyfolio.";
  }
}

/* ────────────────────────  Empty view (drop zone + info)  ──────────────────────── */

interface EmptyViewProps {
  isDragging: boolean;
  history: ImportHistory;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onPick: () => void;
  onClearHistory: () => void;
}

function EmptyView({
  isDragging,
  history,
  onDragOver,
  onDragLeave,
  onDrop,
  onPick,
  onClearHistory,
}: EmptyViewProps): React.JSX.Element {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Drop zone — 2/3 width */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={
          "rounded-xl border-2 border-dashed p-8 transition-colors lg:col-span-2 " +
          (isDragging
            ? "border-primary bg-primary/10"
            : "border-border bg-card/30 hover:border-primary/50")
        }
      >
        <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-4 text-center">
          <div className="bg-primary/10 flex h-16 w-16 items-center justify-center rounded-2xl">
            <Icons.FileSpreadsheet className="text-primary h-8 w-8" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold">Drop your Trade Republic CSV</h2>
            <p className="text-muted-foreground max-w-sm text-sm">
              Trades, dividends, deposits, withdrawals, staking, corporate actions — every
              transaction imported into Wealthfolio.
            </p>
          </div>
          <Button onClick={onPick} size="lg" className="mt-1">
            <Icons.Upload className="mr-2 h-4 w-4" />
            Or pick a file
          </Button>
        </div>
      </div>

      {/* Info side panel — 1/3 width */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">How to get the CSV</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ol className="text-muted-foreground list-inside list-decimal space-y-1.5">
              <li>Open the Trade Republic app</li>
              <li>Profile → Activity</li>
              <li>Export → "Transaction statement"</li>
              <li>You receive the CSV by email</li>
            </ol>
          </CardContent>
        </Card>

        {history.ids.size > 0 ? (
          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Import history</CardTitle>
              <CardDescription>
                {history.ids.size.toLocaleString("en-US")} transactions already imported.
                Re-importing the same CSV is safe — only new rows are added.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" size="sm" onClick={onClearHistory} className="w-full">
                <Icons.Trash className="mr-2 h-4 w-4" />
                Clear history
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Incremental imports</CardTitle>
              <CardDescription>
                Every transaction has a unique ID. On future imports only the new rows are added —
                no duplicates.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────  Parsed view  ──────────────────────── */

function ParsedView({
  data,
  onContinue,
}: {
  data: ParsedData;
  onContinue: () => void;
}): React.JSX.Element {
  const cashEffect = sumActivityCashEffect(data.mapping.activities);
  const hasNew = data.newRows.length > 0;

  // v5.1.0 — surface warnings count on the primary CTA so the user sees
  // at a glance whether the parsed data has issues worth reviewing.
  // Counts both mapper notes (cancelled-pair, missing data, unknown type)
  // and CSV parser warnings (bad rows).
  const noteWarnings = data.mapping.notes.filter(
    (n) => n.kind === "missing_data" || n.kind === "unknown_type",
  ).length;
  const warningTotal = noteWarnings + data.warnings.length;

  const netCash = cashEffect.cashIn - cashEffect.cashOut;
  const newPct =
    data.summary.totalRows > 0 ? (data.newRows.length / data.summary.totalRows) * 100 : 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* KPI strip — Swingfolio-style: header (label left + big value right) + sub-rows */}
      <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-3">
        {/* Card 1 — Transactions */}
        <Card
          className={hasNew ? "border-primary/10 bg-primary/10" : "border-success/10 bg-success/10"}
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Transactions</CardTitle>
            <span className="text-xl font-bold tabular-nums sm:text-2xl">
              {data.summary.totalRows.toLocaleString("en-US")}
            </span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">New</span>
              <span className="font-medium tabular-nums">
                {data.newRows.length.toLocaleString("en-US")}{" "}
                <span className="text-muted-foreground">({newPct.toFixed(0)}%)</span>
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">Already imported</span>
              <span className="font-medium tabular-nums">
                {data.alreadyImported.length.toLocaleString("en-US")}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">Activities to insert</span>
              <span className="font-medium tabular-nums">
                {data.mapping.activities.length.toLocaleString("en-US")}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Card 2 — Net cash flow */}
        <Card
          className={
            netCash >= 0
              ? "border-success/10 bg-success/10"
              : "border-destructive/10 bg-destructive/10"
          }
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Net cash flow</CardTitle>
            <span
              className={
                "text-xl font-bold tabular-nums sm:text-2xl " +
                (netCash >= 0 ? "text-success" : "text-destructive")
              }
            >
              {fmtEur(netCash)}
            </span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">Inflows</span>
              <span className="text-success font-medium tabular-nums">
                {fmtEur(cashEffect.cashIn)}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">Outflows</span>
              <span className="text-destructive font-medium tabular-nums">
                {fmtEur(cashEffect.cashOut)}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">Movements</span>
              <span className="font-medium tabular-nums">
                {data.mapping.activities.length.toLocaleString("en-US")}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Card 3 — Period */}
        <Card className="border-blue-500/10 bg-blue-500/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Period</CardTitle>
            <span className="text-xl font-bold tabular-nums sm:text-2xl">
              {data.summary.dateRange
                ? `${months(data.summary.dateRange.min, data.summary.dateRange.max)} mo`
                : "—"}
            </span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">First</span>
              <span className="font-medium tabular-nums">{data.summary.dateRange?.min ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">Last</span>
              <span className="font-medium tabular-nums">{data.summary.dateRange?.max ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">File</span>
              <span className="text-foreground/80 max-w-[180px] truncate text-xs font-medium">
                {data.filename}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Activity breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Activities to import</CardTitle>
          <CardDescription>What will be created in Wealthfolio.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActivityBreakdownTable mapping={data.mapping} />
        </CardContent>
      </Card>

      {(data.mapping.notes.length > 0 || data.warnings.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
            <CardDescription>
              Heuristics applied (cancelled-pair resolution, card consolidation, split ratios).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.mapping.notes.map((n, i) => (
              <NoteRow key={`note-${i}`} note={n} />
            ))}
            {data.warnings.length > 0 && (
              <>
                <Separator className="my-2" />
                <p className="text-muted-foreground text-xs font-medium uppercase">CSV warnings</p>
                {data.warnings.slice(0, 8).map((w, i) => (
                  <p key={`warn-${i}`} className="text-muted-foreground text-xs">
                    Row {w.rowIndex} ({w.kind}): {w.message}
                  </p>
                ))}
                {data.warnings.length > 8 && (
                  <p className="text-muted-foreground text-xs">
                    + {data.warnings.length - 8} more…
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="border-primary/30 bg-card/95 sticky bottom-2 z-10 shadow-lg backdrop-blur">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div>
            <p className="text-sm font-medium">
              {hasNew ? "Ready to import" : "Nothing new to import"}
            </p>
            <p className="text-muted-foreground text-xs">
              {hasNew
                ? `Activities will go to the "Trade Republic" account (created if missing). ${data.alreadyImported.length} previously imported rows skipped.`
                : "Every row in this CSV was already imported in a previous run."}
            </p>
          </div>
          <Button size="lg" onClick={onContinue} disabled={!hasNew}>
            <Icons.ArrowDownLeft className="mr-2 h-4 w-4" />
            Review assets ({data.mapping.activities.length}
            {warningTotal > 0 ? ` · ${warningTotal} warning${warningTotal === 1 ? "" : "s"}` : ""})
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/* ────────────────────────  Importing view  ──────────────────────── */

function ImportingView({
  data,
  current,
  total,
  onCancel,
}: {
  data: ParsedData;
  current: number;
  total: number;
  onCancel?: () => void;
}): React.JSX.Element {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const [cancelRequested, setCancelRequested] = React.useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icons.Spinner className="h-5 w-5 animate-spin" />
          {cancelRequested ? "Cancelling at next chunk boundary…" : "Importing into Wealthfolio…"}
        </CardTitle>
        <CardDescription>
          {current.toLocaleString("en-US")} of {total.toLocaleString("en-US")} activities ({pct}%)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={pct} />
        <p className="text-muted-foreground text-xs">
          File: {data.filename} · {data.newRows.length.toLocaleString("en-US")} new transactions
        </p>
        {onCancel && (
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCancelRequested(true);
                onCancel();
              }}
              disabled={cancelRequested}
            >
              {cancelRequested ? "Cancelling…" : "Cancel import"}
            </Button>
          </div>
        )}
        {cancelRequested && (
          <p className="text-muted-foreground text-xs">
            Activities already inserted will be kept in your account; their tx_ids are recorded so a
            re-import skips them.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ────────────────────────  Imported view  ──────────────────────── */

function ImportedView({
  count,
  activitiesCount,
  createdCount,
  errors,
  durationMs,
  accountCreated,
  onAgain,
  onDiagnose,
}: {
  count: number;
  activitiesCount: number;
  createdCount: number;
  errors: { action: string; message: string; id?: string }[];
  durationMs: number;
  accountCreated: boolean;
  onAgain: () => void;
  onDiagnose: () => void;
}): React.JSX.Element {
  const [showErrors, setShowErrors] = React.useState(false);
  const hasErrors = errors.length > 0;
  const droppedCount = activitiesCount - createdCount;
  const allOk = !hasErrors && createdCount === activitiesCount;

  // Group errors by message for legibility (1500 "duplicate" → 1 row)
  const errorGroups = React.useMemo(() => {
    const groups = new Map<string, number>();
    for (const e of errors) {
      const key = e.message;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return [...groups.entries()].sort((a, b) => b[1] - a[1]);
  }, [errors]);

  return (
    <div className="space-y-4">
      <Card
        className={
          allOk ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"
        }
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {allOk ? (
              <Icons.CheckCircle className="h-5 w-5 text-emerald-500" />
            ) : (
              <Icons.AlertCircle className="h-5 w-5 text-amber-500" />
            )}
            {allOk ? "Import completed without errors" : "Import completed partially"}
          </CardTitle>
          <CardDescription>
            {accountCreated
              ? "Created a new 'Trade Republic' account. "
              : "Added to the existing 'Trade Republic' account. "}
            Took {(durationMs / 1000).toFixed(1)}s.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 3 KPI breakdown — same Wealthfolio pattern */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="bg-background/50 rounded-lg border p-3">
              <p className="text-muted-foreground text-xs font-medium">Requested</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {activitiesCount.toLocaleString("en-US")}
              </p>
              <p className="text-muted-foreground text-xs">of {count} new CSV rows</p>
            </div>
            <div className="bg-background/50 rounded-lg border p-3">
              <p className="text-muted-foreground text-xs font-medium">Inserted</p>
              <p
                className={
                  "mt-1 text-2xl font-bold tabular-nums " +
                  (createdCount === activitiesCount ? "text-success" : "")
                }
              >
                {createdCount.toLocaleString("en-US")}
              </p>
              <p className="text-muted-foreground text-xs">
                {((createdCount / Math.max(activitiesCount, 1)) * 100).toFixed(1)}% of requested
              </p>
            </div>
            <div className="bg-background/50 rounded-lg border p-3">
              <p className="text-muted-foreground text-xs font-medium">
                {droppedCount > 0 ? "Rejected" : "No errors"}
              </p>
              <p
                className={
                  "mt-1 text-2xl font-bold tabular-nums " +
                  (droppedCount > 0 ? "text-destructive" : "")
                }
              >
                {droppedCount.toLocaleString("en-US")}
              </p>
              <p className="text-muted-foreground text-xs">{errors.length} backend errors</p>
            </div>
          </div>

          {hasErrors && (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setShowErrors((s) => !s)}>
                {showErrors ? "Hide errors" : `Show ${errorGroups.length} error type(s)`}
              </Button>
              {showErrors && (
                <div className="mt-2 space-y-1.5">
                  {errorGroups.map(([msg, n], i) => (
                    <div
                      key={i}
                      className="bg-background/50 flex items-start gap-3 rounded-md border p-2 text-xs"
                    >
                      <Badge variant="outline" className="border-destructive/40 text-destructive">
                        ×{n}
                      </Badge>
                      <p className="font-mono">{msg}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-muted-foreground text-sm">
            Wealthfolio is recalculating portfolio history and refreshing market data in the
            background. The Performance chart, Holdings, and Dashboard will update in seconds.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onAgain}>
              Import another file
            </Button>
            <Button variant="outline" onClick={onDiagnose}>
              <Icons.AlertCircle className="mr-2 h-4 w-4" />
              Run diagnostics
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ────────────────────────  Diagnostics view  ──────────────────────── */

function DiagnosticsView({
  report,
  cleanupCount,
  onCleanup,
  onClose,
  onExport,
}: {
  report: DiagnosticsReport;
  cleanupCount?: number;
  onCleanup: () => void;
  onClose: () => void;
  onExport: () => void;
}): React.JSX.Element {
  const [confirmCleanup, setConfirmCleanup] = React.useState(false);
  const dupeCount = report.duplicates.length;
  const dupeActivities = report.duplicates.reduce((s, g) => s + g.activities.length, 0);
  const toDelete = dupeActivities - dupeCount; // keep 1 of each
  const netCash = report.cashEffect.cashIn - report.cashEffect.cashOut;

  return (
    <div className="space-y-4">
      {/* Top KPI strip */}
      <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-4">
        <Card className="border-blue-500/10 bg-blue-500/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Total activities</CardTitle>
            <span className="text-xl font-bold tabular-nums">
              {report.totalActivities.toLocaleString("en-US")}
            </span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">From TR (this addon)</span>
              <span className="font-medium tabular-nums">
                {report.trActivities.toLocaleString("en-US")}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">Other (manual)</span>
              <span className="font-medium tabular-nums">
                {report.foreignActivities.toLocaleString("en-US")}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card
          className={
            dupeCount === 0
              ? "border-success/10 bg-success/10"
              : "border-destructive/10 bg-destructive/10"
          }
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Duplicates</CardTitle>
            <span
              className={
                "text-xl font-bold tabular-nums " +
                (dupeCount === 0 ? "text-success" : "text-destructive")
              }
            >
              {dupeCount.toLocaleString("en-US")}
            </span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">Unique tx IDs</span>
              <span className="font-medium tabular-nums">
                {report.uniqueTransactionIds.toLocaleString("en-US")}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">To delete</span>
              <span className="text-destructive font-medium tabular-nums">
                {toDelete.toLocaleString("en-US")}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card
          className={
            netCash >= 0
              ? "border-success/10 bg-success/10"
              : "border-destructive/10 bg-destructive/10"
          }
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Net cash flow</CardTitle>
            <span
              className={
                "text-xl font-bold tabular-nums " +
                (netCash >= 0 ? "text-success" : "text-destructive")
              }
            >
              {fmtEur(netCash)}
            </span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">Inflows</span>
              <span className="text-success font-medium tabular-nums">
                {fmtEur(report.cashEffect.cashIn)}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs">Outflows</span>
              <span className="text-destructive font-medium tabular-nums">
                {fmtEur(report.cashEffect.cashOut)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-blue-500/10 bg-blue-500/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Unique assets</CardTitle>
            <span className="text-xl font-bold tabular-nums">
              {report.byAsset.length.toLocaleString("en-US")}
            </span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            {Object.entries(report.byBucket)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([k, v]) => (
                <div key={k} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground text-xs">{k}</span>
                  <span className="font-medium tabular-nums">{v.toLocaleString("en-US")}</span>
                </div>
              ))}
          </CardContent>
        </Card>
      </div>

      {cleanupCount != null && cleanupCount > 0 && (
        <Card className="border-success/40 bg-success/5">
          <CardContent className="flex items-center gap-3 py-3 text-sm">
            <Icons.CheckCircle className="text-success h-5 w-5" />
            <span>
              Deleted {cleanupCount.toLocaleString("en-US")} duplicate activities. Wealthfolio is
              recalculating.
            </span>
          </CardContent>
        </Card>
      )}

      {dupeCount > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Icons.AlertCircle className="text-destructive h-5 w-5" />
              {dupeCount} duplicate transactions
            </CardTitle>
            <CardDescription>
              The same `tr_transaction_id` appears in multiple activities. The cleanup keeps the
              oldest one and deletes the rest ({toDelete} activities).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              {report.duplicates.slice(0, 8).map((g, i) => (
                <div
                  key={i}
                  className="bg-muted/30 flex items-center justify-between gap-2 rounded-md border p-2 text-xs"
                >
                  <span className="text-muted-foreground truncate font-mono">
                    {g.trTransactionId.slice(0, 18)}…
                  </span>
                  <Badge variant="outline" className="border-destructive/40 text-destructive">
                    ×{g.activities.length}
                  </Badge>
                </div>
              ))}
              {report.duplicates.length > 8 && (
                <p className="text-muted-foreground text-xs">
                  + {report.duplicates.length - 8} more…
                </p>
              )}
            </div>
            {!confirmCleanup ? (
              <Button variant="destructive" onClick={() => setConfirmCleanup(true)}>
                <Icons.Trash className="mr-2 h-4 w-4" />
                Delete {toDelete} duplicate activities
              </Button>
            ) : (
              <div className="bg-destructive/10 border-destructive/40 space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">
                  Permanently delete {toDelete} activities? This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <Button variant="destructive" onClick={onCleanup}>
                    Yes, delete
                  </Button>
                  <Button variant="outline" onClick={() => setConfirmCleanup(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Distribution by region */}
      {Object.keys(report.byRegion).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Geographic distribution</CardTitle>
            <CardDescription>TR activities grouped by region (from metadata).</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionList items={report.byRegion} />
          </CardContent>
        </Card>
      )}

      {/* Top assets */}
      <Card>
        <CardHeader>
          <CardTitle>Top 20 assets by net quantity</CardTitle>
          <CardDescription>Verify each quantity matches what the TR app shows.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5">
            {report.byAsset.slice(0, 20).map((a) => (
              <div
                key={a.symbol}
                className="bg-muted/20 flex items-center gap-3 rounded-md border p-2 text-sm"
              >
                <span className="text-base">{a.flag ?? "🏳️"}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{a.name ?? a.symbol}</p>
                  <p className="text-muted-foreground text-xs">
                    {a.symbol} · {a.country ?? "?"} · {a.bucket ?? "?"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-medium tabular-nums">
                    {a.netQuantity.toLocaleString("en-US", {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 6,
                    })}
                  </p>
                  <p className="text-muted-foreground text-xs">{a.activityCount} activities</p>
                </div>
              </div>
            ))}
            {report.byAsset.length > 20 && (
              <p className="text-muted-foreground text-xs">
                + {report.byAsset.length - 20} more assets…
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button variant="outline" onClick={onClose}>
          Close diagnostics
        </Button>
        <Button variant="outline" onClick={onExport}>
          <Icons.Upload className="mr-2 h-4 w-4 rotate-180" />
          Export JSON
        </Button>
      </div>
    </div>
  );
}

function DistributionList({ items }: { items: Record<string, number> }): React.JSX.Element {
  const total = Object.values(items).reduce((s, v) => s + v, 0);
  const sorted = Object.entries(items).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-1.5">
      {sorted.map(([k, v]) => {
        const pct = total > 0 ? (v / total) * 100 : 0;
        return (
          <div key={k} className="flex items-center gap-3 text-sm">
            <div className="w-44 shrink-0 truncate">{k}</div>
            <div className="bg-muted relative h-2 flex-1 overflow-hidden rounded-full">
              <div
                className="bg-primary absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-muted-foreground w-16 text-right tabular-nums">{v}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ────────────────────────  SDK test view  ──────────────────────── */

function SdkTestView({
  results,
  durationMs,
  onClose,
}: {
  results: SdkTestResult[];
  durationMs: number;
  onClose: () => void;
}): React.JSX.Element {
  const passes = results.filter((r) => r.status === "pass").length;
  const fails = results.filter((r) => r.status === "fail").length;
  const allOk = fails === 0;
  return (
    <div className="space-y-4">
      <Card
        className={
          allOk ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5"
        }
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {allOk ? (
              <Icons.CheckCircle className="h-5 w-5 text-emerald-500" />
            ) : (
              <Icons.AlertCircle className="text-destructive h-5 w-5" />
            )}
            {allOk ? "All SDK contracts passed" : `${fails} SDK contract(s) failed`}
          </CardTitle>
          <CardDescription>
            {passes}/{results.length} passed in {(durationMs / 1000).toFixed(1)}s. Test activities
            were deleted at the end — your account is unaffected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {results.map((r, i) => (
            <div
              key={i}
              className={
                "flex items-start gap-3 rounded-md border p-2 text-sm " +
                (r.status === "pass"
                  ? "bg-success/5 border-success/20"
                  : "bg-destructive/5 border-destructive/30")
              }
            >
              {r.status === "pass" ? (
                <Icons.CheckCircle className="text-success mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <Icons.AlertCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium">{r.label}</p>
                <p className="text-muted-foreground font-mono text-xs">{r.activityType}</p>
                {r.error && <p className="text-destructive mt-1 font-mono text-xs">{r.error}</p>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Button variant="outline" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

/* ────────────────────────  Error view  ──────────────────────── */

function ErrorView({
  error,
  onRetry,
}: {
  error: ErrorInfo;
  onRetry: () => void;
}): React.JSX.Element {
  const [showDetail, setShowDetail] = React.useState(false);
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icons.AlertCircle className="text-destructive h-5 w-5" />
          {error.title}
        </CardTitle>
        <CardDescription>
          {error.origin === "parse"
            ? "Error parsing the CSV."
            : "Error importing into Wealthfolio."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="bg-muted/50 rounded-lg border p-3">
          <p className="font-mono text-sm">{error.message}</p>
        </div>
        {error.detail && (
          <div>
            <Button variant="ghost" size="sm" onClick={() => setShowDetail((s) => !s)}>
              {showDetail ? "Hide technical details" : "Show technical details"}
            </Button>
            {showDetail && (
              <pre className="bg-muted/30 mt-2 max-h-64 overflow-auto rounded-lg border p-3 text-xs">
                {error.detail}
              </pre>
            )}
          </div>
        )}
        <Button onClick={onRetry}>
          <Icons.Refresh className="mr-2 h-4 w-4" />
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

/* ────────────────────────  KPI Card  ──────────────────────── */

interface KpiCardProps {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  accent: "default" | "positive" | "negative";
}

function KpiCard({ label, value, sub, icon, accent }: KpiCardProps): React.JSX.Element {
  const accentClass =
    accent === "positive"
      ? "border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-emerald-500/[0.02]"
      : accent === "negative"
        ? "border-rose-500/30 bg-gradient-to-br from-rose-500/10 to-rose-500/[0.02]"
        : "";
  return (
    <Card className={accentClass}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <p className="text-muted-foreground text-sm font-medium">{label}</p>
          <div className="text-muted-foreground/70">{icon}</div>
        </div>
        <p className="mt-3 text-3xl font-bold tracking-tight">{value}</p>
        <p className="text-muted-foreground mt-1 text-xs">{sub}</p>
      </CardContent>
    </Card>
  );
}

/* ────────────────────────  Activity breakdown  ──────────────────────── */

interface ActivityTypeMeta {
  label: string;
  icon: React.ReactNode;
  tint: string;
}

const ACTIVITY_TYPE_META: Record<string, ActivityTypeMeta> = {
  BUY: {
    label: "Buys",
    icon: <Icons.ArrowDownLeft className="h-4 w-4" />,
    tint: "bg-emerald-500/10 text-emerald-500",
  },
  SELL: {
    label: "Sells",
    icon: <Icons.ArrowUpRight className="h-4 w-4" />,
    tint: "bg-rose-500/10 text-rose-500",
  },
  DIVIDEND: {
    label: "Dividends",
    icon: <Icons.HandCoins className="h-4 w-4" />,
    tint: "bg-emerald-500/10 text-emerald-500",
  },
  "DIVIDEND / DIVIDEND_IN_KIND": {
    label: "Stock dividends",
    icon: <Icons.HandCoins className="h-4 w-4" />,
    tint: "bg-emerald-500/10 text-emerald-500",
  },
  INTEREST: {
    label: "Interest",
    icon: <Icons.HandCoins className="h-4 w-4" />,
    tint: "bg-emerald-500/10 text-emerald-500",
  },
  DEPOSIT: {
    label: "Deposits",
    icon: <Icons.ArrowDownLeft className="h-4 w-4" />,
    tint: "bg-sky-500/10 text-sky-500",
  },
  WITHDRAWAL: {
    label: "Withdrawals",
    icon: <Icons.ArrowUpRight className="h-4 w-4" />,
    tint: "bg-amber-500/10 text-amber-500",
  },
  "CREDIT / REBATE": {
    label: "Saveback (cashback)",
    icon: <Icons.CreditCard className="h-4 w-4" />,
    tint: "bg-emerald-500/10 text-emerald-500",
  },
  "CREDIT / BONUS": {
    label: "Bonus",
    icon: <Icons.HandCoins className="h-4 w-4" />,
    tint: "bg-emerald-500/10 text-emerald-500",
  },
  TRANSFER_IN: {
    label: "Inbound (staking)",
    icon: <Icons.ArrowDownLeft className="h-4 w-4" />,
    tint: "bg-violet-500/10 text-violet-500",
  },
  TRANSFER_OUT: {
    label: "Outbound",
    icon: <Icons.ArrowUpRight className="h-4 w-4" />,
    tint: "bg-violet-500/10 text-violet-500",
  },
  SPLIT: {
    label: "Splits",
    icon: <Icons.Refresh className="h-4 w-4" />,
    tint: "bg-sky-500/10 text-sky-500",
  },
  ADJUSTMENT: {
    label: "Adjustments (M&A)",
    icon: <Icons.Refresh className="h-4 w-4" />,
    tint: "bg-amber-500/10 text-amber-500",
  },
  FEE: {
    label: "Fees",
    icon: <Icons.CreditCard className="h-4 w-4" />,
    tint: "bg-rose-500/10 text-rose-500",
  },
  TAX: {
    label: "Taxes",
    icon: <Icons.CreditCard className="h-4 w-4" />,
    tint: "bg-rose-500/10 text-rose-500",
  },
};

function metaFor(key: string): ActivityTypeMeta {
  return (
    ACTIVITY_TYPE_META[key] ?? {
      label: key,
      icon: <Icons.ListChecks className="h-4 w-4" />,
      tint: "bg-muted text-muted-foreground",
    }
  );
}

function ActivityBreakdownTable({ mapping }: { mapping: MapperResult }): React.JSX.Element {
  const counts = new Map<string, number>();
  for (const a of mapping.activities) {
    const key = a.subtype ? `${a.activityType} / ${a.subtype}` : a.activityType;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = mapping.activities.length;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {sorted.map(([key, count]) => {
        const pct = total > 0 ? (count / total) * 100 : 0;
        const meta = metaFor(key);
        return (
          <div
            key={key}
            className="bg-muted/30 hover:bg-muted/50 flex items-center gap-3 rounded-lg border p-3 transition-colors"
          >
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${meta.tint}`}
            >
              {meta.icon}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{meta.label}</p>
              <p className="text-muted-foreground text-xs">{pct.toFixed(1)}% of total</p>
            </div>
            <div className="text-right">
              <p className="text-base font-semibold tabular-nums">
                {count.toLocaleString("en-US")}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ────────────────────────  Note row  ──────────────────────── */

function NoteRow({ note }: { note: MapperNote }): React.JSX.Element {
  const tone = noteTone(note.kind);
  return (
    <div className="flex items-start gap-3 text-sm">
      <Badge variant="outline" className={`${tone} shrink-0 capitalize`}>
        {noteLabel(note.kind)}
      </Badge>
      <p className="text-foreground/90 pt-0.5">{note.message}</p>
    </div>
  );
}

function noteLabel(kind: MapperNote["kind"]): string {
  switch (kind) {
    case "card_consolidated":
      return "Card consolidated";
    case "cancelled_pair_resolved":
      return "Cancelled pair resolved";
    case "split_ratio":
      return "Split ratio computed";
    case "merger_pair":
      return "Merger pair";
    case "missing_data":
      return "Missing data";
    case "unknown_type":
      return "Unknown type";
    default:
      return kind;
  }
}

function noteTone(kind: MapperNote["kind"]): string {
  switch (kind) {
    case "card_consolidated":
    case "cancelled_pair_resolved":
    case "split_ratio":
    case "merger_pair":
      return "border-emerald-500/40 text-emerald-700 dark:text-emerald-300";
    case "missing_data":
    case "unknown_type":
      return "border-amber-500/40 text-amber-700 dark:text-amber-300";
    default:
      return "";
  }
}

/* ────────────────────────  Helpers  ──────────────────────── */

const eurFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 2,
});

function fmtEur(n: number): string {
  return eurFmt.format(n);
}

function months(min: string, max: string): number {
  const a = new Date(min);
  const b = new Date(max);
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24 * 30));
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * v4.8.0 — Secondary-toolbar button. Highlighted when its state is the
 * current view, so users can see at a glance where they are.
 */
function ToolbarButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}): React.JSX.Element {
  return (
    <Button variant={active ? "default" : "outline"} size="sm" onClick={onClick} className="h-8">
      <span className="mr-2">{icon}</span>
      {label}
    </Button>
  );
}

/**
 * Mutate every activity's `symbol.quoteCcy` based on per-symbol overrides
 * chosen by the user in the Review Assets step. Only applies when the
 * activity carries a symbol (cash flows skipped). Used right before the
 * saveMany loop so the backend persists the override on first asset
 * creation (asset profiles are immutable via SDK after that).
 */
function applyAssetOverrides(mapping: MapperResult, overrides: Map<string, AssetOverride>): void {
  if (overrides.size === 0) return;
  for (const a of mapping.activities) {
    const sym = (a as { symbol?: { symbol?: string; quoteCcy?: string } }).symbol;
    if (!sym?.symbol) continue;
    const ov = overrides.get(sym.symbol);
    if (ov) sym.quoteCcy = ov.quoteCcy;
  }
}
