/**
 * AI-powered validation wizard. (v3.1.0)
 *
 * v3.1.0 contract change — Claude validates, doesn't calculate.
 *
 *   We ship a deterministic ValidationSnapshot (built by
 *   tr-validation-snapshot.ts) plus the user's TR-app paste. Claude only
 *   COMPARES and reports drift — no math. Same snapshot bytes → same
 *   prompt → cached response. The wizard's numbers stop drifting between
 *   runs because the inputs are stable and the LLM isn't free-handing
 *   arithmetic.
 *
 * Cache:
 *   localStorage key: `tr-pdf-ai:cache:{snapshotHash}:{trAppHash}:{PROMPT_VERSION}`
 *   Hit → instant return, zero API cost. Miss → live call, then cache.
 *
 * Privacy:
 *   API key supplied by the user, stored via Wealthfolio Secrets
 *   (encrypted at rest), never leaves the machine except for the call to
 *   api.anthropic.com. We send the snapshot (aggregated holdings + bucket
 *   totals) + the user's paste — no per-trade detail beyond what the
 *   snapshot already encodes.
 *
 * Backward compat:
 *   The legacy `runAiValidation` / `aggregateImportedForValidation` /
 *   `projectDonkeyfolioHoldings` exports remain for any caller still on
 *   the v3.0.x surface. New callers should use `runAiValidationFromSnapshot`.
 */

import type { Holding } from "@wealthfolio/addon-sdk";
import type { TradingTransaction } from "./tr-parser";
import { buildEurHoldings, type EurHoldingRow } from "./tr-eur-holdings";
import { hashSnapshot, SNAPSHOT_VERSION, type ValidationSnapshot } from "./tr-validation-snapshot";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_VERSION = "2023-06-01";

/** Prompt version. Bump when the system prompt changes shape so cached
 *  responses from older prompts get invalidated. */
const PROMPT_VERSION = "v2";

const CACHE_KEY_PREFIX = "tr-pdf-ai:cache:";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Public types ────────────────────────────────────────────────────

/** What kind of drift a finding represents. */
export type FindingType =
  | "qty_drift"
  | "cost_basis_drift"
  | "missing_position"
  | "extra_position"
  | "missing_split"
  | "missing_staking"
  | "duplicate_row"
  | "saldo_mismatch"
  | "fee_drift"
  | "info";

/** Suggested fix actions — exactly the SDK calls the wizard knows how to issue. */
export type ValidationFixAction =
  | "ADD_BUY"
  | "ADD_SELL"
  | "ADD_SPLIT"
  | "ADD_TRANSFER_IN"
  | "ADJUST_FEE"
  | "ADJUST_QUANTITY"
  | "EDIT_ASSET_CURRENCY"
  | "EDIT_ASSET_KIND"
  | "DELETE_DUPLICATE"
  | "INFO_ONLY";

export interface Finding {
  /** Drift category. */
  type: FindingType;
  /** UI sort + colour. */
  severity: "info" | "minor" | "major" | "critical";
  /** ISIN, symbol, "CASH", "SALDO". */
  identifier: string;
  /** Plain-language summary (PT preferred when paste is PT). */
  description: string;
  /** Value from the user's TR-app paste, when comparable. */
  expected?: number;
  /** Value from the snapshot (what we imported), when comparable. */
  actual?: number;
  /** Computed delta (expected − actual). */
  diff?: number;
  /** Percentage delta vs expected. */
  diffPct?: number;
  /** Free-text reasoning Claude provides. */
  reasoning: string;
  /** Optional structured fix the wizard can apply via SDK. */
  suggestedFix?: {
    action: ValidationFixAction;
    params: Record<string, string | number | null>;
  };
}

export interface ValidationReport {
  summary: string;
  totalFindings: number;
  findings: Finding[];
  /** True when this report was returned from localStorage cache (no API call). */
  fromCache: boolean;
  /** Stable hash of the (snapshot + paste + prompt) tuple. */
  cacheKey: string;
  /** Token / cost telemetry from the API response (absent on cache hits). */
  usage?: {
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    estimatedCostEur: number;
  };
}

// ─── Legacy compat — keep v3.0.x surface so callers can migrate gradually ──

/** @deprecated Use ValidationSnapshot via runAiValidationFromSnapshot. */
export type ValidationFixActionLegacy = ValidationFixAction;
/** @deprecated Use Finding. */
export interface ValidationIssue {
  identifier: string;
  description: string;
  severity: "info" | "minor" | "major" | "critical";
  action: ValidationFixAction;
  params: Record<string, string | number | null>;
  reasoning: string;
}

/** @deprecated Use ValidationSnapshot. */
export interface ValidationInput {
  baseCurrency: string;
  importedHoldings: Array<{
    isin: string;
    symbol: string;
    name: string;
    qty: number;
    costBasisEur: number;
    avgCostEur: number;
    buyCount: number;
    sellCount: number;
  }>;
  donkeyfolioHoldings: Array<{
    symbol?: string;
    isin?: string;
    name?: string;
    qty: number;
    costBasisLocal?: number;
    costBasisBase?: number;
    localCurrency: string;
  }>;
  trAppGroundTruth: string;
  knownIssues?: string[];
}

export function aggregateImportedForValidation(
  trades: TradingTransaction[],
): ValidationInput["importedHoldings"] {
  const rows = buildEurHoldings(trades);
  return rows
    .filter((r: EurHoldingRow) => r.qty > 1e-9)
    .map((r) => ({
      isin: r.isin,
      symbol: r.symbol,
      name: r.name,
      qty: r.qty,
      costBasisEur: r.costBasisEur,
      avgCostEur: r.avgCostEur,
      buyCount: r.buyCount,
      sellCount: r.sellCount,
    }));
}

export function projectDonkeyfolioHoldings(
  holdings: Holding[],
): ValidationInput["donkeyfolioHoldings"] {
  return holdings.map((h) => ({
    symbol: h.instrument?.symbol,
    isin: undefined,
    name: h.instrument?.name ?? undefined,
    qty: h.quantity,
    costBasisLocal: h.costBasis?.local ?? undefined,
    costBasisBase: h.costBasis?.base ?? undefined,
    localCurrency: h.localCurrency,
  }));
}

// ─── New v3.1.0 prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a financial-data VALIDATOR — not a calculator — embedded in a Trade Republic (TR) PDF importer for the Wealthfolio investment tracker.

Your contract:
  - You receive a deterministic SNAPSHOT (JSON) of what the addon imported from PDFs, plus the user's TR-app ground-truth paste.
  - The snapshot's totals (cashflow buckets, FIFO cost basis, qty per ISIN, saldo chain) are PRE-COMPUTED. You MUST NOT re-derive them. Trust them as given.
  - Your only job: compare the snapshot to the TR_APP paste, find drift, and report STRUCTURED findings.

Output schema (return ONLY this JSON, no prose, no fences):

{
  "summary": string,
  "totalFindings": number,
  "findings": [
    {
      "type": "qty_drift" | "cost_basis_drift" | "missing_position" | "extra_position" | "missing_split" | "missing_staking" | "duplicate_row" | "saldo_mismatch" | "fee_drift" | "info",
      "severity": "info" | "minor" | "major" | "critical",
      "identifier": string,         // ISIN, symbol, "CASH", or "SALDO"
      "description": string,        // PT when the paste is PT, else EN
      "expected": number | null,    // value from TR_APP paste
      "actual": number | null,      // value from snapshot
      "diff": number | null,        // expected - actual
      "diffPct": number | null,     // (expected - actual) / expected * 100
      "reasoning": string,
      "suggestedFix": {
        "action": "ADD_BUY" | "ADD_SELL" | "ADD_SPLIT" | "ADD_TRANSFER_IN" | "ADJUST_FEE" | "ADJUST_QUANTITY" | "EDIT_ASSET_CURRENCY" | "EDIT_ASSET_KIND" | "DELETE_DUPLICATE" | "INFO_ONLY",
        "params": object
      } | null
    }
  ]
}

Tolerance bands:
  - qty drift |actual − expected| ≤ 1e-4 → MATCH (no finding)
  - qty drift ≤ 0.5% → minor
  - qty drift > 0.5% → major
  - cost basis drift ≤ 0.5% → MATCH; ≤ 2% → minor; > 2% → major
  - saldoChain.delta absolute ≤ €0.01 → already reconciled, no finding
  - saldoChain.delta absolute > €1 AND < €100 → minor
  - saldoChain.delta absolute ≥ €100 → critical

Common patterns to recognise:
  - snapshot.qty ≈ tr_app.qty / 2 → missing SPLIT (suggestedFix: ADD_SPLIT, params: { ratio: 2 })
  - tr_app.qty > snapshot.qty for crypto by a small fraction → missing STAKING_REWARD (suggestedFix: ADD_BUY with subtype STAKING_REWARD, params: { quantity: <delta> })
  - tr_app holds an ISIN absent from snapshot → missing_position (suggestedFix: ADD_TRANSFER_IN with params: { quantity, costBasisEur })
  - snapshot.tradingFees off by ~N×€1 from expected → fee_drift (suggestedFix: ADJUST_FEE, params: { delta })

Hard rules:
  - DO NOT recommend changes when sources match within tolerance.
  - DO NOT speculate beyond what the snapshot + paste support — if uncertain, type:"info", severity:"info", suggestedFix:null.
  - Use Portuguese in description/reasoning when the paste is in Portuguese.
  - Numeric fields: numbers (or null), never strings.
  - When the snapshot's saldoChain.reconciles is true, do NOT raise saldo_mismatch.`;

// ─── Cache helpers ──────────────────────────────────────────────────

interface CacheEntry {
  storedAt: number;
  report: Omit<ValidationReport, "fromCache" | "cacheKey">;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildCacheKey(snapshot: ValidationSnapshot, trApp: string): Promise<string> {
  const snapHash = await hashSnapshot(snapshot);
  const pasteHash = await sha256Hex(trApp.trim());
  return `${CACHE_KEY_PREFIX}${SNAPSHOT_VERSION}:${PROMPT_VERSION}:${snapHash.slice(0, 16)}:${pasteHash.slice(0, 16)}`;
}

function readCache(key: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (Date.now() - parsed.storedAt > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(key: string, report: ValidationReport): void {
  try {
    const { fromCache: _f, cacheKey: _k, ...rest } = report;
    void _f;
    void _k;
    const entry: CacheEntry = { storedAt: Date.now(), report: rest };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // localStorage full / disabled — non-fatal.
  }
}

// ─── New v3.1.0 entry point ─────────────────────────────────────────

export interface SnapshotValidationOptions {
  /** Ignore cache and force a fresh API call. */
  forceRefresh?: boolean;
  /** Override default model. */
  model?: string;
  /** Optional Donkeyfolio holdings for cross-checking what's already stored. */
  donkeyfolioHoldings?: Holding[];
}

/**
 * Run validation against a deterministic snapshot. Same (snapshot + paste +
 * prompt) tuple → cached response. New input → live API call → cached.
 */
export async function runAiValidationFromSnapshot(
  apiKey: string,
  snapshot: ValidationSnapshot,
  trAppGroundTruth: string,
  options: SnapshotValidationOptions = {},
): Promise<ValidationReport> {
  if (!apiKey || !apiKey.startsWith("sk-ant-")) {
    throw new Error(
      "Invalid Anthropic API key. Expected a key starting with 'sk-ant-'. " +
        "Get one at https://console.anthropic.com/settings/keys.",
    );
  }
  if (!trAppGroundTruth.trim()) {
    throw new Error("TR app ground-truth paste is empty.");
  }

  const cacheKey = await buildCacheKey(snapshot, trAppGroundTruth);
  if (!options.forceRefresh) {
    const cached = readCache(cacheKey);
    if (cached) {
      return { ...cached.report, fromCache: true, cacheKey };
    }
  }

  const userMessage = buildUserMessageFromSnapshot(snapshot, trAppGroundTruth, options);

  const body = {
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text" as const,
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" as const },
      },
    ],
    messages: [{ role: "user" as const, content: userMessage }],
  };

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errBody.slice(0, 500)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await res.json()) as any;
  const text =
    Array.isArray(json.content) && json.content[0]?.type === "text" ? json.content[0].text : "";
  if (!text) throw new Error("Anthropic returned empty content.");

  const report = parseValidationJson(text, cacheKey);
  if (json.usage) {
    const inputTokens = json.usage.input_tokens ?? 0;
    const cachedTokens = json.usage.cache_read_input_tokens ?? 0;
    const outputTokens = json.usage.output_tokens ?? 0;
    // Sonnet 4.5: $3/M input, $0.30/M cached read, $15/M output. EUR @ 1.07.
    const estimatedCostUsd =
      ((inputTokens - cachedTokens) * 3 + cachedTokens * 0.3 + outputTokens * 15) / 1_000_000;
    report.usage = {
      inputTokens,
      cachedTokens,
      outputTokens,
      estimatedCostEur: estimatedCostUsd / 1.07,
    };
  }

  writeCache(cacheKey, report);
  return report;
}

/** Project Donkeyfolio holdings to a small, hashable shape for the prompt. */
function projectDfHoldingsLite(holdings: Holding[]) {
  return holdings.map((h) => ({
    symbol: h.instrument?.symbol ?? null,
    name: h.instrument?.name ?? null,
    qty: h.quantity,
    costBasisLocal: h.costBasis?.local ?? null,
    costBasisBase: h.costBasis?.base ?? null,
    localCurrency: h.localCurrency,
  }));
}

function buildUserMessageFromSnapshot(
  snapshot: ValidationSnapshot,
  trApp: string,
  options: SnapshotValidationOptions,
): string {
  // Strip generatedAt from the prompt so the cache hash matches the on-wire
  // payload. Other meta is fine (deterministic per parse).
  const { generatedAt: _ts, ...metaRest } = snapshot.meta;
  void _ts;
  const promptSnapshot = { ...snapshot, meta: metaRest };

  return `Compare the SNAPSHOT (deterministic, pre-computed) to the TR_APP paste and emit findings.

# SNAPSHOT (addon's PDF parse, FIFO-aggregated to EUR — totals are authoritative)
\`\`\`json
${JSON.stringify(promptSnapshot, null, 2)}
\`\`\`

${
  options.donkeyfolioHoldings && options.donkeyfolioHoldings.length > 0
    ? `# DONKEYFOLIO_HOLDINGS (currently stored in Wealthfolio DB — for cross-check)
\`\`\`json
${JSON.stringify(projectDfHoldingsLite(options.donkeyfolioHoldings), null, 2)}
\`\`\`

`
    : ""
}# TR_APP (user's paste, ground truth)
\`\`\`
${trApp.trim()}
\`\`\`

Return the JSON report now.`;
}

function parseValidationJson(text: string, cacheKey: string): ValidationReport {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    const parsed = JSON.parse(cleaned);
    const findings: Finding[] = Array.isArray(parsed.findings)
      ? parsed.findings.map((f: Partial<Finding>) => ({
          type: (f.type as FindingType) ?? "info",
          severity: f.severity ?? "info",
          identifier: f.identifier ?? "",
          description: f.description ?? "",
          expected: typeof f.expected === "number" ? f.expected : undefined,
          actual: typeof f.actual === "number" ? f.actual : undefined,
          diff: typeof f.diff === "number" ? f.diff : undefined,
          diffPct: typeof f.diffPct === "number" ? f.diffPct : undefined,
          reasoning: f.reasoning ?? "",
          suggestedFix: f.suggestedFix ?? undefined,
        }))
      : // Tolerate the legacy `issues` array shape too — caller can still
        // upgrade incrementally.
        Array.isArray(parsed.issues)
        ? parsed.issues.map((i: Partial<ValidationIssue>) => ({
            type: "info" as FindingType,
            severity: i.severity ?? "info",
            identifier: i.identifier ?? "",
            description: i.description ?? "",
            reasoning: i.reasoning ?? "",
            suggestedFix: i.action
              ? {
                  action: i.action,
                  params: (i.params as Record<string, string | number | null>) ?? {},
                }
              : undefined,
          }))
        : [];
    return {
      summary: parsed.summary ?? "",
      totalFindings: parsed.totalFindings ?? parsed.totalIssues ?? findings.length,
      findings,
      fromCache: false,
      cacheKey,
    };
  } catch (err) {
    throw new Error(
      `Failed to parse Anthropic response as JSON: ${(err as Error).message}\n\n` +
        `Raw response (first 500 chars):\n${cleaned.slice(0, 500)}`,
    );
  }
}

// ─── Legacy entry point (deprecated, kept for compat) ───────────────

/**
 * @deprecated Use runAiValidationFromSnapshot.
 *
 * Kept so any caller still on the v3.0.x surface compiles. Internally
 * routes through the new snapshot-based path with a minimal synthetic
 * snapshot built from the imported holdings — the result is functionally
 * close but lacks saldo-chain / per-currency context.
 */
export async function runAiValidation(
  apiKey: string,
  input: ValidationInput,
  model: string = DEFAULT_MODEL,
): Promise<{
  summary: string;
  totalIssues: number;
  issues: ValidationIssue[];
  usage?: ValidationReport["usage"];
}> {
  // Build a minimal pseudo-snapshot from the legacy ValidationInput.
  const synthSnapshot: ValidationSnapshot = {
    meta: {
      schemaVersion: SNAPSHOT_VERSION,
      addonVersion: "legacy",
      baseCurrency: input.baseCurrency,
      pdfCount: 0,
      period: { from: null, to: null },
      generatedAt: new Date().toISOString(),
    },
    cashflow: {
      deposits: 0,
      withdrawals: 0,
      interestIn: 0,
      refunds: 0,
      tradingFees: 0,
      taxes: 0,
      invested: 0,
      divested: 0,
    },
    saldoChain: {
      openingFromSummary: null,
      computedClosing: null,
      closingFromSummary: null,
      delta: null,
      reconciles: null,
    },
    totals: {
      holdingsCount: input.importedHoldings.length,
      openPositions: input.importedHoldings.filter((h) => h.qty > 0).length,
      closedPositions: 0,
      totalCostBasisEur: input.importedHoldings.reduce((s, h) => s + h.costBasisEur, 0),
      totalRealizedPnlEur: 0,
      tradeCount: 0,
      interestRowCount: 0,
      cashRowCount: 0,
    },
    perIsin: input.importedHoldings.map((h) => ({
      isin: h.isin,
      symbol: h.symbol,
      name: h.name,
      qty: h.qty,
      costBasisEur: h.costBasisEur,
      avgCostEur: h.avgCostEur,
      totalBoughtEur: h.costBasisEur,
      totalSoldEur: 0,
      realizedPnlEur: 0,
      buyCount: h.buyCount,
      sellCount: h.sellCount,
      firstDate: "",
      lastDate: "",
    })),
    perCurrency: [],
    unresolved: [],
  };

  const report = await runAiValidationFromSnapshot(apiKey, synthSnapshot, input.trAppGroundTruth, {
    model,
  });

  // Adapt new findings shape back to legacy issues shape.
  return {
    summary: report.summary,
    totalIssues: report.totalFindings,
    issues: report.findings.map((f) => ({
      identifier: f.identifier,
      description: f.description,
      severity: f.severity,
      action: f.suggestedFix?.action ?? "INFO_ONLY",
      params: f.suggestedFix?.params ?? {},
      reasoning: f.reasoning,
    })),
    usage: report.usage,
  };
}
