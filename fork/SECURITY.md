# Donkeyfolio — Security & Secrets

This document explains where every secret lives for the Donkeyfolio fork. **No
secret values are ever committed to this repository.**

## Tauri Updater Signing

| What                                    | Where                                              | In git? |
| --------------------------------------- | -------------------------------------------------- | ------- |
| Private signing key                     | `~/.tauri/donkeyfolio.key`                         | ❌ No   |
| Public signing key (file)               | `~/.tauri/donkeyfolio.key.pub`                     | ❌ No   |
| Public signing key (embedded in build)  | `.env.example` → `DONKEYFOLIO_UPDATER_PUBKEY`      | ✅ Yes (public-by-design) |
| Per-machine overrides                   | `.env.local` (gitignored)                          | ❌ No   |
| Old broken key (backup)                 | `~/.tauri/donkeyfolio.key.broken-*`                | ❌ No   |

### Current key

- Generated: 2026-05-21 via `pnpm tauri signer generate --ci -w ~/.tauri/donkeyfolio.key --force`
- Password: **none** (CI mode, empty)
- Pubkey ID: `9514113AD550414A`

### GitHub Actions Secrets

These live encrypted in `https://github.com/LGNative/donkeyfolio/settings/secrets/actions`
and are only readable by GitHub Actions runners (never logged or displayed):

| Name                                    | Purpose                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `TAURI_PRIVATE_KEY`                     | Contents of `~/.tauri/donkeyfolio.key` (base64 minisign) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`    | Empty string (key has no password)                       |
| `DOCKERHUB_TOKEN` / `DOCKERHUB_USERNAME`| For `.github/workflows/docker-publish.yml`               |

### Verifying nothing leaks

Run these and ensure they all return empty:

```bash
git log --all -p -S "donkeyfolio2026"                     # old password literal
git log --all -p -S "BEGIN PRIVATE KEY"                   # any PEM key
git grep "rsign encrypted secret key"                     # rsign private key content
```

If you regenerate the signing key, you MUST:
1. Update `~/.tauri/donkeyfolio.key` (locally)
2. Update `DONKEYFOLIO_UPDATER_PUBKEY` in `.env.example` (committed, public)
3. Run `gh secret set TAURI_PRIVATE_KEY -R LGNative/donkeyfolio --body "$(cat ~/.tauri/donkeyfolio.key)"`
4. Rebuild and re-publish the release (old apps cannot verify new signatures)

## API keys (per-user, per-machine)

These are stored in macOS Keychain by Donkeyfolio itself when the user enters
them in Settings, never in this repo:

- Anthropic API key (`donkeyfolio_addon_tr-importer-addon_tr-importer:anthropic-api-key`)
- Other addon-specific secrets

Namespace prefix is configured by `DONKEYFOLIO_SECRET_PREFIX` in `.env.example`.
