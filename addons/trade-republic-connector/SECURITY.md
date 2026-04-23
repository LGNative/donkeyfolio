# Trade Republic Connector — Security Model

## Principle: 100% Local-First

All your Trade Republic data stays on YOUR device. There is no cloud
intermediary, no proxy server, no third-party aggregator.

```
Your Device  ──WSS (TLS 1.3)──>  Trade Republic API
     │
     └── SQLite (local database, never uploaded)
```

## Credential Storage

| What               | Where                                                              | Encryption                    |
| ------------------ | ------------------------------------------------------------------ | ----------------------------- |
| Phone number + PIN | macOS Keychain / Linux Secret Service / Windows Credential Manager | OS-level encryption (AES-256) |
| Session tokens     | In-memory only (RAM)                                               | Never written to disk         |
| Portfolio data     | Local SQLite database                                              | At rest on your filesystem    |

### How it works:

1. **First setup**: You enter your TR phone number and 4-digit PIN
2. **Storage**: Credentials are saved via the OS keychain (`SecretStore` trait)
   - macOS: Keychain Access (hardware-backed on Apple Silicon)
   - Linux: Secret Service API (GNOME Keyring / KWallet)
   - Windows: Credential Manager
3. **Login**: Credentials are read from keychain, sent directly to TR over TLS
4. **2FA**: You confirm login on your Trade Republic phone app (4-digit code)
5. **Session**: Cookies held in memory only — lost on app restart (re-auth
   required)

## Network Security

- All connections use **WSS (WebSocket Secure)** over TLS
- Direct connection to `api.traderepublic.com` — no middleman
- No data is sent to any server other than Trade Republic's own API
- Session refresh happens every ~5 minutes over the same encrypted channel

## What We DON'T Do

- We do NOT store session tokens on disk
- We do NOT send your data to any cloud service
- We do NOT use any third-party aggregator (SnapTrade, Plaid, etc.)
- We do NOT log your credentials or session data
- We do NOT have analytics or telemetry on this connector

## Risks to Be Aware Of

1. **Unofficial API**: This uses Trade Republic's web API, which is not
   officially documented. TR could change it without notice.
2. **Terms of Service**: Using unofficial API access may violate TR's ToS. This
   is for personal use only.
3. **PIN in keychain**: While the OS keychain is encrypted, anyone with your
   device password can access it. Use a strong device password.
4. **AWS WAF**: TR uses AWS WAF bot protection. The initial auth may require a
   webview to solve the challenge — this happens locally in Tauri's webview.

## Deleting Your Data

To remove all stored credentials:

- Settings > Trade Republic > Disconnect
- This calls `SecretStore::delete_secret("trade_republic_credentials")`
- Session cookies are immediately cleared from memory
- Local transaction data remains in SQLite until you delete it manually
