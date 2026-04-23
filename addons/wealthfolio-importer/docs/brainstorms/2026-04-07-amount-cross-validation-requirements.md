---
date: 2026-04-07
topic: amount-cross-validation
---

# Amount/Quantity Cross-Validation

## Problem Frame

LLMs frequently hallucinate one of the three correlated financial fields (amount, quantity, unit price) while getting the others right. The current `evaluateConfidence` function checks for zero values but never cross-validates the arithmetic relationship between fields. Importing transactions where amount != qty x price silently corrupts portfolio value calculations, performance tracking, and cost basis.

## Requirements

- R1. **Arithmetic cross-check**: For BUY and SELL transactions, flag when `|amount - quantity × unitPrice|` exceeds 1% of amount. Add this as a new check in `evaluateConfidence`.
- R2. **Warning display**: The flag appears in ReviewTable using the existing amber-border confidence indicator system (same as other field flags). The flag should be applied to the `amount` field with a reason like "Amount doesn't match quantity × price".
- R3. **Skip when data is missing**: Skip the cross-check when quantity, unitPrice, or amount is zero (these are already caught by existing zero-value checks).

## Success Criteria

- Transactions where amount diverges from qty × price by more than 1% are visually flagged before import
- Existing zero-value checks remain unchanged
- No false positives on dividends, fees, interest, transfers, or other non-trade activity types

## Scope Boundaries

- BUY and SELL only — dividends, interest, fees, and transfers don't have a reliable qty × price relationship
- Fees are not factored into the formula — the 1% tolerance absorbs small fee inclusions; large discrepancies correctly trigger a warning
- No auto-correction — the flag alerts the user; they decide whether to fix the amount, quantity, or price
- No new UI components — uses the existing `FieldFlag` and amber-border system in ReviewTable

## Key Decisions

- **1% relative tolerance**: Accommodates rounding and minor fee inclusions without being too permissive. Fixed absolute thresholds don't scale across transaction sizes.
- **BUY/SELL only**: The qty × price = amount identity only holds reliably for trades. Dividends have qty (shares held) and price (per-share dividend) that don't multiply to the total due to partial holdings, DRIP reinvestment, etc.
- **Ignore fees in formula**: Whether the LLM reports amount as gross or net of fees is inconsistent. Subtracting fees from one side would make the check less reliable when the LLM's fee-inclusion behavior varies.
- **Flag amount field**: When the three fields disagree, it's ambiguous which one is wrong. Flagging `amount` is a reasonable default since it's the derived value (qty × price), and the user can inspect all three.

## Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R1][Technical] Should the check use `Math.abs(amount - quantity * unitPrice) / Math.abs(amount) > 0.01` or is there a better formulation that handles edge cases (e.g., very small amounts)?

## Next Steps

→ `/ce:plan` for structured implementation planning
