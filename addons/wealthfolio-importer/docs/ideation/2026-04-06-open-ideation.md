---
date: 2026-04-06
topic: open-ideation
focus: open-ended
---

# Ideation: Wealthfolio AI Importer Improvements

## Codebase Context

- **Project shape:** React 19 + Vite 6 addon, ships as a zip bundle installed via Wealthfolio's addon manager. TypeScript, minimal deps (only pdfjs-dist runtime).
- **Core files:** `addon/src/services/ai.ts` (~320 lines, both providers), `pdf.ts` (PDF handling), `prompt.ts` (prompt construction), `components/` (Upload, ReviewTable, Settings, ImporterPage, ErrorBoundary).
- **Notable patterns:** Lazy-loaded pdf.js, Wealthfolio SDK v3.0.0 permissions model, React/ReactDOM externalized as peer deps.
- **Gaps:** Zero tests, no linter/formatter, single ai.ts handles both providers, no error recovery/retry logic.
- **Past learnings:** OpenAI parameter drift across models, Anthropic structured output fragility (prompt-driven JSON), runtime validation catches LLM type errors, CSV formula injection handled, CORS quirks per provider, logic duplication risk across targets.

## Ranked Ideas

### 1. Vitest Test Harness for Pure Functions
**Description:** Install Vitest, write tests for validateTransaction, evaluateConfidence, parseResponse, chunkPages, isGarbled, and reconstructLayout. All pure data-in/data-out with no DOM or network dependencies.
**Rationale:** Zero tests on functions that parse money and dates is a ticking time bomb. These are the highest-risk code paths. Vitest is zero-config with Vite. Every future refactor becomes safe.
**Downsides:** Ongoing maintenance cost for tests. Need anonymized fixture data.
**Confidence:** 95%
**Complexity:** Low
**Status:** Unexplored

### 2. Retry with Exponential Backoff
**Description:** Wrap API calls in a retry helper (2-3 attempts, exponential backoff) for transient errors (429, 500, 502, 503). Track which chunks succeeded so retries only re-process failed chunks. ~15 lines of real logic.
**Rationale:** 429 rate limits are the #1 real-world failure mode. Currently a single transient error kills the entire multi-chunk extraction, wasting all prior API spend. Users must manually re-upload.
**Downsides:** Retries with backoff add latency on failure paths. Need to cap retries to avoid infinite loops.
**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

### 3. Amount/Quantity Cross-Validation
**Description:** After extraction, verify that amount = quantity x unitPrice (within tolerance). Flag mismatches in ReviewTable. The current evaluateConfidence checks for zero values but never cross-validates the arithmetic.
**Rationale:** LLMs frequently hallucinate one of the three correlated fields. Importing transactions where amount != qty x price silently corrupts portfolio calculations. Dead simple arithmetic check.
**Downsides:** Tolerance thresholds may need tuning for fees/commissions. Some transaction types (dividends) don't have qty x price.
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

### 4. Locale-Aware Date Parsing
**Description:** Add a locale/region setting (or auto-detect from browser) and inject it as a hint in the extraction prompt so the LLM can disambiguate dates like "03/04/2025" (March 4th vs April 3rd).
**Rationale:** DD/MM vs MM/DD ambiguity is invisible data corruption that affects every non-US user. The prompt currently says "ISO 8601 output" but gives zero input locale guidance. One line in the prompt, one setting in the UI.
**Downsides:** Browser locale detection isn't always reliable. Some documents mix formats.
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

### 5. Auto-Detect Provider from API Key Prefix
**Description:** Anthropic keys start with `sk-ant-`, OpenAI keys start with `sk-`. Detect provider automatically, remove the provider dropdown, show detected provider as a read-only label.
**Rationale:** Eliminates a configuration step and an entire class of user error (pasting wrong key for selected provider gives confusing 401). Five lines of string matching.
**Downsides:** Key prefix conventions could change. Doesn't cover custom endpoints or proxies.
**Confidence:** 80%
**Complexity:** Low
**Status:** Unexplored

### 6. Biome Linter/Formatter
**Description:** Add Biome as a dev dependency with a single biome.json config. Replaces both ESLint and Prettier with one Rust-based tool that runs in ~50ms. Add format/lint scripts.
**Rationale:** No linting config exists despite scattered eslint-disable comments. Catches real bugs (unused variables, unreachable code) and enforces consistency. 5 minutes to set up, compounds on every future change.
**Downsides:** Another dev dependency. Team must agree on style rules.
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

### 7. OpenAI-Compatible Generic Endpoint
**Description:** Replace the dual Anthropic/OpenAI code paths with a single OpenAI-compatible API format and a configurable base URL. Covers OpenAI, Azure OpenAI, and local models (Ollama, LMStudio, vLLM).
**Rationale:** Drops half the provider code (buildAnthropicContent, extractWithAnthropic, CORS hacks). Strictly simpler, not more complex. Opens up local/self-hosted models for free.
**Downsides:** Users on Anthropic direct would need a proxy. Loses Anthropic-specific optimizations. Migration effort for existing users.
**Confidence:** 75%
**Complexity:** Medium
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Provider adapter pattern | 320 lines with 2 providers doesn't justify an interface; premature abstraction |
| 2 | Streaming extraction | Vision endpoints return complete JSON, not streamable rows; massive complexity for faked progressiveness |
| 3 | Parallel chunk extraction | Marginal speedup for typical 2-5 page docs, complicates rate-limit handling |
| 4 | Zod schema + auto-repair | Re-prompting doubles API cost; simple JSON.parse + one retry gets 95% of the value |
| 5 | Local extraction cache | Easy to build but cache invalidation when prompts change is not; premature |
| 6 | Confidence scores per field | LLMs hallucinate confidence scores; highlighting noise confuses users |
| 7 | Brokerage template learning | Mini ML pipeline smuggled into a 320-line addon; wildly disproportionate |
| 8 | Skip review for high-confidence | Without reliable confidence, this silently imports garbage financial data |
| 9 | Structured error taxonomy | Enterprise ceremony for two API calls; string messages suffice at this scale |
| 10 | Pre-classify pages | Heuristic filtering will silently drop valid pages on unfamiliar brokerages |
| 11 | Drag-and-drop region selection | Building a PDF annotation tool inside a transaction importer; months of work |
| 12 | Offline Tesseract.js fallback | 2MB+, slow, terrible at table extraction; a second pipeline to maintain |
| 13 | Review table as core product | Manual entry is a different product; Wealthfolio already has an activity form |
| 14 | Eliminate AI for structured PDFs | Writing deterministic parsers per brokerage layout is the exact problem the addon solves with AI |
| 15 | Multi-file batch upload | Per-file account assignment UI doubles flow complexity; defer until demanded |
| 16 | Duplicate transaction detection | Requires reading existing Wealthfolio activities; may need unavailable host API |
| 17 | Token/cost estimation | Token counts vary wildly with content; an estimate off by 3x is worse than none |
| 18 | Truncation recovery | Partial JSON recovery is fragile; better solved by requesting smaller chunks |

## Session Log
- 2026-04-06: Initial ideation -- 48 raw ideas generated across 6 frames, 25 after dedupe, 7 survived adversarial filtering
