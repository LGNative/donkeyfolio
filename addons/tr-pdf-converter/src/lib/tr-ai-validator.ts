/**
 * AI-powered validation wizard. (v2.21.0)
 *
 * Goal:
 *   Stop iterating on regex/heuristic fixes. Use Anthropic's Claude API
 *   as a validation layer that diffs the imported data against the user's
 *   ground truth (TR app holdings) and returns a STRUCTURED list of issues
 *   with concrete fix actions the addon can apply via the Wealthfolio SDK.
 *
 * Flow:
 *   1. User pastes their TR app holdings (free-form text — Claude parses
 *      it regardless of format).
 *   2. We assemble: addon's imported activities (aggregated to holdings),
 *      Donkeyfolio's current holdings (from ctx.api.portfolio.getHoldings),
 *      and the user's pasted text.
 *   3. ONE call to Claude Sonnet 4.5 with strict JSON output schema.
 *   4. We render the suggestions, user approves which fixes to apply.
 *   5. Addon emits the SDK calls (SPLIT activity, BUY/SELL adjustment,
 *      asset profile edit) for approved items.
 *
 * Why Claude Sonnet 4.5:
 *   - 200K context easily fits 30-50 holdings + thousands of activities
 *   - Strong JSON schema adherence
 *   - €0.08-0.15 per validation call (with prompt caching)
 *
 * Privacy:
 *   - User supplies their own API key (stored via Wealthfolio's SecretsAPI,
 *     encrypted at rest, never leaves their machine except for the actual
 *     API call to Anthropic).
 *   - We only send AGGREGATED holdings (qty + cost basis per ISIN) plus
 *     the user's TR app data. Per-trade detail stays local.
 *   - Anthropic's API has data-retention controls; the user can configure
 *     zero-retention if their workspace supports it.
 */

import type { Holding } from "@wealthfolio/addon-sdk";
import type { TradingTransaction } from "./tr-parser";
import { buildEurHoldings, type EurHoldingRow } from "./tr-eur-holdings";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The structured response schema we ask Claude to return. Keeping this
 * narrow — every field is something the addon can turn into an SDK call
 * without further interpretation.
 */
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

export interface ValidationIssue {
  /** ISIN or symbol the issue applies to. "CASH" for the cash-balance row. */
  identifier: string;
  /** Human-readable summary. */
  description: string;
  /** Severity for UI sorting & color coding. */
  severity: "info" | "minor" | "major" | "critical";
  /** Suggested fix action (if any — INFO_ONLY when no action needed). */
  action: ValidationFixAction;
  /** Action-specific parameters (e.g. qty, ratio, currency). */
  params: Record<string, string | number | null>;
  /** Free-text reasoning Claude provides. */
  reasoning: string;
}

export interface ValidationReport {
  summary: string;
  totalIssues: number;
  issues: ValidationIssue[];
  /** Token / cost telemetry from the API response. */
  usage?: {
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    estimatedCostEur: number;
  };
}

/**
 * Inputs we hand Claude. Kept small so the call stays cheap and fast.
 * (Whole 4000-trade detail is NOT sent — we send aggregated holdings.)
 */
export interface ValidationInput {
  /** TR account base currency (always EUR for our user). */
  baseCurrency: string;
  /** Holdings the addon's PDF parser arrived at, aggregated by ISIN. */
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
  /** Holdings currently in Donkeyfolio (from ctx.api.portfolio.getHoldings). */
  donkeyfolioHoldings: Array<{
    symbol?: string;
    isin?: string;
    name?: string;
    qty: number;
    costBasisLocal?: number;
    costBasisBase?: number;
    localCurrency: string;
  }>;
  /** Raw paste from the user — TR app screenshot text or list. */
  trAppGroundTruth: string;
  /** Optional: known issues the user already saw, so Claude can skip them. */
  knownIssues?: string[];
}

/**
 * Convert the page's parsed trading transactions into the aggregated
 * holdings shape the validator wants. Reuses tr-eur-holdings.ts FIFO
 * computation so the validator sees exactly what the addon would emit.
 */
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

/** Narrow projection of SDK Holding to what the validator needs. */
export function projectDonkeyfolioHoldings(
  holdings: Holding[],
): ValidationInput["donkeyfolioHoldings"] {
  return holdings.map((h) => ({
    symbol: h.instrument?.symbol,
    isin: undefined, // Holdings API doesn't expose ISIN directly
    name: h.instrument?.name ?? undefined,
    qty: h.quantity,
    costBasisLocal: h.costBasis?.local ?? undefined,
    costBasisBase: h.costBasis?.base ?? undefined,
    localCurrency: h.localCurrency,
  }));
}

/**
 * The system prompt — the long, static piece that benefits from
 * Anthropic's prompt caching (90% discount on cached portion). We keep
 * everything that doesn't change per-call here so the cache hits hard
 * on subsequent validations.
 */
const SYSTEM_PROMPT = `You are a financial-data validator embedded in a Trade Republic (TR) PDF importer for the Wealthfolio investment tracker. Your job is to compare three sources of truth and produce a STRUCTURED diff with actionable fix suggestions.

The three sources are:
  1. IMPORTED — holdings the addon parsed from the user's TR PDF (FIFO-aggregated to EUR).
  2. DONKEYFOLIO — what is currently stored in the user's Wealthfolio database.
  3. TR_APP — the user's pasted ground truth from the TR mobile/web app.

You MUST output a single JSON object with this exact schema:

{
  "summary": string,         // one-sentence overall verdict
  "totalIssues": number,
  "issues": [
    {
      "identifier": string,  // ISIN, ticker, or "CASH" for cash-balance issues
      "description": string, // what's wrong, in plain language (Portuguese OK)
      "severity": "info" | "minor" | "major" | "critical",
      "action": "ADD_BUY" | "ADD_SELL" | "ADD_SPLIT" | "ADD_TRANSFER_IN"
              | "ADJUST_FEE" | "ADJUST_QUANTITY" | "EDIT_ASSET_CURRENCY"
              | "EDIT_ASSET_KIND" | "DELETE_DUPLICATE" | "INFO_ONLY",
      "params": object,      // action-specific fields (qty, ratio, currency, etc.)
      "reasoning": string    // why you suggest this action
    }
  ]
}

Rules:
- Output ONLY the JSON object. No prose before or after.
- Use Portuguese in description and reasoning fields when the user paste is in Portuguese.
- Tolerance bands: qty drift ≤ 0.0001 → MATCH (no issue). qty drift ≤ 0.5% → minor. qty drift > 0.5% → major. Cost basis drift ≤ 0.5% → MATCH; ≤ 2% → minor; > 2% → major.
- Common patterns:
  * Imported qty = real_qty / 2 → likely MISSING SPLIT. Suggest ADD_SPLIT with ratio.
  * TR_APP qty > IMPORTED qty for crypto → likely STAKING REWARDS missing. Suggest ADD_BUY with subtype STAKING_REWARD.
  * IMPORTED has 2+ rows on same date with same ISIN → DUPLICATE. Suggest DELETE_DUPLICATE.
  * Asset currency = USD but TR is EUR-only → user trade was in EUR; this is normal (asset's quote_ccy is its native exchange currency).
  * Cash balance off by ~1 EUR per trade → DOUBLE-FEE bug. Suggest ADJUST_FEE.
- DO NOT recommend changes when sources agree within tolerance.
- When in doubt, set action: "INFO_ONLY" with a clear description.`;

/**
 * Send the validation request to Anthropic and parse the structured response.
 * Throws on network or schema-violation errors. Caller should surface those
 * to the user with actionable error messages.
 */
export async function runAiValidation(
  apiKey: string,
  input: ValidationInput,
  model: string = DEFAULT_MODEL,
): Promise<ValidationReport> {
  if (!apiKey || !apiKey.startsWith("sk-ant-")) {
    throw new Error(
      "Invalid Anthropic API key. Expected a key starting with 'sk-ant-'. " +
        "Get one at https://console.anthropic.com/settings/keys.",
    );
  }

  // The system prompt is marked cache_control: ephemeral so subsequent
  // validations within 5 minutes hit the cache (90% input discount on
  // that portion). The user-specific data goes uncached.
  const userMessage = buildUserMessage(input);

  const body = {
    model,
    max_tokens: 4096,
    system: [
      {
        type: "text" as const,
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" as const },
      },
    ],
    messages: [
      {
        role: "user" as const,
        content: userMessage,
      },
    ],
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

  const report = parseValidationJson(text);
  // Attach usage telemetry for the UI's cost display.
  if (json.usage) {
    const inputTokens = json.usage.input_tokens ?? 0;
    const cachedTokens = json.usage.cache_read_input_tokens ?? 0;
    const outputTokens = json.usage.output_tokens ?? 0;
    // Anthropic Sonnet 4.5 pricing: $3/M input, $0.30/M cached, $15/M output.
    const estimatedCostUsd =
      ((inputTokens - cachedTokens) * 3 + cachedTokens * 0.3 + outputTokens * 15) / 1_000_000;
    report.usage = {
      inputTokens,
      cachedTokens,
      outputTokens,
      // Approx EUR at 1.07 USD/EUR (we don't fetch live FX for telemetry).
      estimatedCostEur: estimatedCostUsd / 1.07,
    };
  }
  return report;
}

/**
 * Build the user-message body for the Anthropic call. We embed the three
 * data sources as fenced blocks so Claude can find them reliably.
 */
function buildUserMessage(input: ValidationInput): string {
  return `Compare these three sources and report drift per ISIN.

# IMPORTED (addon's PDF parse, FIFO-aggregated to EUR)
\`\`\`json
${JSON.stringify(input.importedHoldings, null, 2)}
\`\`\`

# DONKEYFOLIO (currently stored in Wealthfolio DB)
\`\`\`json
${JSON.stringify(input.donkeyfolioHoldings, null, 2)}
\`\`\`

# TR_APP (user's pasted ground truth)
\`\`\`
${input.trAppGroundTruth}
\`\`\`

${
  input.knownIssues && input.knownIssues.length > 0
    ? `# KNOWN_ISSUES (user already aware — skip these)\n${input.knownIssues.map((s) => `- ${s}`).join("\n")}\n\n`
    : ""
}Base account currency: ${input.baseCurrency}.

Output the JSON report now.`;
}

/**
 * Parse Claude's response, tolerating common formatting quirks (markdown
 * code fences, leading whitespace). Throws with a useful error if the
 * shape doesn't match.
 */
function parseValidationJson(text: string): ValidationReport {
  let cleaned = text.trim();
  // Strip ```json ... ``` fences if Claude added them despite the instruction.
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.issues || !Array.isArray(parsed.issues)) {
      throw new Error("Response missing 'issues' array.");
    }
    return {
      summary: parsed.summary ?? "",
      totalIssues: parsed.totalIssues ?? parsed.issues.length,
      issues: parsed.issues.map((i: Partial<ValidationIssue>) => ({
        identifier: i.identifier ?? "",
        description: i.description ?? "",
        severity: i.severity ?? "info",
        action: i.action ?? "INFO_ONLY",
        params: (i.params as Record<string, string | number | null>) ?? {},
        reasoning: i.reasoning ?? "",
      })),
    };
  } catch (err) {
    throw new Error(
      `Failed to parse Anthropic response as JSON: ${(err as Error).message}\n\n` +
        `Raw response (first 500 chars):\n${cleaned.slice(0, 500)}`,
    );
  }
}
