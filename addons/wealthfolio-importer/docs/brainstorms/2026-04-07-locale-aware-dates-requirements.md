---
date: 2026-04-07
topic: locale-aware-dates
---

# Locale-Aware Date Parsing

## Problem Frame

The extraction prompt tells the LLM to output ISO 8601 dates but gives no guidance on how to interpret ambiguous input dates. A brokerage statement showing "03/04/2025" could mean March 4 or April 3 depending on the user's country. The LLM defaults to US-style MM/DD, silently producing wrong dates for non-US users. Date corruption is invisible at import time and compounds downstream (wrong holding periods, wrong dividend dates, wrong performance calculations).

## Requirements

- R1. **Date format setting**: Add a date format dropdown to the Settings panel with three options: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD. Default to DD/MM/YYYY for new users.
- R2. **Prompt injection**: Inject the user's selected date format into the system prompt as an input interpretation hint (e.g., "Dates in the source document use DD/MM/YYYY ordering"). The LLM output format remains ISO 8601 unchanged.
- R3. **Setting persistence**: The date format setting is persisted alongside the existing API key and provider settings.

## Success Criteria

- Ambiguous dates like "03/04/2025" are interpreted according to the user's selected format, not the LLM's default assumption
- Existing ISO 8601 output contract and validateTransaction regex are unchanged
- The setting is visible and discoverable in the Settings panel

## Scope Boundaries

- No auto-detection from browser locale — explicit user setting only
- No separator-variant options (DD.MM.YYYY, DD-MM-YYYY) — the three ordering options cover the ambiguity; separators don't affect field order
- No per-document override — one global setting applies to all extractions
- No output format change — LLM continues to output ISO 8601

## Key Decisions

- **Explicit setting over auto-detect**: Browser locale doesn't reliably match document locale (expat with US laptop, European brokerage). Explicit selection is deterministic and avoids surprises.
- **Three formats only**: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD cover ~99% of brokerage statements. Separator variations (dots, dashes) don't change the field-ordering ambiguity.
- **DD/MM/YYYY as default**: Most of the world uses day-first ordering. US users are a minority of international brokerage users likely to use this addon.
- **Input hint, not output hint**: The prompt tells the LLM how to read the source document's dates. Output stays ISO 8601 — changing output format would break validateTransaction's regex and downstream parsing.

## Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R1][Technical] Where exactly in the Settings component should the dropdown be placed relative to existing fields?
- [Affects R2][Technical] Should the hint be injected into SYSTEM_PROMPT or USER_PROMPT? System prompt is static today; making it dynamic requires a small refactor.
- [Affects R3][Technical] How are settings currently persisted — localStorage, Wealthfolio SDK, or in-memory? The date format setting should use the same mechanism.

## Next Steps

→ `/ce:plan` for structured implementation planning
