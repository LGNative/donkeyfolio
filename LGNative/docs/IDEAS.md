# Ideas backlog

Running list of things to consider — not commitments, not prioritized. Add stuff
freely as it occurs to you. Triage later in `ROADMAP.md`.

Format per item:

```
## YYYY-MM-DD — short title

- **Why:** the user-visible problem or opportunity
- **What:** rough sketch of the solution
- **Effort:** XS / S / M / L / XL
- **Open questions:** anything to resolve before starting
```

---

## 2026-05-01 — Force EUR display on USD-quoted assets (TR-only mode)

- **Why:** Donkeyfolio asset detail page shows USD for NASDAQ-listed stocks,
  even though TR PT users only ever see EUR. Confusing.
- **What:** Optional setting that overrides asset.quote_ccy = EUR for imported
  assets, with quote_mode = MANUAL. Addon then pushes EUR prices via own quote
  feeder (Yahoo USD × ECB FX).
- **Effort:** M (3-4h)
- **Open questions:** Breaks Yahoo auto-sync. User has rejected forcing the
  platform once already — keep this on ice unless they change their mind.

## 2026-05-01 — pytr-style WebSocket sync addon

- **Why:** PDF parsing has a long tail of edge cases. WebSocket API to TR
  returns structured JSON.
- **What:** Separate `tr-live-sync` addon that uses Anthropic SecretsAPI to
  store TR phone+PIN, talks to TR's WebSocket, delivers transactions in JSON.
- **Effort:** XL (2-3 days)
- **Open questions:** TR can break the API. Violates ToS technically. User has
  access to pytr Python lib — could call it via subprocess?

## 2026-05-01 — AI Wizard auto-extract from screenshots

- **Why:** User has to type/paste TR app data manually. Could OCR screenshots of
  the TR app's holdings list.
- **What:** Add upload button to the AI Wizard that accepts an image, passes it
  to Claude as multimodal input, Claude extracts holdings table to text, then
  runs normal validation flow.
- **Effort:** S (1-2h once Wizard infra exists)
- **Open questions:** Adds vision tokens to API call (~$0.05 extra per
  validation). TR app screenshot UI might change.

## 2026-05-01 — Per-asset import (phased)

- **Why:** Big yearly imports are scary. User wants to validate asset-by-asset.
- **What:** After parsing, show a per-asset list with checkboxes. User imports
  only selected assets first, validates, imports more later.
- **Effort:** M (4-5h)
- **Open questions:** Cash flow gets fragmented. Reconciliation becomes harder.

## 2026-05-01 — Tax Report PDF enhancements

- **Why:** Currently we parse the staking section. TR Tax Report has more:
  realized gains/losses, dividend WHT detail, country breakdown.
- **What:** Extend `tr-tax-report.ts` to extract these. Surface as a "Tax Year
  Summary" tab in the addon.
- **Effort:** M (4-6h)
- **Open questions:** Layout varies year-over-year — needs robust multi-year
  regex.

## 2026-05-01 — Support multiple TR accounts in one user

- **Why:** Some users have TR cash + TR trading + TR crypto as separate
  Wealthfolio accounts.
- **What:** Account picker in addon shows all TR accounts. Drop one PDF per
  account, idempotency keys keep them separate.
- **Effort:** S (already mostly works — just need UX clarification)
- **Open questions:** None blocking.

---

## Triage policy

- Add ideas freely.
- Once a month, review and either:
  - Move to `ROADMAP.md` with priority + estimated start week.
  - Mark `WONT_DO` here with rationale.
  - Leave for later — no pressure.
- Don't delete ideas. The graveyard is useful context.
