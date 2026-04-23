---
date: 2026-03-30
topic: wealthfolio-importer
---

# Wealthfolio Importer

## Problem Frame

Wealthfolio supports CSV import for portfolio transactions, but users must manually create those CSVs from brokerage statements (PDFs), screenshots, or other documents. This is tedious, error-prone, and a significant friction point — especially for users onboarding with historical data from multiple brokers.

This tool bridges the gap: upload a document, let AI extract the transactions, review them, and download a Wealthfolio-ready CSV.

## Requirements

- R1. User can upload a single PDF or image file (PNG, JPG, JPEG) via a drag-and-drop zone or file picker
- R2. The app sends the document to an AI vision model that extracts transaction data into structured fields: date, symbol, quantity, activityType, unitPrice, currency, fee, amount
- R3. Extracted transactions are displayed in an editable table so the user can review and correct values before export
- R4. User can download the reviewed data as a CSV file matching Wealthfolio's import format (columns: date, symbol, quantity, activityType, unitPrice, currency, fee, amount)
- R5. The app supports both OpenAI (GPT-4o) and Anthropic (Claude) as AI providers — user selects their provider and enters their own API key
- R6. API keys are stored in browser localStorage for convenience across sessions but never sent anywhere except the selected AI provider
- R7. The app runs entirely client-side as a static site — no backend server required
- R8. Supported activity types match Wealthfolio: BUY, SELL, DIVIDEND, DEPOSIT, WITHDRAWAL, TAX, FEE, INTEREST, TRANSFER_IN, TRANSFER_OUT

## Success Criteria

- A user can go from a brokerage PDF statement to a valid Wealthfolio CSV in under 2 minutes
- Extracted data is accurate enough that most transactions need zero manual corrections
- The app works without any server infrastructure — deployable to GitHub Pages, Netlify, or Vercel as a static site

## Scope Boundaries

- **Single file at a time** — no multi-file upload or batch processing in v1
- **No Wealthfolio integration** — the output is a downloadable CSV, not a direct API import
- **No account management** — the CSV doesn't include account information; users assign the account during Wealthfolio's import flow
- **No persistent storage** — no database, no user accounts, no server. Everything is ephemeral except the API key in localStorage
- **No brokerage-specific parsers** — the AI handles all document formats generically rather than having per-broker parsing logic

## Key Decisions

- **Client-side only**: Eliminates hosting costs, simplifies deployment, and keeps user documents private (never touch a server we control). Users provide their own API key.
- **Multi-provider support (OpenAI + Anthropic)**: Maximum flexibility. Both have strong vision models. User picks whichever they have access to.
- **Editable review table**: Strikes the right balance between "just trust the AI" and "manual spreadsheet editing." Users can fix mistakes before export.
- **Generic AI extraction over brokerage-specific parsers**: Simpler to build and maintain. The AI handles format variation; we don't need to reverse-engineer each broker's PDF layout.

## Dependencies / Assumptions

- Users have an API key for at least one supported provider (OpenAI or Anthropic)
- Both providers' APIs support CORS or the app uses a workaround (Anthropic's API does not support browser CORS by default — this needs resolution during planning)

## Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R2][Needs research] Anthropic's API does not support CORS from browsers. Investigate workarounds: a lightweight CORS proxy, a service worker approach, or limiting Anthropic support to users who self-host.
- [Affects R3][Technical] Determine the best approach for the editable table component — a lightweight library vs. a simple custom table with inline editing.
- [Affects R5][Technical] Choose a frontend framework (React, Vue, Svelte, plain HTML/JS) based on simplicity and bundle size goals.

## Next Steps

-> `/ce:plan` for structured implementation planning
