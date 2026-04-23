# Trade Republic — Import Workflow

Donkeyfolio does not have a native Trade Republic connector (the direct WS
approach is blocked by AWS WAF bot protection). Import TR data via PDF
statements + AI Importer addon.

## Workflow

1. **Export PDFs from Trade Republic** (manual, once)
   - Open the TR mobile app
   - Profile → Documents → Transactions/Tax reports
   - Export the PDFs you want to import (monthly statements work well)
   - Save them to your Mac

2. **Install AI Importer addon** (one-time setup)
   - Settings → Add-ons → Browse Add-ons → Install AI Importer (or download from
     [GitHub release](https://github.com/LGNative/donkeyfolio/releases/tag/addons-v1))
   - Configure your AI provider (Settings → AI Providers)
     - Anthropic Claude or OpenAI supported
     - Add API key

3. **Import PDFs**
   - Open AI Importer from the sidebar
   - Drop your TR PDF → review extracted transactions
   - Confirm → transactions imported as activities

## Why not a native TR connector?

TR's AWS WAF blocks direct API access without a JavaScript challenge token.
Acquiring this token requires a headless browser (Playwright) or equivalent JS
runtime — significant engineering work. See SECURITY.md history and the removed
`addons/trade-republic-connector/` crate for the previous attempt.

## Alternative JS-native parsers (for future reference)

If we decide to invest in a dedicated TR parser later:

- [jcmpagel/Trade-Republic-CSV-Excel](https://github.com/jcmpagel/Trade-Republic-CSV-Excel)
  — JS, 38★, `parser.js` reusable, no license (needs permission)
- [kalix127/tradesight](https://github.com/kalix127/tradesight) — Python, MIT
- [MarcBuch/TR-PDF-Parser](https://github.com/MarcBuch/TR-PDF-Parser) — Python,
  MIT, focus on invoices
- [Thukyd/trade-republic-portfolio](https://github.com/Thukyd/trade-republic-portfolio)
  — Jupyter, 33★, stale

Any of these could be adapted into a Donkeyfolio addon that takes a TR PDF →
extracts transactions → calls `activities.create`. Deterministic and free (no AI
tokens), but TR-specific vs AI Importer's universal approach.
