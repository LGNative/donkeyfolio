-- Donkeyfolio · fix the "Quotes sync failing for PSTG" error.
--
-- Pure Storage rebranded to Everpure, Inc. and its NYSE ticker changed
-- PSTG → "P" on 2026-04-17 (confirmed: everpuredata.com / NYSE:P). Yahoo stopped
-- serving "PSTG" (last quote 2026-06-12), so the sync kept failing. FIX: point
-- the asset at the live symbol/venue. XNYS (NYSE) has an empty Yahoo suffix, so
-- the fetch symbol becomes plain "P" (Everpure). Keyed by the stable asset id so
-- history/holdings are preserved (asset_id UUID is unchanged).
--
-- Run app-closed, then Rebuild Full History / Update Prices to pull P's quotes.

UPDATE assets
SET instrument_symbol       = 'P',
    display_code            = 'P',
    name                    = 'Everpure, Inc.',
    instrument_exchange_mic = 'XNYS',
    updated_at              = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = '9b5deddf-e6f4-47d4-9af9-76dc0d44f770'
  AND instrument_symbol = 'PSTG';
