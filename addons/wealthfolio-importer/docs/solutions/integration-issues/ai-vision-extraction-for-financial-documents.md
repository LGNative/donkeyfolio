---
title: "AI Vision Extraction for Financial Documents — Lessons from Building Wealthfolio Importer"
category: integration-issues
date: 2026-03-31
tags: [ai-vision, openai, anthropic, pdf-processing, csv-import, wealthfolio-addon, structured-output]
modules: [ai-service, pdf-service, csv-export, addon]
severity: medium
---

# AI Vision Extraction for Financial Documents

## Problem

Building a tool that uses AI vision models (OpenAI GPT-5.4-mini, Anthropic Claude) to extract structured financial transaction data from PDFs and images. The extracted data must match Wealthfolio's exact import schema. Multiple integration issues surfaced during development.

## Key Findings

### 1. OpenAI API Parameter Changes Break Silently

**Symptom:** `API error (400): Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.`

**Root cause:** GPT-5.4-mini (and newer OpenAI models) require `max_completion_tokens` instead of the older `max_tokens` parameter. The API returns a 400 error rather than silently ignoring the parameter.

**Fix:** Use `max_completion_tokens` for GPT-5.x models.

```js
// ❌ Wrong (older models)
{ model: 'gpt-5.4-mini', max_tokens: 4096 }

// ✅ Correct (GPT-5.x models)
{ model: 'gpt-5.4-mini', max_completion_tokens: 4096 }
```

### 2. Anthropic Structured Output API Format Differs from OpenAI

**Symptom:** Zero transactions extracted despite valid documents.

**Root cause:** Anthropic's `output_config.format` with `json_schema` has a different nesting structure than OpenAI's `response_format`. The initial implementation used the wrong format. Rather than fighting the exact schema format, relying on a strong system prompt to produce JSON proved more reliable.

**Fix:** For Anthropic, skip `output_config` and rely on prompt engineering. For OpenAI, use `response_format` with `json_schema` and `strict: true`.

### 3. AI Responses Need Runtime Validation — Always

**Problem:** LLMs are unreliable with types. A vision model might return `quantity: "three"` instead of `quantity: 3`, or invent activity types not in the schema.

**Fix:** Always validate each field after JSON parsing, even when using structured output:

```js
function validateTransaction(t) {
  return {
    date: typeof t.date === 'string' ? t.date : '',
    quantity: typeof t.quantity === 'number' && isFinite(t.quantity) ? t.quantity : 0,
    activityType: ACTIVITY_TYPES.includes(t.activityType) ? t.activityType : 'BUY',
    // ... validate every field
  };
}
```

### 4. CSV Formula Injection via AI Output

**Problem:** If a crafted document tricks the AI into outputting `=HYPERLINK(...)` in a field, the downloaded CSV becomes an attack vector when opened in Excel.

**Fix:** Prefix any cell starting with `=`, `+`, `-`, `@`, `\t`, or `\r` with a single quote:

```js
if (/^[=+\-@\t\r]/.test(str)) {
  str = "'" + str;
}
```

### 5. Anthropic CORS Works from Browser with Special Header

**Finding:** Anthropic's API supports direct browser calls with the `anthropic-dangerous-direct-browser-access: true` header. This was introduced in August 2024 and is the intended pattern for "bring your own API key" apps.

```js
headers: {
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
}
```

OpenAI's CORS support is undocumented but works in practice with direct `fetch()` (avoid the SDK, which adds headers that trigger CORS preflight failures).

### 6. Lazy-Load pdf.js to Keep Initial Bundle Small

**Finding:** pdfjs-dist is ~400KB. Using `await import()` instead of a static import reduced the page chunk from 418KB to 14KB. The PDF library only loads when a user actually uploads a PDF.

### 7. Keep Shared Logic in Sync Across Targets

**Problem:** Building both a Svelte web app and a React Wealthfolio addon led to duplicated AI/PDF/prompt logic. The activity types list diverged (10 types in web app vs 13 in addon) within hours of creation, causing the two targets to produce different extraction results from the same document.

**Prevention:** When duplicating business logic across targets, sync immediately or extract to a shared package. Activity type lists, prompts, and schemas are especially dangerous to duplicate.

## Prevention Strategies

1. **Pin API parameter names per model family** — Check the provider's API docs for each model before switching. Parameter names change between model generations.
2. **Always validate AI output at the boundary** — Treat LLM responses like untrusted user input. Validate types, ranges, and enum values.
3. **Sanitize CSV output for formula injection** — Any app that generates CSVs from external data should prefix dangerous characters (OWASP CSV Injection).
4. **Lazy-load heavy dependencies** — Use dynamic `import()` for libraries only needed conditionally (pdf.js, chart libraries, etc.).
5. **Don't duplicate business logic across frameworks** — Extract shared services into a framework-agnostic package when building for multiple targets.

## Related

- [Wealthfolio CSV import docs](https://wealthfolio.app/docs/guide/activities/)
- [Wealthfolio addon API](https://wealthfolio.app/docs/addons/api-reference/)
- [Anthropic browser CORS](https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/)
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
