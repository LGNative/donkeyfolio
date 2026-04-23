# Community Addons — Install Guide

Donkeyfolio bundles 3 curated community addons in `addons/` that aren't in the
official Wealthfolio store. Install them via **Settings → Add-ons → + (Install
from file)** using the ZIPs from GitHub Releases.

## Available Addons

| Addon                | Version | License  | Source                                                                                  | ZIP                                                                                                                                      |
| -------------------- | ------- | -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **AI Importer**      | 1.3.0   | AGPL-3.0 | [foliveira/wealthfolio-importer](https://github.com/foliveira/wealthfolio-importer)     | [wealthfolio-importer-1.3.0.zip](https://github.com/LGNative/donkeyfolio/releases/download/addons-v1/wealthfolio-importer-1.3.0.zip)     |
| **Rebalancer**       | 3.0.0   | —        | [ibalboteo/wealthfolio-rebalancer](https://github.com/ibalboteo/wealthfolio-rebalancer) | [wealthfolio-rebalancer-3.0.0.zip](https://github.com/LGNative/donkeyfolio/releases/download/addons-v1/wealthfolio-rebalancer-3.0.0.zip) |
| **Dividend Tracker** | 1.0.2   | MIT      | [kwaich/dividend-tracker](https://github.com/kwaich/dividend-tracker)                   | [dividend-tracker-1.0.2.zip](https://github.com/LGNative/donkeyfolio/releases/download/addons-v1/dividend-tracker-1.0.2.zip)             |

## Install Steps

1. Download the ZIP from the table above
2. In Donkeyfolio: **Settings → Add-ons**
3. Click **+** next to "Browse Add-ons"
4. Select the ZIP → review permissions → approve
5. Addon appears in the Installed list

## Updates

Community addons are not yet part of the auto-update store. When a new version
is released:

1. Download the new ZIP from GitHub Releases
2. Uninstall the old version in **Settings → Add-ons**
3. Install the new ZIP

**Future work:** full auto-update requires a custom store endpoint that serves
combined first-party + community addon listings (Phase 2, TBD).

## Why Not the Store?

The Wealthfolio Addon Store (`https://wealthfolio.app/api/addons`) is controlled
by the upstream Wealthfolio project. Community addons can only appear there if
the upstream accepts them. A custom store endpoint would require modifying core
Rust code (~20-line patch) and adds maintenance burden on upstream pulls.
