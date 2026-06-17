PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE market_data_custom_providers (
    id          TEXT    NOT NULL PRIMARY KEY,
    code        TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    priority    INTEGER NOT NULL DEFAULT 50,
    config      TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
INSERT INTO market_data_custom_providers VALUES('015ccf21-dfca-48fe-863c-0d859ae9cf0b','coingecko','CoinGecko','Cryptocurrency prices in EUR (BTC, ETH, XRP, ADA, SOL…), aggregated across global exchanges. Source for all crypto holdings.',1,10,'{"sources":[{"kind":"latest","format":"json","url":"https://api.coingecko.com/api/v3/simple/price?ids={SYMBOL}&vs_currencies=eur&include_last_updated_at=true","pricePath":"$.{SYMBOL}.{currency}","datePath":"$.{SYMBOL}.last_updated_at","dateFormat":null,"currencyPath":null,"factor":null,"invert":false,"locale":null,"headers":null,"openPath":null,"highPath":null,"lowPath":null,"volumePath":null,"defaultPrice":null,"dateTimezone":null}]}','2026-04-30T10:43:33.952725+00:00','2026-04-30T11:03:54.854054+00:00');
INSERT INTO market_data_custom_providers VALUES('235e132f-8172-4bdd-a6a1-9eef55dc11ff','frankfurter-ecb','Frankfurter — FX Rates (ECB)','Official European Central Bank currency exchange rates (EUR/USD, EUR/CHF, …). Converts foreign-currency prices to your base currency (EUR). NOT a stock exchange — do not confuse with the built-in "Börse Frankfurt".',1,20,'{"sources":[{"kind":"latest","format":"json","url":"https://api.frankfurter.app/latest?from={SYMBOL}&to=EUR","pricePath":"$.rates.EUR","datePath":"$.date","dateFormat":null,"currencyPath":null,"factor":null,"invert":null,"locale":null,"headers":null,"openPath":null,"highPath":null,"lowPath":null,"volumePath":null,"defaultPrice":null,"dateTimezone":"Europe/Lisbon"}]}','2026-04-30T10:48:49.743738+00:00','2026-06-05T22:02:27.400167+00:00');
INSERT INTO market_data_custom_providers VALUES('d11e093d-44bf-40ef-af3f-85d0833aa9bb','onvista-lsx','Onvista (LS Exchange)','Real-time EUR prices from LS Exchange — the venue Trade Republic trades on — via onvista, matched by ISIN. Stock prices match Trade Republic to the cent. ETFs are not on LS Exchange and fall back to Yahoo / Börse Frankfurt.',1,20,'{"sources":[{"kind":"latest","format":"json","url":"https://api.onvista.de/api/v1/instruments/STOCK/ISIN:{SYMBOL}/snapshot?codeMarket=_LSX","pricePath":"$.quote.last","datePath":null,"dateFormat":null,"currencyPath":"$.quote.isoCurrency","factor":null,"invert":false,"locale":null,"headers":null,"openPath":null,"highPath":null,"lowPath":null,"volumePath":null,"defaultPrice":null,"dateTimezone":null}]}','2026-06-05T17:49:01.009Z','2026-06-05T17:54:55.527157+00:00');
COMMIT;
