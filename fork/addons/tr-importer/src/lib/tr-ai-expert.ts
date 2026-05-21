/**
 * Wealthfolio Expert — AI assistant specialized in Donkeyfolio internals,
 * the TR Importer addon, and PT IRS for portfolio investors.
 *
 * Architecture:
 *   - Bring-your-own-key (BYOK) Anthropic API key, stored encrypted via
 *     the addon SDK's `secrets` API (system keyring on macOS).
 *   - Calls api.anthropic.com directly via fetch() (no Anthropic SDK
 *     dependency — keeps bundle small).
 *   - Caches responses in localStorage by SHA-256 hash of (system, user)
 *     for 7 days. Repeated identical questions cost zero.
 *   - System prompt baked with knowledge collected during the v4.x
 *     development cycle (architecture, bugs, fixes, conventions).
 *
 * Cost: ~€0.05–0.15 per question with Claude Sonnet 4.5 (input ~5K
 * tokens of system prompt + question, output ~500–2000 tokens).
 */

const SECRET_KEY = "tr-importer:anthropic-api-key";
const CACHE_PREFIX = "tr-importer:v1:expert:";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";

export interface ExpertContext {
  /** Optional structured context to inject (current diagnostic, recent
   *  errors, CSV summary). Stringified into the user message. */
  diagnostics?: unknown;
  recentErrors?: string[];
  csvSummary?: unknown;
}

export interface ExpertResponse {
  answer: string;
  /** True when served from local cache (no API call made). */
  cached: boolean;
  /** Approximate cost in EUR for the API call. ~0 when cached. */
  costEur?: number;
  /** Token usage from API. */
  inputTokens?: number;
  outputTokens?: number;
}

export class ExpertError extends Error {
  constructor(
    message: string,
    readonly kind: "no_key" | "api_error" | "network" | "parse",
  ) {
    super(message);
    this.name = "ExpertError";
  }
}

const SYSTEM_PROMPT = `És um assistente especializado em **Donkeyfolio** (fork de Wealthfolio) — uma app desktop de tracking de portfolio em Tauri/Rust + React. O utilizador é português, investidor, e usa o addon **TR Importer** que importa CSVs da Trade Republic para o Donkeyfolio.

Responde sempre em **português europeu**, conciso e técnico. Cita ficheiros e linhas quando aplicável (formato \`crates/core/src/file.rs:123\`). Se a pergunta for ambígua, faz 1 pergunta de clarificação. Se não souberes, diz "não tenho a certeza" — não inventes.

## Arquitetura Donkeyfolio

- **Backend Rust** em \`crates/\`: core (lógica de negócio), storage-sqlite (DB), market-data (providers), sync, etc.
- **Frontend React/Vite** em \`apps/frontend/\`.
- **Tauri shell** em \`apps/tauri/\` com comandos IPC mapeando para o core.
- **Servidor HTTP** opcional em \`apps/server/\` (Axum) para uso web.
- **Addons** em \`addons/\` carregados como bundles JS no renderer; comunicam via SDK \`@wealthfolio/addon-sdk\`.
- **DB SQLite** com migrations em \`crates/storage-sqlite/migrations/\`.

## Comportamentos críticos do backend que afetam addons

1. **\`bulk_mutate_activities\` (saveMany) é TRANSACIONAL**. Em \`crates/storage-sqlite/src/activities/repository.rs:621-742\`, todos os \`INSERT\` correm dentro de \`exec_tx\`. Se 1 falha, o \`?\` propaga e dá rollback do CHUNK INTEIRO. Mitigação: bisect-on-failure (split chunk em 2 quando falha; recursivo até size=1).

2. **\`idempotency_key\` explícito é honrado** se não vazio (\`activities_service.rs:4441-4470\`). O constraint UNIQUE em SQLite é a fonte de verdade — sem race condition. Se em branco, fallback para SHA-256 de (account, type, date, asset, qty, unit_price, amount, currency, source_record_id, notes).

3. **Asset profile dedup por ISIN** — \`quoteCcy\` set na criação NÃO é atualizado em re-imports. Para mudar quoteCcy de assets existentes, usar \`update_asset_profile\` Tauri command (o backend Rust aceita \`quote_ccy\` em \`UpdateAssetProfile\` apesar de a SDK TS não o expor — usar cast \`as unknown\`).

4. **Activity types fechados** (14): BUY, SELL, SPLIT, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT, FEE, TAX, CREDIT, ADJUSTMENT, UNKNOWN. Subtypes conhecidos em \`packages/addon-sdk/src/data-types.ts\` (DRIP, QUALIFIED, STAKING_REWARD, REBATE, BONUS, WITHHOLDING, etc.).

5. **\`metadata\` no ActivityCreate é \`Option<String>\` no Rust**, JSON-stringified. Passar como objeto provoca \`invalid type: map, expected a string\`. SDK TS aceita \`string | Record<string, unknown>\` mas só strings funcionam.

6. **Market data routing** por \`instrumentType\` + provider priority. Custom providers (CoinGecko, Stooq, Frankfurter, ExchangeRate) configuráveis em Settings → Market Data → Custom. ExchangeRate só para FIAT — falha em crypto/stocks com \`Could not extract price from path '$.rates.EUR' for symbol 'X'\`.

## Conhecimento sobre o TR Importer addon (v4.x)

- **Mapper** (\`tr-csv-mapper.ts\`): regra \`cash = amount + fee + tax\` valida ao cêntimo contra PDF Account Statement TR.
- **Idempotency keys**: \`tr-importer:v4:<TR_transaction_id>\` (UUID TR globalmente único, 4222/4222 únicos no test set).
- **Geography**: extraído do prefix do ISIN (ISO 3166-1). UCITS umbrellas (IE/LU) e offshore (KY/BMU/JE) flagged.
- **Buckets**: STOCK / ETF / CRYPTO / DERIVATIVE — derivado do \`asset_class\` do CSV, pinned no \`instrumentType\`.
- **Card consolidation**: 113 CARD_TRANSACTION → ~24 WITHDRAWAL mensais.
- **Cancelled-pair resolution**: STOCK_DIVIDEND/SPIN_OFF + cancellation = 1 occurrence net.
- **Crypto**: BTC/ETH/SOL/ADA/XRP normalizados para BTC-EUR/ETH-EUR/etc.
- **DCA detection**: prefix "Savings plan execution" no CSV description.
- **Bisect-on-failure**: CHUNK_SIZE=50, splits ao meio quando backend aborta.

## Bugs históricos (já corrigidos)

- v4.0 → v4.1.1: silent failures de chunk não detetados (faltava captura de \`result.errors\`).
- v4.1.0: metadata como objeto rejeitada pelo Rust (fix: JSON.stringify).
- v4.1.0: SPLIT activity sem campo \`currency\` obrigatório (fix: adicionar \`currency: "EUR"\`).
- v4.0.x: idempotency conflicts em DCA same-day (fix: explicit \`idempotencyKey\` por TR uuid).
- Manifest \`functions\` como string em vez de \`FunctionPermission\` struct: addon não carrega.

## Pitfalls / "what can fail"

- **Re-import com state misto**: 400 silent fails se chunks falham em runs anteriores.
- **PNG mostra CAD em vez de EUR**: asset profile criado com Yahoo native currency; usar update_asset_profile com quote_ccy.
- **Yahoo Finance rate limit (HTTP 429)**: providers fall through para custom providers (Stooq).
- **Volatility absurda (>100%)**: preços maus por sync incompleto.
- **"Duplicate activity detected"**: idempotency key colidiu OU SHA-256 fallback colidiu (DCA same date/asset/amount/qty).
- **Holdings €0.00**: market data não syncou para esse asset; clicar "Sync All" em Settings → Market Data.

## IRS Portugal (para perguntas fiscais)

- **Anexo G**: mais-valias mobiliárias (BUY-SELL FIFO, em EUR após FX).
- **Anexo J**: rendimentos obtidos no estrangeiro (dividendos, juros). Reportar gross + retenção na fonte (WHT).
- **Crypto**: regime fiscal específico desde 2023; <1 ano = mais-valia, >=1 ano = isento.
- **TR retém** WHT US (15% via tratado), DE (26.375%), FR (12.8%), etc. Reportar bruto e creditar a retenção.

## Roadmap upstream Wealthfolio (até v3.3.0)

- v3.3.0: \`AssetResolutionInput\` substitui \`SymbolInput\`, ActivityCreate aceita \`.asset\` (com alias \`.symbol\`); ISIN editing no asset profile; account snapshot history tab; mobile sync improvements.
- Próximas: device sync improvements, asset auto-discovery via OpenFIGI.

---

**Ao responder**, se o utilizador anexar contexto (diagnóstico JSON, erros recentes), USA-O. Aponta números concretos. Se não bate certo, identifica a causa raiz mais provável + 1 fix de 1 linha quando aplicável.`;

/* ─────────────────────────  Public API  ───────────────────────── */

interface SecretsApi {
  set: (key: string, value: string) => Promise<void>;
  get: (key: string) => Promise<string | null>;
  delete: (key: string) => Promise<void>;
}

export async function setApiKey(secrets: SecretsApi, key: string): Promise<void> {
  await secrets.set(SECRET_KEY, key);
}

export async function getApiKey(secrets: SecretsApi): Promise<string | null> {
  try {
    return await secrets.get(SECRET_KEY);
  } catch {
    return null;
  }
}

export async function clearApiKey(secrets: SecretsApi): Promise<void> {
  try {
    await secrets.delete(SECRET_KEY);
  } catch {
    // ignore
  }
}

export async function ask(
  secrets: SecretsApi,
  question: string,
  context?: ExpertContext,
): Promise<ExpertResponse> {
  const apiKey = await getApiKey(secrets);
  if (!apiKey) throw new ExpertError("API key not set", "no_key");

  const userMessage = buildUserMessage(question, context);
  const cacheKey = await cacheKeyFor(SYSTEM_PROMPT, userMessage);
  const cached = readCache(cacheKey);
  if (cached) return { ...cached, cached: true };

  let resp: Response;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
  } catch (err) {
    throw new ExpertError(`Network error: ${(err as Error).message}`, "network");
  }

  if (!resp.ok) {
    let body = "";
    try {
      body = await resp.text();
    } catch {
      /* ignore */
    }
    throw new ExpertError(`Anthropic API ${resp.status}: ${body.slice(0, 300)}`, "api_error");
  }

  let parsed: AnthropicResponse;
  try {
    parsed = (await resp.json()) as AnthropicResponse;
  } catch (err) {
    throw new ExpertError(`Failed to parse Anthropic response: ${(err as Error).message}`, "parse");
  }

  const answer = parsed.content?.find((c) => c.type === "text")?.text ?? "";
  const inputTokens = parsed.usage?.input_tokens ?? 0;
  const outputTokens = parsed.usage?.output_tokens ?? 0;
  // Sonnet 4.5: $3/Mtok input, $15/Mtok output. EUR ≈ USD here.
  const costEur = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;

  const result: ExpertResponse = {
    answer,
    cached: false,
    costEur,
    inputTokens,
    outputTokens,
  };
  writeCache(cacheKey, result);
  return result;
}

/* ─────────────────────────  Helpers  ───────────────────────── */

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function buildUserMessage(question: string, context?: ExpertContext): string {
  const parts: string[] = [];
  if (context?.diagnostics) {
    parts.push(
      "## Diagnóstico actual (TR Importer addon)\n```json\n" +
        JSON.stringify(context.diagnostics, null, 2).slice(0, 12_000) +
        "\n```",
    );
  }
  if (context?.csvSummary) {
    parts.push(
      "## CSV summary\n```json\n" +
        JSON.stringify(context.csvSummary, null, 2).slice(0, 4_000) +
        "\n```",
    );
  }
  if (context?.recentErrors && context.recentErrors.length > 0) {
    parts.push(
      "## Erros recentes do log\n" +
        context.recentErrors
          .slice(0, 10)
          .map((e) => `- ${e}`)
          .join("\n"),
    );
  }
  parts.push("## Pergunta\n" + question);
  return parts.join("\n\n");
}

async function cacheKeyFor(system: string, user: string): Promise<string> {
  const data = new TextEncoder().encode(system + "\n---\n" + user);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return CACHE_PREFIX + hex;
}

interface CacheEntry {
  expiresAt: number;
  response: ExpertResponse;
}

function readCache(key: string): ExpertResponse | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() > entry.expiresAt) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.response;
  } catch {
    return null;
  }
}

function writeCache(key: string, response: ExpertResponse): void {
  if (typeof localStorage === "undefined") return;
  try {
    const entry: CacheEntry = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      response,
    };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Quota exceeded or unavailable — fail silently
  }
}
