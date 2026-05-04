# LGNative customizations

This folder isolates **all custom changes** that aren't part of upstream
`afadil/wealthfolio`. Anything in here is **safe to keep** when pulling new
versions of Wealthfolio — git merge conflicts will only happen on the synced
directories (`apps/`, `crates/`, `packages/`), never here.

## Why a separate folder

Forking Wealthfolio means we want **most** of the upstream code as-is (otherwise
we'd lose security fixes, performance improvements, new features) but **some**
custom additions. Keeping the additions in a single isolated tree makes:

- `git pull upstream main` — drops new core into `apps/`/`crates/`, doesn't
  touch this folder.
- Onboarding — anyone reading the repo sees what's "ours" vs "theirs" at a
  glance.
- Removal — if we ever stop a customization, delete one folder.

## Structure

```
LGNative/
├─ README.md              ← this file
├─ addon-extensions/      ← extras for our published addons (TR PDF
│                           Converter etc.) — extra modules, helpers,
│                           or alternate-flow code that doesn't belong
│                           in the addon's own src/.
├─ patches/               ← .patch files we apply to upstream
│                           Wealthfolio core (one .patch per
│                           customization, with rationale in the
│                           commit message).
├─ docs/                  ← internal documentation about our setup,
│                           workflows, decisions.
└─ scripts/               ← helper scripts (build wrappers, custom
                            tooling, sync helpers).
```

## Where the addons live

The TR PDF Converter, AI Wizard, etc. live in **`addons/`** at the repo root —
that's the published-addon convention shared with upstream. We don't move them
here because:

1. The Wealthfolio addon catalog scans `addons/` directly.
2. Upstream sometimes ships addon templates there too — we just add our own
   folders alongside, never modifying upstream addons.

So the rule is:

- **Code that ships INSIDE a published addon** → `addons/<addon-name>/src/`
- **Code shared across multiple LGNative addons or experiments** →
  `LGNative/addon-extensions/`
- **Patches to Wealthfolio core** → `LGNative/patches/`
- **Documentation about our fork** → `LGNative/docs/`

## Sync workflow with upstream

```bash
git remote add upstream https://github.com/afadil/wealthfolio.git
git fetch upstream
git merge upstream/main
# Conflicts will only appear in apps/ / crates/ / packages/ if we
# patched core. Resolve those, re-apply patches from LGNative/patches/
# if needed.
# This LGNative/ folder will NEVER conflict because upstream doesn't
# have it.
```

## Current customizations

(empty — populate as we add patches)
