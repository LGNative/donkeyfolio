/**
 * AI Validation Wizard panel. (v3.1.0)
 *
 * v3.1.0 — Snapshot-driven wizard.
 *   The panel builds a deterministic ValidationSnapshot from the parsed
 *   data and ships it (plus the user's TR-app paste) to Claude. Claude
 *   only compares — it doesn't recompute. Same parsed PDFs + same paste
 *   = cached response (localStorage), zero API spend on re-runs.
 *
 *   The header tile renders the snapshot's totals so the user can SEE
 *   what's being validated before clicking "Validate". This eliminates
 *   the "wizard sees one thing, preview shows another" class of bug.
 *
 * Privacy:
 *   The API key never leaves the user's machine except for the call to
 *   api.anthropic.com. We send the snapshot + paste — aggregated data
 *   only, no per-trade detail beyond what's already in the snapshot.
 */
import * as React from "react";
import type { AddonContext, Holding } from "@wealthfolio/addon-sdk";
import { Card } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@wealthfolio/ui";
import {
  runAiValidationFromSnapshot,
  type Finding,
  type ValidationReport,
} from "../lib/tr-ai-validator";
import { buildValidationSnapshot, type ValidationSnapshot } from "../lib/tr-validation-snapshot";
import type {
  CashTransaction,
  InterestTransaction,
  StatementSummary,
  TradingTransaction,
} from "../lib/tr-parser";

const SECRET_KEY_API = "anthropic_api_key";
const ADDON_VERSION = "3.3.0";

interface AiWizardPanelProps {
  ctx: AddonContext;
  accountId: string | null;
  baseCurrency: string;
  trades: TradingTransaction[];
  cash?: CashTransaction[];
  interest?: InterestTransaction[];
  /** Page-1 summary from the merged parse. Wrapped into a single-element
   *  array internally — for multi-PDF the merged summary already aggregates
   *  opening/closing across files. */
  summary?: StatementSummary | null;
  /** Number of PDFs that fed the parser. Surfaced in the snapshot meta. */
  pdfCount?: number;
  /** Pre-populates Claude's "known issues" hint. */
  knownIssues?: string[];
}

async function loadApiKey(ctx: AddonContext): Promise<string | null> {
  try {
    return (await ctx.api.secrets.get(SECRET_KEY_API)) ?? null;
  } catch {
    return null;
  }
}

async function saveApiKey(ctx: AddonContext, key: string): Promise<void> {
  await ctx.api.secrets.set(SECRET_KEY_API, key);
}

async function clearApiKey(ctx: AddonContext): Promise<void> {
  try {
    await ctx.api.secrets.delete(SECRET_KEY_API);
  } catch {
    // Some SDK versions throw on missing key — silently ignore.
  }
}

const SEVERITY_BADGE: Record<
  Finding["severity"],
  { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
> = {
  critical: { variant: "destructive", label: "CRITICAL" },
  major: { variant: "destructive", label: "MAJOR" },
  minor: { variant: "secondary", label: "MINOR" },
  info: { variant: "outline", label: "INFO" },
};

function fmtEur(n: number | undefined | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

function fmtNum(n: number | undefined | null, decimals = 6): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-PT", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export default function AiWizardPanel({
  ctx,
  accountId,
  baseCurrency,
  trades,
  cash,
  interest,
  summary,
  pdfCount,
}: AiWizardPanelProps) {
  const [hasKey, setHasKey] = React.useState<boolean | null>(null);
  const [keyInput, setKeyInput] = React.useState("");
  const [trAppText, setTrAppText] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [report, setReport] = React.useState<ValidationReport | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [applying, setApplying] = React.useState(false);
  const [applyMsg, setApplyMsg] = React.useState<string | null>(null);
  const [forceRefresh, setForceRefresh] = React.useState(false);

  // Build the snapshot up-front so the user can see it before clicking
  // Validate. Memoised on parser outputs — recomputes when a new PDF lands.
  const snapshot: ValidationSnapshot = React.useMemo(
    () =>
      buildValidationSnapshot({
        cash: cash ?? [],
        interest: interest ?? [],
        trades,
        summaries: summary ? [summary] : [],
        baseCurrency,
        addonVersion: ADDON_VERSION,
        pdfCount: pdfCount ?? 0,
      }),
    [cash, interest, trades, summary, baseCurrency, pdfCount],
  );

  React.useEffect(() => {
    void loadApiKey(ctx).then((k) => setHasKey(!!k));
  }, [ctx]);

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed.startsWith("sk-ant-")) {
      setErrorMsg("API key inválida. Tem de começar com 'sk-ant-'.");
      return;
    }
    await saveApiKey(ctx, trimmed);
    setHasKey(true);
    setKeyInput("");
    setErrorMsg(null);
  };

  const handleClearKey = async () => {
    await clearApiKey(ctx);
    setHasKey(false);
    setReport(null);
  };

  const handleValidate = async () => {
    setErrorMsg(null);
    setApplyMsg(null);
    setReport(null);
    setSelected(new Set());
    if (!accountId) {
      setErrorMsg("Conta TR não selecionada.");
      return;
    }
    if (!trAppText.trim()) {
      setErrorMsg("Cola os teus holdings do TR app primeiro.");
      return;
    }
    const apiKey = await loadApiKey(ctx);
    if (!apiKey) {
      setErrorMsg("API key não configurada.");
      return;
    }

    setRunning(true);
    try {
      let dfHoldings: Holding[] = [];
      try {
        dfHoldings = await ctx.api.portfolio.getHoldings(accountId);
      } catch (err) {
        ctx.api.logger.warn(
          `[TR PDF AI] failed to fetch Donkeyfolio holdings: ${(err as Error).message}`,
        );
      }

      const result = await runAiValidationFromSnapshot(apiKey, snapshot, trAppText.trim(), {
        forceRefresh,
        donkeyfolioHoldings: dfHoldings,
      });
      setReport(result);
      // Pre-select all major + critical findings — those are the ones the
      // user almost certainly wants to fix.
      const preselect = new Set<number>();
      result.findings.forEach((f, idx) => {
        if (f.severity === "major" || f.severity === "critical") preselect.add(idx);
      });
      setSelected(preselect);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const handleApplySelected = async () => {
    if (!report || selected.size === 0 || !accountId) return;
    setApplying(true);
    setApplyMsg(null);
    let applied = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const idx of selected) {
      const finding = report.findings[idx];
      if (!finding.suggestedFix || finding.suggestedFix.action === "INFO_ONLY") {
        skipped += 1;
        continue;
      }
      try {
        await applyFindingFix(ctx, accountId, baseCurrency, finding);
        applied += 1;
      } catch (err) {
        skipped += 1;
        errors.push(`${finding.identifier}: ${(err as Error).message}`);
      }
    }
    setApplying(false);
    setApplyMsg(
      `Aplicadas ${applied} fixes${skipped > 0 ? `, ${skipped} ignoradas` : ""}.${
        errors.length > 0 ? ` Erros: ${errors.slice(0, 3).join("; ")}` : ""
      }`,
    );

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const portfolio = (ctx.api as any).portfolio;
      portfolio?.recalculate?.().catch(() => {
        // non-fatal
      });
    } catch {
      // non-fatal
    }
  };

  return (
    <Card>
      <div className="border-b px-3 py-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-semibold">AI Validation Wizard · v3.1.0</span>
          <span className="text-muted-foreground">
            Powered by Claude · BYO key · cache local · ~€0.08 fresh / €0 cached
          </span>
        </div>
      </div>

      {/* Snapshot preview tile — what Claude is going to see */}
      <div className="bg-muted/30 border-b px-3 py-2 text-xs">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 font-medium">
          <span>
            Snapshot {snapshot.meta.schemaVersion} · {snapshot.totals.tradeCount} trades ·{" "}
            {snapshot.totals.holdingsCount} ISINs ·{" "}
            {snapshot.meta.period.from && snapshot.meta.period.to
              ? `${snapshot.meta.period.from} → ${snapshot.meta.period.to}`
              : "sem período"}
          </span>
          {/* Parse quality: % of values parsed via the strict regex path */}
          {(() => {
            const total = snapshot.totals.parseStrictHits + snapshot.totals.parseHeuristicHits;
            if (total === 0) return null;
            const pct = Math.round((snapshot.totals.parseStrictHits / total) * 100);
            const cls =
              pct === 100
                ? "text-green-600 dark:text-green-400"
                : pct >= 95
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400";
            const samples = snapshot.totals.parseHeuristicSamples ?? [];
            const tooltip =
              samples.length > 0
                ? `${samples.length} sample(s) escaping strict regex:\n${samples.join("\n")}`
                : undefined;
            return (
              <span className={`font-mono text-[10px] ${cls}`} title={tooltip}>
                Parse strict {pct}% ({snapshot.totals.parseStrictHits}/{total})
                {pct < 100 && samples.length > 0 ? " ⓘ" : ""}
              </span>
            );
          })()}
        </div>
        {snapshot.totals.parseHeuristicSamples?.length > 0 && (
          <div className="text-muted-foreground mt-1 font-mono text-[10px]">
            Heuristic samples: {snapshot.totals.parseHeuristicSamples.slice(0, 8).join(" · ")}
          </div>
        )}
        {snapshot.perYear && snapshot.perYear.length > 0 && (
          <div className="mt-2 border-t pt-2">
            <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase tracking-wider">
              Per-year (cross-check fiscal report)
            </div>
            <div className="space-y-1 font-mono text-[10px]">
              {snapshot.perYear.map((y) => (
                <div key={y.year} className="border-muted border-l-2 pl-2">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-foreground font-semibold">{y.year}</span>
                    <span>
                      Fees: <span className="font-semibold">€{y.totalFees}</span> ({y.buyOrders} BUY
                      + {y.sellOrders} SELL)
                    </span>
                    <span>
                      Realized:{" "}
                      <span
                        className={
                          y.realizedPnlEur >= 0
                            ? "font-semibold text-emerald-600 dark:text-emerald-400"
                            : "font-semibold text-red-600 dark:text-red-400"
                        }
                      >
                        {y.realizedPnlEur >= 0 ? "+" : ""}€
                        {y.realizedPnlEur.toLocaleString("pt-PT")}
                      </span>
                    </span>
                  </div>
                  <div className="text-muted-foreground flex flex-wrap gap-x-3">
                    <span>Invested: €{y.invested.toLocaleString("pt-PT")}</span>
                    <span>Sold: €{y.divested.toLocaleString("pt-PT")}</span>
                    <span>Earnings: €{y.earnings.toLocaleString("pt-PT")}</span>
                    <span>Juros: €{y.interestIn.toLocaleString("pt-PT")}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-0.5 md:grid-cols-4">
          <span>Investido: {fmtEur(snapshot.cashflow.invested)}</span>
          <span>Vendido: {fmtEur(snapshot.cashflow.divested)}</span>
          <span>Fees: {fmtEur(snapshot.cashflow.tradingFees)}</span>
          <span>Juros: {fmtEur(snapshot.cashflow.interestIn)}</span>
          <span>Depósitos: {fmtEur(snapshot.cashflow.deposits)}</span>
          <span>Levant.: {fmtEur(snapshot.cashflow.withdrawals)}</span>
          <span>Earnings: {fmtEur(snapshot.cashflow.earnings)}</span>
          <span>Rewards: {fmtEur(snapshot.cashflow.rewards)}</span>
          <span>Internal: {fmtEur(snapshot.cashflow.internalTransfers)}</span>
          <span>Refunds: {fmtEur(snapshot.cashflow.refunds)}</span>
          <span>Cost basis: {fmtEur(snapshot.totals.totalCostBasisEur)}</span>
          <span>Realizado: {fmtEur(snapshot.totals.totalRealizedPnlEur)}</span>
        </div>
        {snapshot.saldoChain.openingFromSummary !== null && (
          <div className="text-muted-foreground mt-1">
            Saldo: {fmtEur(snapshot.saldoChain.openingFromSummary)} →{" "}
            {fmtEur(snapshot.saldoChain.closingFromSummary)} (computado{" "}
            {fmtEur(snapshot.saldoChain.computedClosing)}, Δ {fmtEur(snapshot.saldoChain.delta)}){" "}
            {snapshot.saldoChain.reconciles ? "✓" : "⚠"}
          </div>
        )}
        {snapshot.unresolved.length > 0 && (
          <div className="mt-1 text-amber-700 dark:text-amber-400">
            ⚠ {snapshot.unresolved.length} linhas sem qty resolvido
          </div>
        )}
      </div>

      {/* API key section */}
      {hasKey === null ? (
        <div className="text-muted-foreground p-4 text-xs">A verificar configuração…</div>
      ) : !hasKey ? (
        <div className="space-y-2 p-4">
          <p className="text-xs">
            Cola a tua API key Anthropic. Guardada encriptada via Wealthfolio Secrets, nunca sai da
            tua máquina exceto para a call a api.anthropic.com.
          </p>
          <p className="text-muted-foreground text-xs">
            Obtém em{" "}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              console.anthropic.com/settings/keys
            </a>
            .
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="sk-ant-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              className="border-input bg-background flex-1 rounded border px-2 py-1 font-mono text-xs"
            />
            <Button size="sm" onClick={handleSaveKey}>
              Save key
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">
              ✓ API key configurada (encriptada)
            </span>
            <Button variant="ghost" size="sm" onClick={handleClearKey} className="h-6 text-xs">
              Remove key
            </Button>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">
              Cola os teus holdings do TR app (qualquer formato — Claude parse-ia):
            </label>
            <textarea
              value={trAppText}
              onChange={(e) => setTrAppText(e.target.value)}
              placeholder={
                "Ex:\nADA  3867.134201  €1971.94\nSOFI  331.243403  €3617.30\nNVO  76.158256  €4621.50\n..."
              }
              rows={8}
              className="border-input bg-background w-full rounded border px-2 py-1 font-mono text-xs"
            />
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleValidate} disabled={running || !trAppText.trim()}>
              {running ? "A validar com Claude…" : "Validate"}
            </Button>
            <label className="text-muted-foreground flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={forceRefresh}
                onChange={(e) => setForceRefresh(e.target.checked)}
              />
              Forçar refresh (ignora cache)
            </label>
            {errorMsg && <span className="text-destructive text-xs">{errorMsg}</span>}
          </div>

          {/* Report */}
          {report && (
            <div className="space-y-2 pt-2">
              <div className="border-t pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{report.summary}</span>
                  <span className="text-muted-foreground text-xs">
                    {report.fromCache ? (
                      <>cache hit · €0.000</>
                    ) : report.usage ? (
                      <>
                        {report.usage.inputTokens} in ({report.usage.cachedTokens} cached) +{" "}
                        {report.usage.outputTokens} out · ~€
                        {report.usage.estimatedCostEur.toFixed(3)}
                      </>
                    ) : null}
                  </span>
                </div>
                <p className="text-muted-foreground text-xs">
                  {report.totalFindings} findings.{" "}
                  {selected.size > 0 ? `${selected.size} selecionadas para aplicar.` : ""}
                </p>
              </div>

              {report.findings.length === 0 ? (
                <p className="rounded bg-green-50 p-3 text-xs text-green-700 dark:bg-green-950/30 dark:text-green-400">
                  ✓ Nenhum drift detectado. Tudo bate com o TR app.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8"></TableHead>
                      <TableHead>ID</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Sev</TableHead>
                      <TableHead className="text-right">TR app</TableHead>
                      <TableHead className="text-right">Imported</TableHead>
                      <TableHead className="text-right">Δ</TableHead>
                      <TableHead>Descrição / Fix</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.findings.map((f, idx) => {
                      const sev = SEVERITY_BADGE[f.severity];
                      const fixable = !!f.suggestedFix && f.suggestedFix.action !== "INFO_ONLY";
                      return (
                        <TableRow key={idx}>
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={selected.has(idx)}
                              onChange={(e) => {
                                const next = new Set(selected);
                                if (e.target.checked) next.add(idx);
                                else next.delete(idx);
                                setSelected(next);
                              }}
                              disabled={!fixable}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-xs">{f.identifier}</TableCell>
                          <TableCell className="font-mono text-xs">{f.type}</TableCell>
                          <TableCell>
                            <Badge variant={sev.variant} className="text-xs">
                              {sev.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {fmtNum(f.expected)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {fmtNum(f.actual)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {fmtNum(f.diff)}
                            {typeof f.diffPct === "number" && (
                              <div className="text-muted-foreground">{f.diffPct.toFixed(2)}%</div>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[360px]">
                            <div className="text-xs">{f.description}</div>
                            {f.suggestedFix && f.suggestedFix.action !== "INFO_ONLY" && (
                              <div className="text-muted-foreground mt-1 font-mono text-[10px]">
                                → {f.suggestedFix.action}{" "}
                                {Object.entries(f.suggestedFix.params)
                                  .map(([k, v]) => `${k}=${v}`)
                                  .join(" ")}
                              </div>
                            )}
                            {f.reasoning && (
                              <div className="text-muted-foreground mt-1 text-xs italic">
                                {f.reasoning}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}

              {report.findings.some(
                (f) => f.suggestedFix && f.suggestedFix.action !== "INFO_ONLY",
              ) && (
                <div className="flex items-center gap-2 pt-2">
                  <Button
                    onClick={handleApplySelected}
                    disabled={applying || selected.size === 0}
                    variant="default"
                  >
                    {applying ? `A aplicar ${selected.size}…` : `Apply ${selected.size} selected`}
                  </Button>
                  {applyMsg && <span className="text-xs">{applyMsg}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Translate a Finding's suggestedFix into an SDK call.
 * Each action maps to a specific activity create or asset edit. Throws on
 * unknown action so the caller surfaces it instead of silently no-oping.
 */
async function applyFindingFix(
  ctx: AddonContext,
  accountId: string,
  baseCurrency: string,
  finding: Finding,
): Promise<void> {
  if (!finding.suggestedFix) return;
  const today = new Date().toISOString().slice(0, 10);
  const isin = finding.identifier;
  const { action, params } = finding.suggestedFix;

  switch (action) {
    case "ADD_SPLIT": {
      const ratio = Number(params.ratio ?? 0);
      const date = (params.date as string | undefined) ?? today;
      if (!Number.isFinite(ratio) || ratio <= 0) {
        throw new Error("ADD_SPLIT requires positive 'ratio' param.");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.api.activities as any).create({
        accountId,
        activityType: "SPLIT",
        activityDate: date,
        symbol: { symbol: isin, kind: "EQUITY" },
        quantity: 1,
        unitPrice: 0,
        amount: ratio,
        currency: baseCurrency,
        comment: `AI wizard: ${finding.reasoning.slice(0, 200)}`,
        idempotencyKey: `tr-pdf-ai:split:${isin}:${date}:${ratio}`,
        sourceSystem: "TR_PDF_AI",
        sourceRecordId: `tr-pdf-ai:split:${isin}:${date}:${ratio}`,
      });
      return;
    }
    case "ADD_BUY":
    case "ADD_SELL": {
      const qty = Number(params.quantity ?? 0);
      const unitPrice = Number(params.unitPrice ?? 0);
      const amount = Number(params.amount ?? qty * unitPrice);
      const fee = Number(params.fee ?? 0);
      const date = (params.date as string | undefined) ?? today;
      const subtype = (params.subtype as string | undefined) ?? null;
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error(`${action} requires positive 'quantity' param.`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.api.activities as any).create({
        accountId,
        activityType: action === "ADD_BUY" ? "BUY" : "SELL",
        activityDate: date,
        subtype,
        symbol: { symbol: isin, kind: "EQUITY" },
        quantity: qty,
        unitPrice,
        amount,
        fee,
        currency: baseCurrency,
        comment: `AI wizard: ${finding.reasoning.slice(0, 200)}`,
        idempotencyKey: `tr-pdf-ai:${action.toLowerCase()}:${isin}:${date}:${qty}`,
        sourceSystem: "TR_PDF_AI",
        sourceRecordId: `tr-pdf-ai:${action.toLowerCase()}:${isin}:${date}:${qty}`,
      });
      return;
    }
    case "ADD_TRANSFER_IN": {
      const qty = Number(params.quantity ?? 0);
      const costBasis = Number(params.costBasisEur ?? 0);
      const date = (params.date as string | undefined) ?? today;
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error("ADD_TRANSFER_IN requires positive 'quantity' param.");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.api.activities as any).create({
        accountId,
        activityType: "TRANSFER_IN",
        activityDate: date,
        symbol: { symbol: isin, kind: "EQUITY" },
        quantity: qty,
        unitPrice: qty > 0 ? costBasis / qty : 0,
        amount: costBasis,
        fee: 0,
        currency: baseCurrency,
        comment: `AI wizard: ${finding.reasoning.slice(0, 200)}`,
        idempotencyKey: `tr-pdf-ai:transfer-in:${isin}:${date}:${qty}`,
        sourceSystem: "TR_PDF_AI",
        sourceRecordId: `tr-pdf-ai:transfer-in:${isin}:${date}:${qty}`,
      });
      return;
    }
    case "INFO_ONLY":
      return;
    default:
      throw new Error(`Action '${action}' not yet wired. The fix needs to be applied manually.`);
  }
}
