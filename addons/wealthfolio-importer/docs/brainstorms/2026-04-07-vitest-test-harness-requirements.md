---
date: 2026-04-07
topic: vitest-test-harness
---

# Vitest Test Harness for Pure Functions

## Problem Frame

Zero tests exist for functions that parse money, dates, and LLM responses. These are the highest-risk code paths in a financial data importer, and upcoming features (amount cross-validation, locale-aware dates, smart extraction pipeline) will all modify them. Without tests, every refactor is a gamble.

## Requirements

- R1. **Vitest setup**: Install Vitest as a dev dependency with zero-config Vite integration. Add a `test` script to package.json.
- R2. **Validation function tests**: Test `validateTransaction`, `evaluateConfidence`, and `parseResponse` as the first priority. These gate what gets imported and are most likely to change.
- R3. **Synthetic fixtures**: Use handcrafted test data that exercises edge cases — zero values, negative amounts, ambiguous dates, malformed JSON, missing fields, boundary values. No real brokerage data.

## Success Criteria

- `npm test` runs and passes in the addon directory
- validateTransaction, evaluateConfidence, and parseResponse each have tests covering happy path and key edge cases
- Tests run in CI (existing GitHub Actions workflow)

## Scope Boundaries

- Validation-first — extraction functions (chunkPages, isGarbled, reconstructLayout) are deferred to a follow-up
- No DOM or component tests — pure function tests only
- No real/anonymized brokerage data — synthetic fixtures only
- No coverage thresholds — add tests for meaningful cases, not coverage theater

## Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R1][Technical] Does the existing Vite config need changes to support Vitest, or is the zero-config default sufficient?
- [Affects R2][Technical] Are all target functions currently exported, or do some need to be exported for testability?

## Next Steps

→ `/ce:plan` for structured implementation planning
