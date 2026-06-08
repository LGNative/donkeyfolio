# Donkeyfolio

A personal fork of **[Wealthfolio](https://github.com/afadil/wealthfolio)** — a
local-first desktop app for tracking investments and net worth. All data stays
on your machine in a local SQLite database; no account, no cloud required.

This fork follows upstream Wealthfolio closely and adds a thin personal layer on
top: branding, a Trade Republic CSV importer add-on, and a few small fixes. All
credit for the application itself goes to the Wealthfolio authors — see
**Credits** below.

## Stack

- **Frontend** — React + Vite + TypeScript (Tailwind)
- **Desktop / mobile** — Tauri (Rust)
- **Web mode** — Axum HTTP server
- **Storage** — SQLite (Diesel migrations)

## Development

```bash
pnpm install        # install dependencies

pnpm tauri dev      # desktop app (Tauri)
pnpm run dev:web    # browser (web mode)

pnpm test           # frontend tests
cargo test          # Rust tests
pnpm type-check     # TypeScript
pnpm lint           # lint
```

## Build

```bash
pnpm tauri build    # production desktop build
```

## License

This project inherits its license from upstream Wealthfolio — see
[LICENSE](./LICENSE). It is a derivative work; original copyright remains with
the Wealthfolio authors.

## Credits

Built on **[Wealthfolio](https://github.com/afadil/wealthfolio)** by
[@afadil](https://github.com/afadil) and contributors. Donkeyfolio is an
unaffiliated personal fork.
