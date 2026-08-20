-- Donkeyfolio · stop the perpetual "Price updates needed for N holdings" warning.
--
-- ROOT CAUSE: 128 US stocks (AMD, AAPL, NVDA, AMZN, ...) were imported with an
-- EMPTY instrument_exchange_mic. The price-staleness health check computes each
-- asset's "effective trading day" via market_effective_date(now, exchange_mic).
-- With mic = NULL it falls back to the DEFAULT valuation timezone (Europe) and
-- returns *today's* local date with no market-close grace. But these stocks are
-- priced from Yahoo US, whose latest close is *yesterday* until the US market
-- closes (~22:00 Lisbon). So every trading day, all 128 read as "1 day stale"
-- and the warning never clears — clicking "Update Prices" can't help because
-- there is no newer US quote during the day.
--
-- FIX: tag these US stocks with XNAS (NASDAQ). In exchanges.json XNAS =
-- timezone America/New_York, close 16:00, and Yahoo suffix "" — so the fetch
-- symbol is unchanged ("AMD" stays "AMD"), quotes and values are untouched, and
-- market_effective_date now uses the US calendar => a yesterday-close quote is
-- NOT stale mid-session. All US exchanges (XNAS/XNYS/XASE/ARCX) share the same
-- America/New_York 16:00 calendar and empty Yahoo suffix, so XNAS is functionally
-- correct for every US listing (a NYSE name is labelled NASDAQ cosmetically only;
-- a later provider sync may refine it). Scope is pinned to assets whose LATEST
-- quote is actually in USD, so European/FX/crypto rows are never touched.
--
-- Run with the Donkeyfolio app CLOSED, then refresh Data Health (or Update Prices).

UPDATE assets
SET instrument_exchange_mic = 'XNAS',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (instrument_exchange_mic IS NULL OR instrument_exchange_mic = '')
  AND quote_mode != 'MANUAL'
  AND is_active = 1
  AND kind != 'FX'
  AND id IN (
    SELECT a.id
    FROM assets a
    JOIN (
      SELECT asset_id, currency,
             ROW_NUMBER() OVER (PARTITION BY asset_id ORDER BY day DESC) AS rn
      FROM quotes
    ) latest ON latest.asset_id = a.id AND latest.rn = 1
    WHERE latest.currency = 'USD'
  );
