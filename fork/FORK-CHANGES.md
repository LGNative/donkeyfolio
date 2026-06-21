# Donkeyfolio — Fork Changes

**Donkeyfolio = Wealthfolio (upstream) + the layer described here.**

This file + `fork/patches/` are the record of everything we changed, so nothing
is lost when Wealthfolio releases a new version. Read this before any upstream
update.

Current base: **Wealthfolio v3.5.2** · fork branch: `donkeyfolio/v3.5.2`
Remotes: `origin` = LGNative/donkeyfolio · `upstream` = afadil/wealthfolio

---

## How the changes survive an update

Three layers of safety, strongest first:

1. **Git fork branch** — our work lives as commits on top of the `v3.5.2`
   upstream tag. On a new release we rebase those commits onto the new tag.
   Proven on the 3.5.1 → 3.5.2 update (11 commits replayed cleanly).
2. **Patches** — `fork/patches/*.patch` = the committed layer exported with
   `git format-patch`. Re-appliable on any tree with `git am` even outside this
   repo's history.
3. **This catalog** — human-readable inventory, including the _operational_
   items (DB scripts, installed-addon patches) that live outside git.

> ⚠️ Patches only capture **committed** work. Anything uncommitted (see "In
> progress" below) is NOT in the patches yet — commit it before updating.

---

## Structure

| Path                       | What                               | Isolated?                                                                        |
| -------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `fork/addons/tr-importer/` | Our Trade Republic importer addon  | ✅ fully separate (not an upstream file)                                         |
| `fork/patches/`            | Committed fork commits as `.patch` | ✅ separate                                                                      |
| `fork/FORK-CHANGES.md`     | This catalog                       | ✅ separate                                                                      |
| in-place edits             | config, theme, components, crates  | ❌ edits to upstream files — preserved via git/patches, **not** as drop-in files |

Honest note: most of our non-addon work are **edits to existing Wealthfolio
files** (theme tokens in `globals.css`, branding in `tauri.conf.json`, component
tweaks). Those physically cannot live in a separate "drop-in" folder — they're
patches against upstream. The git branch + patches are how a fork preserves
them; the rebase re-applies them on each update.

---

## Inventory

### A. Branding & config — `apps/tauri/`

- `tauri.conf.json`: productName **Donkeyfolio**, identifier
  `com.luisgoncalves.donkeyfolio`, version, window title.
- Updater endpoint repointed to the **fork** (dead URL) → blocks the official
  Wealthfolio updater from hijacking/overwriting the app.
- `icons/ios/*` — Donkeyfolio "D" app icon.

### B. Theme — `apps/frontend/src/globals.css` + components

- `--brand-50..950` green scale (anchored `600 = #1FAD66`); `--primary`,
  `--success`, `--ring`, `--chart-1..9`, `--chart-stone` all **derive** from it.
- Softer paper background (`--flexoki-bg`), removed gradient washes.
- Palette migration — **no hardcoded hex** anywhere: net-worth, allocation
  targets, rebalance, retirement-planner, save-up, treemap composition chart all
  use brand/chart tokens.

### C. UX polish — `apps/frontend/`

- Holdings sorted by return %; Net Worth shows cents; percentages 2 decimals;
  zero drivers hidden; **Wealthfolio Connect hidden** from sidebar; ticker
  avatars on a uniform dark chip with near-monochrome logos auto-inverted
  (measured per-logo from pixel luminance/saturation — no per-asset table).

### D. TR Importer addon — `fork/addons/tr-importer/` (the biggest piece)

- Trade Republic CSV → Wealthfolio activities.
- `tr-isin-tickers.ts` — curated ISIN→ticker table (Alibaba `9988.HK`, Sibanye
  `SSW.JO`, EU suffixes, etc.).
- Spin-off / staking `TRANSFER_IN` flagged as external (`is_external`).
- Import document preserved across tab switches.
- EUR holdings view, AI expert panel, diagnostics, FX rates, geography.
- See `tr-importer-lot-engine-constraints` memory for the corporate-action
  rules.

### E. Logos — `apps/frontend/public/ticker-logos/`

- `SOL.png` corrected to the real Solana logo (was a wrong orange mark);
  `SOL-EUR.png` variant added.

### F. Dynamic EUR resolution — `fork/addons/tr-importer/` (NOT base code)

Kills the recurring ticker problems (ISIN-as-symbol US stocks, ADRs, EU
suffixes) AND makes assets natively EUR (matching Trade Republic), so daily
history flows in EUR — **with no hardcoded table and no base-code changes**.

- `src/lib/tr-resolve.ts` (new): `resolveIsins(ctx, isins)` — for each ISIN
  calls the app's OWN provider search (`ctx.api.market.searchTicker`, hits
  Yahoo + OpenFIGI), then prefers the EUR-denominated listing (Xetra > Frankfurt
  > other). Concurrency-limited, best-effort. Provider-driven, zero per-asset
  > mappings.
- `src/lib/tr-csv-mapper.ts`: `MapperOptions.resolved` + `resolveAsset` prefers
  the dynamic map; the curated `tr-isin-tickers.ts` table is now only a **safety
  net** (to be deleted once the dynamic path is verified to cover every ISIN).
- `src/pages/tr-converter-page.tsx`: async pre-pass at preview time
  (`A resolver ativos em EUR… n/total`), reused at import.
- `manifest.json`: added `market-data: searchTicker` permission.
- EUR daily **history** then comes for free from the built-in Börse Frankfurt /
  Yahoo `.DE` provider once the symbol is the EUR listing.
- ⚠️ Uncommitted — not in patches yet. Applies to **new** imports only (existing
  assets can't change symbol via the SDK → re-import to EUR-ize).

> The earlier crates approach (`yahoo/mod.rs` + `sync.rs` ISIN enrichment) was
> **reverted** to keep base code untouched; backup at
> `fork/_archive/wip-crate-isin-resolution.patch`.

---

### G. TR Importer overhaul (v3.5.2 era) — patches 0016-0017

Done after the v3.5 data marathon, all SDK-only (no base-code change):

- **EUR conversion fix** — `src/lib/tr-fx-pairs.ts`: the v3.5 core converts a
  holding's quote currency to base (EUR) via FX when they differ; it only needs
  the `FX:<ccy>/EUR` rate to exist. The routine reads each held asset's real
  quote currency and creates the missing pairs (source YAHOO, ECB-seeded) via
  `exchangeRates.add`, then syncs + recalculates. This un-inflated the portfolio
  (USD shown as EUR → real EUR). Button: "Fix EUR conversion" in the EUR view.
- **MANUAL_CASH_TRANSFER** mapped by amount sign → DEPOSIT / WITHDRAWAL (was
  skipped as Unknown Type; e.g. a TR goodwill payment).
- **English UI** — the whole addon translated PT → EN to match the base app
  (logic strings / codes untouched). See `tr-addon-english-ui` memory.
- **2 tabs** (Import + Analysis) — removed the Advanced tab (AI expert + SDK
  test) and deleted the now-dead `expert-panel.tsx`, `tr-ai-expert.ts`,
  `tr-sdk-test.ts`. Diagnostics live in Analysis.
- **"Start over"** button — return to the drop zone mid-import without leaving
  the app.
- **Review Assets redesign** — urgency-grouped sections, currency badges (USD →
  EUR), per-asset density, pre-import type breakdown.
- `manifest.json`: version 5.3.2 → 3.5.2 (match the app), shorter description.

---

## Operational items (NOT in git — runtime/data)

These are not code; they live on the user's machine and must be re-done if the
DB/addons are reset.

- **Custom market-data providers** (CoinGecko, Frankfurter-ECB, Onvista-LSX) —
  live in the DB (`market_data_custom_providers`), lost on a clean rebuild.
  Re-create from the committed spec `fork/_archive/donkey-custom-providers.md`
  (full INSERTs in the sibling `.sql`).
- **DB scripts** (run with the app closed, against
  `~/Library/Application Support/com.luisgoncalves.donkeyfolio/app.db`):
  - `donkey-eu-tickers.sql` — add Yahoo exchange suffixes (SU.PA, ENR.DE, …) so
    EU stocks get price history.
  - `donkey-cleanup.sql` — drop bloated snapshot tables + VACUUM (1 GB → ~50
    MB).
- **Installed-addon patches** — Swingfolio / Fees Tracker
  `TOTAL → portfolio:all` fix, applied to the **built** addon bundles in the
  app-support addons dir. These are third-party addons, not our fork → lost if
  the addon updates.
- **Re-import procedure** — delete the account + "Reset import history"
  (localStorage) before re-importing a TR CSV, or activities dedupe to 0.

---

## Update procedure (new Wealthfolio release)

```bash
# 1. get the new upstream tag
git fetch upstream --tags

# 2. replay our layer onto it (rebase the fork branch)
git checkout donkeyfolio/v3.5.2
git rebase --onto vNEW v3.5.2          # vNEW = the new tag
#   ↳ if a hook aborts: GIT_EDITOR=true git -c core.hooksPath=/dev/null rebase --continue
#   conflicts to expect:
#     tauri.conf.json  → keep Donkeyfolio / identifier / fork updater
#     globals.css      → keep the --brand-* scale + derived tokens

# 3. rebuild shared package dists (else stale type errors)
pnpm -r --filter "./packages/*" run build

# 4. verify
pnpm type-check && cargo build

# 5. rebuild the TR Importer addon
cd fork/addons/tr-importer && node_modules/.bin/vite build
#   → copy dist/addon.js to the app-support addons dir

# 6. rebuild + install the app (frontend is embedded in the binary)
rm -rf dist && touch apps/tauri/src/*.rs apps/tauri/build.rs && pnpm tauri build
rm -rf /Applications/Donkeyfolio.app && \
  cp -R target/release/bundle/macos/Donkeyfolio.app /Applications/
```

If git history is ever lost, `git am fork/patches/*.patch` re-applies the
committed layer onto a fresh upstream checkout.
