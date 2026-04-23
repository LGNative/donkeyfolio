---
title: "feat: Wealthfolio AI Importer"
type: feat
status: active
date: 2026-03-30
origin: docs/brainstorms/2026-03-30-wealthfolio-importer-requirements.md
---

# feat: Wealthfolio AI Importer

## Overview

A client-side web app that extracts financial transactions from PDFs and images using AI vision models (OpenAI GPT-4o or Anthropic Claude) and exports a CSV ready for Wealthfolio import. No backend, no accounts — just upload, review, download.

## Problem Statement / Motivation

Wealthfolio supports CSV import but users must manually create those CSVs from brokerage statements. This is tedious and error-prone, especially when onboarding historical data from multiple brokers. (see origin: docs/brainstorms/2026-03-30-wealthfolio-importer-requirements.md)

## Proposed Solution

A Svelte 5 static SPA with three screens: (1) settings — select AI provider and enter API key, (2) upload — drag-and-drop a PDF or image, (3) review — editable table of extracted transactions with CSV download.

### Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser (Static SPA — Svelte 5 + Vite)         │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Settings  │→ │ Upload   │→ │ Review Table  │  │
│  │ Provider  │  │ PDF/Image│  │ Edit → Export │  │
│  │ API Key   │  │ pdf.js   │  │ CSV Download  │  │
│  └──────────┘  └────┬─────┘  └───────────────┘  │
│                      │                            │
│              ┌───────▼────────┐                   │
│              │ AI Provider    │                   │
│              │ Adapter Layer  │                   │
│              └───────┬────────┘                   │
└──────────────────────┼────────────────────────────┘
                       │ fetch()
          ┌────────────┴────────────┐
          │                         │
  ┌───────▼───────┐     ┌──────────▼──────────┐
  │ OpenAI API    │     │ Anthropic API       │
  │ /v1/chat/     │     │ /v1/messages        │
  │ completions   │     │ (CORS header)       │
  └───────────────┘     └─────────────────────┘
```

### Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | Svelte 5 | ~1.6KB runtime, compiles to vanilla JS, `bind:value` makes editable table trivial |
| Build | Vite | Fast dev server, static build output |
| PDF rendering | pdfjs-dist | Mozilla's standard, renders PDF pages to canvas → base64 |
| AI providers | OpenAI + Anthropic | Direct fetch() from browser, no SDK needed |
| Editable table | Hand-rolled Svelte | `bind:value` on `<input>` elements, ~30 lines |
| CSV generation | Native JS | Blob + createObjectURL, ~20 lines |
| Styling | Plain CSS (or Pico CSS) | Minimal, classless CSS framework for clean defaults |

### AI Provider Integration

**Anthropic (Claude):** Fully supported from browser. Requires header `anthropic-dangerous-direct-browser-access: true`. Use `output_config.format` with `json_schema` for structured extraction.

**OpenAI (GPT-4o):** Use direct `fetch()` to `/v1/chat/completions` (avoid SDK to prevent CORS issues from extra headers). Use `response_format` with `json_schema` for structured output. If CORS fails for some users, show a clear error suggesting they try the Anthropic provider instead.

### Extraction Prompt Design

Both providers receive the same logical prompt, adapted to their API format:

**System prompt:**
```
You are a financial document parser. Extract all investment transactions
from the provided document image(s). Return ONLY a JSON array of transactions.

Each transaction must have these fields:
- date: ISO 8601 format (YYYY-MM-DDTHH:mm:ss.000Z). Use midnight if time is unknown.
- symbol: Ticker symbol (e.g., MSFT, AAPL). Use $CASH-{CURRENCY} for cash transactions.
- quantity: Number of shares/units. Use 1 for cash activities.
- activityType: One of: BUY, SELL, DIVIDEND, DEPOSIT, WITHDRAWAL, TAX, FEE, INTEREST, TRANSFER_IN, TRANSFER_OUT
- unitPrice: Price per share/unit. Use 1 for cash activities.
- currency: ISO 4217 code (USD, EUR, GBP, etc.)
- fee: Transaction fee. Use 0 if none or unknown.
- amount: Total amount. For BUY/SELL: quantity × unitPrice. For cash activities: the cash amount.

Rules:
- Only extract actual transactions, NOT summaries, balances, or totals.
- If a transaction type does not match any activityType exactly, choose the closest match.
- If you cannot determine a field, use a reasonable default and note it.
- Return an empty array [] if no transactions are found.
```

**JSON Schema** (shared between providers):
```json
{
  "type": "object",
  "properties": {
    "transactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "date": { "type": "string" },
          "symbol": { "type": "string" },
          "quantity": { "type": "number" },
          "activityType": {
            "type": "string",
            "enum": ["BUY", "SELL", "DIVIDEND", "DEPOSIT", "WITHDRAWAL", "TAX", "FEE", "INTEREST", "TRANSFER_IN", "TRANSFER_OUT"]
          },
          "unitPrice": { "type": "number" },
          "currency": { "type": "string" },
          "fee": { "type": "number" },
          "amount": { "type": "number" }
        },
        "required": ["date", "symbol", "quantity", "activityType", "unitPrice", "currency", "fee", "amount"],
        "additionalProperties": false
      }
    }
  },
  "required": ["transactions"],
  "additionalProperties": false
}
```

### CSV Output Format

Matches Wealthfolio's expected format (see origin document R4):

```csv
date,symbol,quantity,activityType,unitPrice,currency,fee,amount
2024-01-15T00:00:00.000Z,MSFT,10,BUY,368.60,USD,0,3686.00
2024-01-15T00:00:00.000Z,$CASH-USD,1,DIVIDEND,1,USD,0,57.50
```

- UTF-8 encoding with BOM (for Excel compatibility)
- CRLF line endings (RFC 4180)
- Comma delimiter
- Header row included
- Dates in ISO 8601 format

## Technical Considerations

### PDF Processing
- Render at 2.0x scale for readability, output as JPEG at 0.85 quality to keep payload size reasonable
- Max 20 pages per document — warn the user above 5 pages about API cost
- Max 20MB file size
- Password-protected PDFs: catch the pdf.js error and show "This PDF is password-protected. Please provide an unprotected version."

### CORS
- Anthropic: works natively with `anthropic-dangerous-direct-browser-access: true`
- OpenAI: direct fetch() to chat completions works in practice but isn't officially documented. If it fails, show a helpful error suggesting the Anthropic provider.

### Response Parsing Robustness
- Both providers' structured output features should return valid JSON, but as a fallback:
  - Strip markdown code fences if present
  - Attempt `JSON.parse()` on the raw text
  - If all fails, show the raw AI response with an error message so the user can debug

### File Handling
- PDFs: render each page to canvas via pdf.js → export as base64 JPEG
- Images: read as base64 via FileReader
- Validate file type on upload (check MIME type, not just extension)

## Implementation Phases

### Phase 1: Project Scaffolding

- Initialize git repo
- Scaffold Svelte 5 + Vite project (`npm create svelte@latest`)
- Set up static adapter for SPA mode
- Add pdfjs-dist dependency
- Create basic layout with navigation between settings/upload/review states
- Add minimal CSS (Pico CSS or hand-rolled)

**Files:**
```
├── src/
│   ├── app.html
│   ├── routes/
│   │   └── +page.svelte          # Single page app
│   └── lib/
│       ├── components/
│       │   ├── Settings.svelte    # Provider select + API key input
│       │   ├── Upload.svelte      # Drag-and-drop + file picker
│       │   ├── ReviewTable.svelte # Editable transaction table
│       │   └── CsvExport.svelte   # Download button
│       ├── stores/
│       │   └── app.svelte.js      # App state ($state runes)
│       ├── services/
│       │   ├── ai.js              # Provider adapter (OpenAI + Anthropic)
│       │   ├── pdf.js             # PDF to images conversion
│       │   └── csv.js             # CSV generation + download
│       └── prompt.js              # Extraction prompt + JSON schema
├── static/
│   └── pdf.worker.min.mjs         # pdf.js web worker
├── package.json
├── vite.config.js
└── svelte.config.js
```

### Phase 2: Settings & API Key Management

- Provider selector (dropdown: OpenAI / Anthropic)
- API key input (password field with show/hide toggle)
- Save to localStorage, load on mount
- Optional: validate key with a lightweight API call on save (list models for OpenAI, a minimal message for Anthropic)
- Clear key button

### Phase 3: File Upload & PDF Processing

- Drag-and-drop zone with file picker fallback
- Accept: `.pdf`, `.png`, `.jpg`, `.jpeg`
- File size validation (max 20MB)
- For PDFs: render pages via pdf.js at 2.0x scale → JPEG base64
- For images: read as base64 via FileReader
- Show page count for PDFs, warn above 5 pages
- Handle password-protected PDF error

### Phase 4: AI Extraction

- Build the AI provider adapter with a common interface:
  ```js
  async function extract(provider, apiKey, images) → { transactions: [...] }
  ```
- OpenAI path: direct fetch() with vision + structured output
- Anthropic path: direct fetch() with vision + output_config.format
- Loading state with spinner and "Extracting transactions..." message
- Cancel button (AbortController)
- Error handling: invalid key, rate limit, network error, parse failure
- Fallback JSON parsing (strip code fences, extract JSON from mixed text)

### Phase 5: Review Table & CSV Export

- Editable table with all 8 columns
- activityType column as `<select>` dropdown (constrained to valid types)
- Numeric fields with `type="number"` inputs
- Add row / delete row buttons
- "Download CSV" button → generates and downloads the file
- "Start Over" button to return to upload screen
- Empty state if zero transactions extracted

### Phase 6: Polish & Deploy

- Error messages for all failure modes
- Responsive layout (reasonable on tablet, note on mobile that desktop is recommended)
- Add a brief "How it works" section on the page
- Configure for static deployment (GitHub Pages, Netlify, or Vercel)
- README with setup and deployment instructions

## Acceptance Criteria

### Functional Requirements

- [ ] User can select AI provider (OpenAI or Anthropic) and enter API key
- [ ] API key persists in localStorage across sessions
- [ ] User can upload a single PDF (up to 20 pages, 20MB) or image file
- [ ] PDF pages are rendered to images via pdf.js and sent to the selected AI provider
- [ ] AI extracts transactions and returns structured data matching the Wealthfolio schema
- [ ] Extracted transactions display in an editable table
- [ ] User can edit any cell, add rows, and delete rows
- [ ] activityType is constrained to valid Wealthfolio types via dropdown
- [ ] User can download a CSV file that Wealthfolio accepts for import
- [ ] CSV includes header row with correct column names and ISO 8601 dates

### Error Handling

- [ ] Invalid/missing API key shows clear error before extraction attempt
- [ ] File type/size validation with user-friendly messages
- [ ] Password-protected PDF shows helpful message
- [ ] Network errors and API failures show actionable messages
- [ ] Malformed AI responses are handled gracefully with fallback parsing
- [ ] Rate limit errors include "try again later" guidance

### Non-Functional Requirements

- [ ] Entire app runs client-side — no backend calls except to AI provider APIs
- [ ] Deployable as a static site to GitHub Pages, Netlify, or Vercel
- [ ] Page load under 500KB (excluding pdf.js worker loaded on demand)
- [ ] Extraction completes within 30 seconds for a single-page document

## Scope Boundaries (carried from origin)

- Single file at a time — no batch processing
- No direct Wealthfolio integration — output is a downloadable CSV
- No account management — user assigns account during Wealthfolio import
- No persistent storage beyond API key in localStorage
- No brokerage-specific parsers — generic AI extraction only

## Dependencies & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| OpenAI CORS fails for some users | Can't use OpenAI provider | Show clear error, suggest Anthropic. Both providers documented. |
| AI extraction quality varies by document | Incorrect transactions | Editable table for corrections; prompt engineering with schema constraints |
| Large PDFs exceed API token limits | Extraction fails | 20-page cap, page count warning, JPEG compression |
| API key exposed in browser | Security concern for unaware users | Brief note in settings UI that key stays in browser, never sent to our servers |

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-30-wealthfolio-importer-requirements.md](docs/brainstorms/2026-03-30-wealthfolio-importer-requirements.md) — Key decisions carried forward: client-side only architecture, multi-provider AI support (OpenAI + Anthropic), editable review table, generic AI extraction over brokerage-specific parsers.

### External References

- [Wealthfolio CSV import docs](https://wealthfolio.app/docs/guide/activities/) — CSV column format and activity types
- [Anthropic browser CORS support](https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/) — `anthropic-dangerous-direct-browser-access: true` header
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs) — `response_format` with `json_schema`
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — `output_config.format` with `json_schema`
- [pdf.js](https://mozilla.github.io/pdf.js/) — PDF rendering in the browser
- [Svelte 5 docs](https://svelte.dev/docs) — Runes, reactivity, SvelteKit
