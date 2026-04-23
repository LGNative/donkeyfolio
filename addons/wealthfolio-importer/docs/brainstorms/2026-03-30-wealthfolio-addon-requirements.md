---
date: 2026-03-30
topic: wealthfolio-addon
---

# Wealthfolio AI Importer Addon

## Problem Frame

The current web app extracts transactions from PDFs/images but outputs a CSV that the user must manually import into Wealthfolio. This adds friction — the user must download the file, open Wealthfolio, navigate to import, select the file, map columns, and confirm. A Wealthfolio addon eliminates this by importing directly.

## Requirements

- R1. Build as a Wealthfolio addon (React + TypeScript) that runs inside the desktop app
- R2. User can select their AI provider (OpenAI or Anthropic) and enter their API key within the addon
- R3. User can upload a single PDF or image file via the addon UI
- R4. The addon sends the document to the AI vision model and extracts transactions (same logic as the web app)
- R5. Extracted transactions are shown in an editable review table before import
- R6. User selects a Wealthfolio account from a dropdown (populated via `ctx.api.accounts.getAll()`)
- R7. User confirms import and transactions are saved via `ctx.api.activities.import()` with duplicate detection via `ctx.api.activities.checkImport()`
- R8. The addon registers a sidebar item and route in Wealthfolio's navigation

## Success Criteria

- A user can go from a brokerage PDF to imported transactions in Wealthfolio in under 2 minutes — no CSV step
- Duplicate detection prevents re-importing the same transactions
- The addon installs cleanly via Wealthfolio's addon system

## Scope Boundaries

- **No CSV export** — direct import only
- **No standalone web app changes** — this is a new separate project (the addon)
- **Single file at a time** — same as the web app
- **No brokerage-specific parsers** — generic AI extraction

## Key Decisions

- **Wealthfolio addon rather than standalone app**: Eliminates the CSV download/upload friction entirely. The addon has direct access to accounts and the import API.
- **React + TypeScript**: Required by Wealthfolio's addon framework. This replaces Svelte from the web app.
- **Reuse AI extraction logic**: The prompt, schema, and provider adapters from the web app can be ported directly — they're plain JS with no framework dependency.

## Dependencies / Assumptions

- User has Wealthfolio desktop app installed
- Wealthfolio addon system is stable and available in the user's version
- The addon API (`ctx.api.activities.import()`, `ctx.api.activities.checkImport()`, `ctx.api.accounts.getAll()`) works as documented

## Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R4][Needs research] Verify that the addon environment allows direct `fetch()` to external APIs (OpenAI/Anthropic) — Tauri's webview may have different CORS/security constraints than a regular browser
- [Affects R1][Needs research] Determine the exact addon manifest permissions needed for activities write access and account read access
- [Affects R7][Technical] Determine the exact shape of `ActivityImport` type expected by the import API
- [Affects R4][Technical] Decide whether to vendor pdf.js inside the addon or use a different approach for PDF→image conversion in Tauri's webview

## Next Steps

-> `/ce:plan` for structured implementation planning
