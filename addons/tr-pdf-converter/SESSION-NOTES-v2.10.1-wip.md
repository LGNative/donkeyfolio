# Session continuation notes — v2.10.1 (WIP)

Last session: 2026-04-29. **Not pushed, not released.** Resume from here.

## What landed in this WIP

- **Luhn/ISIN-format validation** in `tr-isin-utils.ts` (new shared helper).
  - Replaces 2 sites of bare `/\b[A-Z]{2}[A-Z0-9]{10}\b/` regex
    (`tr-to-activities.ts`, `tr-parser.ts`).
  - Vendored `jcmpagel-js/trading.js` site NOT yet migrated (still uses loose
    regex on the trading parser side — lower risk because trading rows are
    filtered later by ISIN known-list, but worth a follow-up).
  - Fixes: SUBSCRIPTION asset that Yahoo couldn't price
    (`CLAUDE.AI SUBSCRIPTION` cash row → "SUBSCRIPTION" matched ISIN regex →
    fake EQUITY asset).
  - Build passes (3,712 kB / gzip 884 kB).

## Cross-validation findings (DB vs TR app)

User compared multiple holdings against TR app. Key insight: **most holdings are
correct within FX rounding** — apparent mismatches are display-currency
confusion (Donkeyfolio shows USD-quoted assets in USD, TR shows everything in
EUR). Examples confirmed correct:

- **PYPL**: TR 91.257226 / €63.95 vs DB 91.256844 / $69.81. €63.95 × 1.0917 FX =
  $69.81 ✓. Shares drift 0.000382 (float).

The genuine discrepancies (need fixing):

- **AMD**: cost basis off by €445. Not FX, not parser — Wealthfolio backend
  treats SELL proceeds as cost reduction. See thread #3 below.
- **NOW (ServiceNow)**: 10.55 shares DB vs 21.56 TR = exact 2:1 split not
  applied. See thread #1 below.
- **SUBSCRIPTION**: fake asset (Luhn fix in this WIP).

## Open threads (priority order)

### 1. Auto-apply detected stock splits

TR PDF Converter v2.10 auto-detects splits via Yahoo. Currently it only
**lists** them in the UI. User example: NOW (ServiceNow) shows **10.55 shares in
DB vs 21.56 in TR = exact 2:1 split** that was never applied as SPLIT activity.
Same pattern likely on other holdings.

→ Wire the `autoSplits` array into `buildActivitiesFromParsed()` so it emits
SPLIT activities (assetId + ratio + date) at import time. SDK type: check
`ActivityType.SPLIT` schema — needs `quantity` (split ratio
numerator/denominator) or a single `ratio` field.

### 2. AMD share drift +0.052632

Concrete numbers (DB vs user's TR):

- TR: 46.762988 shares @ €101.43 avg = €4,743.15 cost basis
- DB: 46.81562 shares (51.753952 BUY − 4.938332 SELL)
- Phantom: 0.052632 shares

3 groups of duplicate BUYs found in DB (same date/amount/qty):

- 2024-12-20 @ €99.98 → 3× 0.893814 shares
- 2025-01-10 @ €100 → 2× 0.887784
- 2025-01-27 @ €100 → 2× 0.899118

These are likely legitimate (3 separate savings plans) but worth verifying
against the source PDF. v2.7.9 explicitly enabled idempotency-key per line to
_allow_ same-day duplicates, so the parser would not collapse them.

→ Build the chain-rewrite debug panel (paused in `enforceChainConsistency`)
**plus** an analogous "trading rows that produced this activity" trace, so the
user can see line-by-line which PDF row created the phantom 0.05.

### 3. Cost basis: TR uses moving-avg, Donkeyfolio shows different

- TR AMD avg: €101.43 → cost basis €4,743.15 → return 177.38%
- Donkeyfolio AMD avg: $107.48 (≈€101.30 EUR) but **cost basis displayed
  €4,298.22** → return 200.71%
- Mathematically: €5,302.82 (sum BUYs) − €1,001 (SELL proceeds) ≈ €4,301.82 →
  matches Donkeyfolio exactly.

→ This is a **Wealthfolio core / Rust** issue, not the TR addon. The holdings
calculator at `crates/core/src/portfolio/snapshot/holdings_calculator.rs` is
using proceeds (not cost-of-sold) as the reduction on the position cost basis.
Look at the `cost_basis_removed` path (lines ~779-820, ~831-848).

→ Probably need to confirm: when an activity is SELL, is the engine computing
`cost_basis_removed = qty_sold × avg_cost_at_sale_time` (correct) or
`cost_basis_removed = sell_amount` (wrong, what we're seeing)?

### 4. Cash €10,303 phantom drift

Symmetric IN/OUT drift visible on the import readiness card:

- IN drift +€10,303.24, OUT drift +€10,303.24 → net cancels
- Same magnitude that v2.7.5 was supposed to eliminate

Plan (paused mid-edit):

- Modify `enforceChainConsistency` to capture every rewrite:
  `{lineNumber, original: {in, out, saldo}, corrected: {in, out}, prevSaldo, beschreibung}`
- Surface top-N rewrites by abs(€) in a debug card on the page
- Identify the layout-quirk producing phantoms

### 5. SUBSCRIPTION asset cleanup (manual, one-time)

Existing DB has the fake asset `f2becb3f-5c88-4125-bc52-0a548d76e73a`
(SUBSCRIPTION). The v2.10.1 fix prevents NEW imports from creating it, but the
existing asset + 2 WITHDRAWAL activities (€90 + €90 = €180) need cleanup.
Either:

- Delete the asset and re-import, or
- Migrate the 2 activities' `asset_id` to a `$CASH-EUR` cash asset and drop the
  SUBSCRIPTION asset.

## How to resume

```sh
git log --oneline -3                   # see WIP commit
git diff HEAD~1                        # review what's WIP
cd addons/tr-pdf-converter && pnpm build  # confirm still builds
```

The WIP commit is **not pushed**. Don't run `pnpm package` or upload to the
GitHub release until the open threads above are decided / fixed.
