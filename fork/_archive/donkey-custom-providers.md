# Donkeyfolio — custom market-data providers (backup for fresh-DB rebuild)

Extracted from `market_data_custom_providers` before the clean rebuild.
Re-create via Settings → Market Data → Custom Providers → Add Provider. Full
INSERTs also saved next to this file as `donkey-custom-providers.sql`.

## 1. CoinGecko (priority 10)

- **Code:** `coingecko` · **Format:** JSON
- **Description:** Cryptocurrency prices in EUR (BTC, ETH, XRP, ADA, SOL…),
  aggregated across global exchanges. Source for all crypto holdings.
- **Latest URL:**
  `https://api.coingecko.com/api/v3/simple/price?ids={SYMBOL}&vs_currencies=eur&include_last_updated_at=true`
- **Price path:** `$.{SYMBOL}.{currency}`
- **Date path:** `$.{SYMBOL}.last_updated_at`

## 2. Frankfurter — FX Rates (ECB) (priority 20)

- **Code:** `frankfurter-ecb` · **Format:** JSON
- **Description:** Official ECB exchange rates (EUR/USD, EUR/CHF, …). Converts
  foreign-currency prices to base currency (EUR). NOT a stock exchange.
- **Latest URL:** `https://api.frankfurter.app/latest?from={SYMBOL}&to=EUR`
- **Price path:** `$.rates.EUR`
- **Date path:** `$.date`
- **Date timezone:** `Europe/Lisbon`

## 3. Onvista (LS Exchange) (priority 20)

- **Code:** `onvista-lsx` · **Format:** JSON
- **Description:** Real-time EUR prices from LS Exchange — the venue Trade
  Republic trades on — via onvista, matched by ISIN. Stock prices match TR to
  the cent. ETFs fall back to Yahoo / Börse Frankfurt.
- **Latest URL:**
  `https://api.onvista.de/api/v1/instruments/STOCK/ISIN:{SYMBOL}/snapshot?codeMarket=_LSX`
- **Price path:** `$.quote.last`
- **Currency path:** `$.quote.isoCurrency`
