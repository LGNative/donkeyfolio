/**
 * AI Validation Wizard panel. (v3.0.0)
 *
 * The wizard sits below the parsed-details disclosure and runs after a
 * successful import. It asks Claude to compare three sources of truth
 * (addon's PDF parse, Donkeyfolio's current holdings, user-pasted TR app
 * ground truth) and produces a list of actionable fixes the user can
 * approve and apply via the Wealthfolio SDK.
 *
 * Flow:
 *   1. User configures API key once (stored via ctx.api.secrets).
 *   2. User pastes their TR app holdings (free-form — Claude parses).
 *   3. Click "Validate" → 1 Claude API call (~€0.08 with prompt caching).
 *   4. Render issues sorted by severity. Each issue has a checkbox.
 *   5. User checks the ones to apply → "Apply Selected" button.
 *   6. Addon emits the SDK calls (SPLIT, BUY, asset-edit, etc.).
 *
 * Privacy:
 *   The API key never leaves the user's machine except for the call to
 *   api.anthropic.com. We never log it. We send only AGGREGATED holdings
 *   to Claude (not per-trade detail).
 */
import * as React from "react";
import type { AddonContext, Holding } from "@wealthfolio/addon-sdk";
import { Card } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@wealthfolio/ui";
import {
  aggregateImportedForValidation,
  projectDonkeyfolioHoldings,
  runAiValidation,
  type ValidationIssue,
  type ValidationReport,
} from "../lib/tr-ai-validator";
import type { TradingTransaction } from "../lib/tr-parser";

const SECRET_KEY_API = "anthropic_api_key";

interface AiWizardPanelProps {
  ctx: AddonContext;
  accountId: string | null;
  baseCurrency: string;
  trades: TradingTransaction[];
  /** When provided, pre-populates the "known issues" hint to Claude. */
  knownIssues?: string[];
}

/**
 * Why this is a ref-load, not state-stored:
 *   The API key is sensitive. We read it from SecretsAPI on demand
 *   (right before the call) instead of holding it in component state
 *   where a React DevTools snapshot would expose it.
 */
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
  ValidationIssue["severity"],
  { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
> = {
  critical: { variant: "destructive", label: "CRITICAL" },
  major: { variant: "destructive", label: "MAJOR" },
  minor: { variant: "secondary", label: "MINOR" },
  info: { variant: "outline", label: "INFO" },
};

export default function AiWizardPanel({
  ctx,
  accountId,
  baseCurrency,
  trades,
  knownIssues,
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
      // Fetch current Donkeyfolio holdings for diffing.
      let dfHoldings: Holding[] = [];
      try {
        dfHoldings = await ctx.api.portfolio.getHoldings(accountId);
      } catch (err) {
        ctx.api.logger.warn(
          `[TR PDF AI] failed to fetch Donkeyfolio holdings: ${(err as Error).message}`,
        );
      }

      const result = await runAiValidation(apiKey, {
        baseCurrency,
        importedHoldings: aggregateImportedForValidation(trades),
        donkeyfolioHoldings: projectDonkeyfolioHoldings(dfHoldings),
        trAppGroundTruth: trAppText.trim(),
        knownIssues,
      });
      setReport(result);
      // Pre-select all major + critical issues — those are the ones the
      // user almost certainly wants to fix.
      const preselect = new Set<number>();
      result.issues.forEach((iss, idx) => {
        if (iss.severity === "major" || iss.severity === "critical") preselect.add(idx);
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
      const issue = report.issues[idx];
      try {
        await applyIssueFix(ctx, accountId, baseCurrency, issue);
        applied += 1;
      } catch (err) {
        skipped += 1;
        errors.push(`${issue.identifier}: ${(err as Error).message}`);
      }
    }
    setApplying(false);
    setApplyMsg(
      `Aplicadas ${applied} fixes${skipped > 0 ? `, ${skipped} falharam` : ""}.${
        errors.length > 0 ? ` Erros: ${errors.slice(0, 3).join("; ")}` : ""
      }`,
    );

    // Trigger recalc so the holdings page updates immediately.
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
          <span className="font-semibold">AI Validation Wizard</span>
          <span className="text-muted-foreground">
            Powered by Claude · uses your Anthropic API key · ~€0.08 per validation
          </span>
        </div>
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

          {/* TR app paste */}
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

          <div className="flex items-center gap-2">
            <Button onClick={handleValidate} disabled={running || !trAppText.trim()}>
              {running ? "A validar com Claude…" : "Validate"}
            </Button>
            {errorMsg && <span className="text-destructive text-xs">{errorMsg}</span>}
          </div>

          {/* Report */}
          {report && (
            <div className="space-y-2 pt-2">
              <div className="border-t pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{report.summary}</span>
                  {report.usage && (
                    <span className="text-muted-foreground text-xs">
                      {report.usage.inputTokens} input ({report.usage.cachedTokens} cached) +{" "}
                      {report.usage.outputTokens} output · ~€
                      {report.usage.estimatedCostEur.toFixed(3)}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">
                  {report.totalIssues} issues encontrados.{" "}
                  {selected.size > 0 ? `${selected.size} selecionadas para aplicar.` : ""}
                </p>
              </div>

              {report.issues.length === 0 ? (
                <p className="rounded bg-green-50 p-3 text-xs text-green-700 dark:bg-green-950/30 dark:text-green-400">
                  ✓ Nenhum drift detectado. Tudo bate com o TR app.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8"></TableHead>
                      <TableHead>Identifier</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Description</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.issues.map((issue, idx) => {
                      const sev = SEVERITY_BADGE[issue.severity];
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
                              disabled={issue.action === "INFO_ONLY"}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-xs">{issue.identifier}</TableCell>
                          <TableCell>
                            <Badge variant={sev.variant} className="text-xs">
                              {sev.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{issue.action}</TableCell>
                          <TableCell className="max-w-[400px]">
                            <div className="text-xs">{issue.description}</div>
                            {issue.reasoning && (
                              <div className="text-muted-foreground mt-1 text-xs italic">
                                {issue.reasoning}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}

              {report.issues.some((i) => i.action !== "INFO_ONLY") && (
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
 * Translate one ValidationIssue into a SDK call. Each action maps to a
 * specific activity create or asset edit. Throws on unknown action so the
 * caller surfaces it to the user instead of silently no-oping.
 */
async function applyIssueFix(
  ctx: AddonContext,
  accountId: string,
  baseCurrency: string,
  issue: ValidationIssue,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const isin = issue.identifier;

  switch (issue.action) {
    case "ADD_SPLIT": {
      const ratio = Number(issue.params.ratio ?? 0);
      const date = (issue.params.date as string | undefined) ?? today;
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
        comment: `AI wizard: ${issue.reasoning.slice(0, 200)}`,
        idempotencyKey: `tr-pdf-ai:split:${isin}:${date}:${ratio}`,
        sourceSystem: "TR_PDF_AI",
        sourceRecordId: `tr-pdf-ai:split:${isin}:${date}:${ratio}`,
      });
      return;
    }
    case "ADD_BUY":
    case "ADD_SELL": {
      const qty = Number(issue.params.quantity ?? 0);
      const unitPrice = Number(issue.params.unitPrice ?? 0);
      const amount = Number(issue.params.amount ?? qty * unitPrice);
      const fee = Number(issue.params.fee ?? 0);
      const date = (issue.params.date as string | undefined) ?? today;
      const subtype = (issue.params.subtype as string | undefined) ?? null;
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error(`${issue.action} requires positive 'quantity' param.`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.api.activities as any).create({
        accountId,
        activityType: issue.action === "ADD_BUY" ? "BUY" : "SELL",
        activityDate: date,
        subtype,
        symbol: { symbol: isin, kind: "EQUITY" },
        quantity: qty,
        unitPrice,
        amount,
        fee,
        currency: baseCurrency,
        comment: `AI wizard: ${issue.reasoning.slice(0, 200)}`,
        idempotencyKey: `tr-pdf-ai:${issue.action.toLowerCase()}:${isin}:${date}:${qty}`,
        sourceSystem: "TR_PDF_AI",
        sourceRecordId: `tr-pdf-ai:${issue.action.toLowerCase()}:${isin}:${date}:${qty}`,
      });
      return;
    }
    case "ADD_TRANSFER_IN": {
      const qty = Number(issue.params.quantity ?? 0);
      const costBasis = Number(issue.params.costBasisEur ?? 0);
      const date = (issue.params.date as string | undefined) ?? today;
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
        comment: `AI wizard: ${issue.reasoning.slice(0, 200)}`,
        idempotencyKey: `tr-pdf-ai:transfer-in:${isin}:${date}:${qty}`,
        sourceSystem: "TR_PDF_AI",
        sourceRecordId: `tr-pdf-ai:transfer-in:${isin}:${date}:${qty}`,
      });
      return;
    }
    case "INFO_ONLY":
      // Nothing to do — informational only.
      return;
    default:
      throw new Error(
        `Action '${issue.action}' not yet wired. The fix needs to be applied manually.`,
      );
  }
}
