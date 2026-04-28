/**
 * ISIN → Yahoo-friendly symbol mapping for Trade Republic statements.
 *
 * Why this exists:
 *   Donkeyfolio looks up market data via Yahoo Finance, and Yahoo's API
 *   does NOT accept ISINs for most assets — it expects tickers (AAPL,
 *   MSFT) or exchange-suffixed tickers (CSPX.L, EUNL.DE). Without this
 *   mapping, importing TR PDFs leaves 80+ assets with stale prices and
 *   no logos (since /ticker-logos/<ISIN>.png doesn't exist either).
 *
 * What we map:
 *   - US/CA/major equities → plain US ticker (logos exist, Yahoo native).
 *   - Irish/LU ETFs → LSE/Xetra/XAMS ticker (Yahoo has data; no logo
 *     in the bundled set yet — text fallback shows e.g. "CSPX").
 *   - Crypto pseudo-ISINs (XF000…) → Yahoo crypto pair (BTC-EUR, …) +
 *     dedicated logos (BTC.png, ETH.png, …).
 *
 * What stays as the ISIN:
 *   Anything not in this map. The activity still imports correctly
 *   (cost basis preserved); only the live price + logo are missing.
 *
 * Source for tickers: TR statement names + manual research per ISIN.
 * Coverage focuses on the assets observed in real user portfolios; can
 * be extended freely as new ISINs come up.
 */

export interface TickerMapping {
  /** Yahoo-compatible symbol (e.g. "AAPL", "CSPX.L", "BTC-EUR"). */
  symbol: string;
  /** ISO-10383 MIC for the listing (e.g. "XLON", "XAMS"). Optional —
   * Donkeyfolio infers a sensible default from the symbol suffix when
   * absent. Crypto/FX must omit this (the backend rejects it). */
  exchangeMic?: string;
  /** Quote currency hint. EUR for European ETFs/crypto pairs, USD for
   * NASDAQ/NYSE listings. Donkeyfolio handles activity-currency FX. */
  quoteCcy?: string;
  /** "EQUITY" for stocks/ETFs, "CRYPTO" for crypto pairs. */
  instrumentType: "EQUITY" | "CRYPTO";
}

// ─── Crypto pseudo-ISINs ───────────────────────────────────────────────
// TR emits XF000* synthetic ISINs for crypto. Yahoo expects "BTC-EUR"
// style pair symbols; we pin EUR since TR settles all crypto in EUR.
const CRYPTO: Record<string, TickerMapping> = {
  XF000BTC0017: { symbol: "BTC-EUR", quoteCcy: "EUR", instrumentType: "CRYPTO" },
  XF000ETH0019: { symbol: "ETH-EUR", quoteCcy: "EUR", instrumentType: "CRYPTO" },
  XF000XRP0018: { symbol: "XRP-EUR", quoteCcy: "EUR", instrumentType: "CRYPTO" },
  XF000SOL0012: { symbol: "SOL-EUR", quoteCcy: "EUR", instrumentType: "CRYPTO" },
  XF000ADA0018: { symbol: "ADA-EUR", quoteCcy: "EUR", instrumentType: "CRYPTO" },
};

// ─── Irish/LU ETFs ─────────────────────────────────────────────────────
// TR routes ETF orders through Lang & Schwarz. Yahoo doesn't quote LS;
// we point at the LSE listing where possible (most reliable Yahoo data),
// or Xetra for funds with no LSE presence. Currency follows the listing:
// LSE GBp/USD, Xetra/Amsterdam EUR.
const ETFS: Record<string, TickerMapping> = {
  // iShares Core S&P 500 UCITS ETF USD (Acc) — LSE GBp
  IE00B5BMR087: {
    symbol: "CSPX.L",
    exchangeMic: "XLON",
    quoteCcy: "USD",
    instrumentType: "EQUITY",
  },
  // iShares Core MSCI World UCITS ETF USD (Acc) — Xetra EUR
  IE00B4L5Y983: {
    symbol: "EUNL.DE",
    exchangeMic: "XETR",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  },
  // iShares MSCI World Small Cap UCITS ETF — Xetra EUR
  IE00BF4RFH31: {
    symbol: "IUSN.DE",
    exchangeMic: "XETR",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  },
  // iShares Core MSCI Europe UCITS ETF EUR (Acc) — Xetra EUR
  IE00B4K48X80: {
    symbol: "SXR7.DE",
    exchangeMic: "XETR",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  },
  // iShares S&P 500 IT Sector — LSE USD
  IE00B3WJKG14: {
    symbol: "IUIT.L",
    exchangeMic: "XLON",
    quoteCcy: "USD",
    instrumentType: "EQUITY",
  },
  // iShares S&P 500 Consumer Discretionary — LSE USD
  IE00B4MCHD36: {
    symbol: "IUCD.L",
    exchangeMic: "XLON",
    quoteCcy: "USD",
    instrumentType: "EQUITY",
  },
  // Vanguard S&P 500 UCITS ETF (USD) Accumulating — Xetra EUR
  IE00BFMXXD54: {
    symbol: "VUAA.DE",
    exchangeMic: "XETR",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  },
  // Vanguard FTSE All-World High Dividend Yield (USD) Distributing — LSE USD
  IE00B8GKDB10: {
    symbol: "VHYL.L",
    exchangeMic: "XLON",
    quoteCcy: "USD",
    instrumentType: "EQUITY",
  },
  // Invesco FTSE All-World High Dividend Acc — Xetra EUR (closest match)
  IE00BK5BR626: {
    symbol: "FUSD.L",
    exchangeMic: "XLON",
    quoteCcy: "USD",
    instrumentType: "EQUITY",
  },
  // Xtrackers MSCI World UCITS ETF 1C — Xetra EUR
  IE00BJ0KDQ92: {
    symbol: "XDWD.DE",
    exchangeMic: "XETR",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  },
  // Xtrackers Russell 2000 UCITS ETF 1C — Xetra EUR
  IE00BJZ2DD79: {
    symbol: "XRS2.DE",
    exchangeMic: "XETR",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  },
  // Amundi MSCI Emerging Markets Swap UCITS ETF EUR Acc — Paris EUR
  LU1681045370: {
    symbol: "AEEM.PA",
    exchangeMic: "XPAR",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  },
  // Amundi MSCI Semiconductors UCITS ETF Acc — Paris EUR
  LU1900066033: {
    symbol: "CHIP.PA",
    exchangeMic: "XPAR",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  },
  // Invesco Physical Gold ETC — LSE USD
  IE00B579F325: {
    symbol: "SGLD.L",
    exchangeMic: "XLON",
    quoteCcy: "USD",
    instrumentType: "EQUITY",
  },
};

// ─── US / CA / EU equities (single-listing tickers) ────────────────────
// Yahoo Finance accepts these without exchange suffix for most cases.
// We omit exchange MIC so Donkeyfolio's symbol-search resolves the
// canonical primary listing (NYSE/NASDAQ/TSX).
const EQUITIES: Record<string, TickerMapping> = {
  // Top US stocks (sorted by frequency in real TR portfolios)
  US70450Y1038: { symbol: "PYPL", quoteCcy: "USD", instrumentType: "EQUITY" }, // PayPal
  US83406F1021: { symbol: "SOFI", quoteCcy: "USD", instrumentType: "EQUITY" }, // SoFi
  US69608A1088: { symbol: "PLTR", quoteCcy: "USD", instrumentType: "EQUITY" }, // Palantir
  US0079031078: { symbol: "AMD", quoteCcy: "USD", instrumentType: "EQUITY" },
  US6541061031: { symbol: "NKE", quoteCcy: "USD", instrumentType: "EQUITY" }, // Nike
  US79466L3024: { symbol: "CRM", quoteCcy: "USD", instrumentType: "EQUITY" }, // Salesforce
  US88160R1014: { symbol: "TSLA", quoteCcy: "USD", instrumentType: "EQUITY" },
  US67066G1040: { symbol: "NVDA", quoteCcy: "USD", instrumentType: "EQUITY" },
  US2935941078: { symbol: "ENVX", quoteCcy: "USD", instrumentType: "EQUITY" }, // Enovix
  US91680M1071: { symbol: "UPST", quoteCcy: "USD", instrumentType: "EQUITY" }, // Upstart
  US0404132054: { symbol: "ANET", quoteCcy: "USD", instrumentType: "EQUITY" }, // Arista
  US81762P1021: { symbol: "NOW", quoteCcy: "USD", instrumentType: "EQUITY" }, // ServiceNow
  US0231351067: { symbol: "AMZN", quoteCcy: "USD", instrumentType: "EQUITY" },
  US24703L2025: { symbol: "DELL", quoteCcy: "USD", instrumentType: "EQUITY" },
  US0378331005: { symbol: "AAPL", quoteCcy: "USD", instrumentType: "EQUITY" },
  US02079K3059: { symbol: "GOOGL", quoteCcy: "USD", instrumentType: "EQUITY" }, // Alphabet A
  US46120E6023: { symbol: "ISRG", quoteCcy: "USD", instrumentType: "EQUITY" }, // Intuitive
  US5949181045: { symbol: "MSFT", quoteCcy: "USD", instrumentType: "EQUITY" },
  US30303M1027: { symbol: "META", quoteCcy: "USD", instrumentType: "EQUITY" },
  US92826C8394: { symbol: "V", quoteCcy: "USD", instrumentType: "EQUITY" }, // Visa
  US00724F1012: { symbol: "ADBE", quoteCcy: "USD", instrumentType: "EQUITY" }, // Adobe
  US6974351057: { symbol: "PANW", quoteCcy: "USD", instrumentType: "EQUITY" }, // Palo Alto
  US88339J1051: { symbol: "TTD", quoteCcy: "USD", instrumentType: "EQUITY" }, // Trade Desk
  CA82509L1076: { symbol: "SHOP", quoteCcy: "USD", instrumentType: "EQUITY" }, // Shopify
  US22788C1053: { symbol: "CRWD", quoteCcy: "USD", instrumentType: "EQUITY" }, // CrowdStrike
  US92840M1027: { symbol: "VST", quoteCcy: "USD", instrumentType: "EQUITY" }, // Vistra
  US11135F1012: { symbol: "AVGO", quoteCcy: "USD", instrumentType: "EQUITY" }, // Broadcom
  US65339F1012: { symbol: "NEE", quoteCcy: "USD", instrumentType: "EQUITY" }, // NextEra
  US4330001060: { symbol: "HIMS", quoteCcy: "USD", instrumentType: "EQUITY" },
  US5951121038: { symbol: "MU", quoteCcy: "USD", instrumentType: "EQUITY" }, // Micron
  US21873S1087: { symbol: "CRWV", quoteCcy: "USD", instrumentType: "EQUITY" }, // CoreWeave
  US9633201069: { symbol: "WHR", quoteCcy: "USD", instrumentType: "EQUITY" }, // Whirlpool
  CA00288U1066: { symbol: "ABCL", quoteCcy: "USD", instrumentType: "EQUITY" }, // AbCellera
  US90364P1057: { symbol: "PATH", quoteCcy: "USD", instrumentType: "EQUITY" }, // UiPath
  US26856L1035: { symbol: "ELF", quoteCcy: "USD", instrumentType: "EQUITY" },
  US0420682058: { symbol: "ARM", quoteCcy: "USD", instrumentType: "EQUITY" },
  US36317J2096: { symbol: "GLXY", quoteCcy: "USD", instrumentType: "EQUITY" }, // Galaxy Digital
  US7811541090: { symbol: "RBRK", quoteCcy: "USD", instrumentType: "EQUITY" }, // Rubrik
  US1273871087: { symbol: "CDNS", quoteCcy: "USD", instrumentType: "EQUITY" }, // Cadence
  US69370C1009: { symbol: "PTC", quoteCcy: "USD", instrumentType: "EQUITY" },
  US36828A1016: { symbol: "GEV", quoteCcy: "USD", instrumentType: "EQUITY" }, // GE Vernova
  US8740391003: { symbol: "TSM", quoteCcy: "USD", instrumentType: "EQUITY" }, // TSMC ADR
  US21037T1097: { symbol: "CEG", quoteCcy: "USD", instrumentType: "EQUITY" }, // Constellation Energy
  NL0009805522: { symbol: "NBIS", quoteCcy: "USD", instrumentType: "EQUITY" }, // Nebius
  US5533681012: { symbol: "MP", quoteCcy: "USD", instrumentType: "EQUITY" }, // MP Materials
  US68389X1054: { symbol: "ORCL", quoteCcy: "USD", instrumentType: "EQUITY" }, // Oracle
  US92686J1060: { symbol: "VKTX", quoteCcy: "USD", instrumentType: "EQUITY" }, // Viking Therapeutics
  US64110L1061: { symbol: "NFLX", quoteCcy: "USD", instrumentType: "EQUITY" },
  US48138M1053: { symbol: "JMIA", quoteCcy: "USD", instrumentType: "EQUITY" }, // Jumia
  US18915M1071: { symbol: "NET", quoteCcy: "USD", instrumentType: "EQUITY" }, // Cloudflare
  US26740W1099: { symbol: "QBTS", quoteCcy: "USD", instrumentType: "EQUITY" }, // D-Wave
  US92537N1081: { symbol: "VRT", quoteCcy: "USD", instrumentType: "EQUITY" }, // Vertiv
  US88023B1035: { symbol: "TEM", quoteCcy: "USD", instrumentType: "EQUITY" }, // Tempus AI
  KYG037AX1015: { symbol: "AMBA", quoteCcy: "USD", instrumentType: "EQUITY" }, // Ambarella
  US0494681010: { symbol: "TEAM", quoteCcy: "USD", instrumentType: "EQUITY" }, // Atlassian
  US0258161092: { symbol: "AXP", quoteCcy: "USD", instrumentType: "EQUITY" }, // Amex
  US3364331070: { symbol: "FSLR", quoteCcy: "USD", instrumentType: "EQUITY" }, // First Solar
  US05464C1018: { symbol: "AXON", quoteCcy: "USD", instrumentType: "EQUITY" },
  US78409V1044: { symbol: "SPGI", quoteCcy: "USD", instrumentType: "EQUITY" }, // S&P Global
  US7707001027: { symbol: "HOOD", quoteCcy: "USD", instrumentType: "EQUITY" }, // Robinhood
  US4592001014: { symbol: "IBM", quoteCcy: "USD", instrumentType: "EQUITY" },
  US03831W1080: { symbol: "APP", quoteCcy: "USD", instrumentType: "EQUITY" }, // AppLovin
  US98980G1022: { symbol: "ZS", quoteCcy: "USD", instrumentType: "EQUITY" }, // Zscaler
  US7223041028: { symbol: "PDD", quoteCcy: "USD", instrumentType: "EQUITY" }, // Pinduoduo
  US89377M1099: { symbol: "TMDX", quoteCcy: "USD", instrumentType: "EQUITY" }, // TransMedics
  US8334451098: { symbol: "SNOW", quoteCcy: "USD", instrumentType: "EQUITY" }, // Snowflake
  US17253J1060: { symbol: "CIFR", quoteCcy: "USD", instrumentType: "EQUITY" }, // Cipher Mining
  US7731221062: { symbol: "RKLB", quoteCcy: "USD", instrumentType: "EQUITY" }, // Rocket Lab
  US7475251036: { symbol: "QCOM", quoteCcy: "USD", instrumentType: "EQUITY" }, // Qualcomm
  US98956A1051: { symbol: "ZETA", quoteCcy: "USD", instrumentType: "EQUITY" },
  CA2926717083: { symbol: "UUUU", quoteCcy: "USD", instrumentType: "EQUITY" }, // Energy Fuels
  US00217D1000: { symbol: "ASTS", quoteCcy: "USD", instrumentType: "EQUITY" }, // AST SpaceMobile
  US23804L1035: { symbol: "DDOG", quoteCcy: "USD", instrumentType: "EQUITY" }, // Datadog
  US0382221051: { symbol: "AMAT", quoteCcy: "USD", instrumentType: "EQUITY" }, // Applied Materials
  US5184391044: { symbol: "EL", quoteCcy: "USD", instrumentType: "EQUITY" }, // Estée Lauder
  KYG6683N1034: { symbol: "NU", quoteCcy: "USD", instrumentType: "EQUITY" }, // Nu Holdings
  US0937121079: { symbol: "BE", quoteCcy: "USD", instrumentType: "EQUITY" }, // Bloom Energy
  US46222L1089: { symbol: "IONQ", quoteCcy: "USD", instrumentType: "EQUITY" },
  CA13321L1085: { symbol: "CCJ", quoteCcy: "USD", instrumentType: "EQUITY" }, // Cameco
  US5738741041: { symbol: "MRVL", quoteCcy: "USD", instrumentType: "EQUITY" }, // Marvell
  US04626A1034: { symbol: "ALAB", quoteCcy: "USD", instrumentType: "EQUITY" }, // Astera Labs
  ZAE000259701: { symbol: "SBSW", quoteCcy: "USD", instrumentType: "EQUITY" }, // Sibanye Stillwater ADR
  US3696043013: { symbol: "GE", quoteCcy: "USD", instrumentType: "EQUITY" }, // GE Aerospace
  US60937P1066: { symbol: "MDB", quoteCcy: "USD", instrumentType: "EQUITY" }, // MongoDB
  US1717793095: { symbol: "CIEN", quoteCcy: "USD", instrumentType: "EQUITY" }, // Ciena
  US50077B2079: { symbol: "KTOS", quoteCcy: "USD", instrumentType: "EQUITY" }, // Kratos
  US0381692070: { symbol: "APLD", quoteCcy: "USD", instrumentType: "EQUITY" }, // Applied Digital
  US4385161066: { symbol: "HON", quoteCcy: "USD", instrumentType: "EQUITY" }, // Honeywell
  KYG017191142: { symbol: "BABA", quoteCcy: "USD", instrumentType: "EQUITY" }, // Alibaba
  AU0000185993: { symbol: "IREN", quoteCcy: "USD", instrumentType: "EQUITY" }, // IREN
  US6877931096: { symbol: "OSCR", quoteCcy: "USD", instrumentType: "EQUITY" }, // Oscar Health
  US1491231015: { symbol: "CAT", quoteCcy: "USD", instrumentType: "EQUITY" }, // Caterpillar
  US08975B1098: { symbol: "BBAI", quoteCcy: "USD", instrumentType: "EQUITY" }, // BigBear.ai
  US63942X1063: { symbol: "NVTS", quoteCcy: "USD", instrumentType: "EQUITY" }, // Navitas
  US12572Q1058: { symbol: "CME", quoteCcy: "USD", instrumentType: "EQUITY" }, // CME Group
  US72703X1063: { symbol: "PL", quoteCcy: "USD", instrumentType: "EQUITY" }, // Planet Labs
  US9168961038: { symbol: "UEC", quoteCcy: "USD", instrumentType: "EQUITY" }, // Uranium Energy
  US15643U1043: { symbol: "LEU", quoteCcy: "USD", instrumentType: "EQUITY" }, // Centrus
  US00846U1016: { symbol: "A", quoteCcy: "USD", instrumentType: "EQUITY" }, // Agilent
  US4581401001: { symbol: "INTC", quoteCcy: "USD", instrumentType: "EQUITY" }, // Intel
  US34379V1035: { symbol: "FLNC", quoteCcy: "USD", instrumentType: "EQUITY" }, // Fluence
  US7739031091: { symbol: "ROK", quoteCcy: "USD", instrumentType: "EQUITY" }, // Rockwell
  US86800U1043: { symbol: "SMCI", quoteCcy: "USD", instrumentType: "EQUITY" }, // Super Micro
  US88080T1043: { symbol: "WULF", quoteCcy: "USD", instrumentType: "EQUITY" }, // TeraWulf
  US4824801009: { symbol: "KLAC", quoteCcy: "USD", instrumentType: "EQUITY" }, // KLA
  US9581021055: { symbol: "WDC", quoteCcy: "USD", instrumentType: "EQUITY" }, // Western Digital
  US46625H1005: { symbol: "JPM", quoteCcy: "USD", instrumentType: "EQUITY" }, // JPMorgan
  US75513E1010: { symbol: "RTX", quoteCcy: "USD", instrumentType: "EQUITY" }, // RTX Corp
  US7134481081: { symbol: "PEP", quoteCcy: "USD", instrumentType: "EQUITY" }, // PepsiCo
  US8807701029: { symbol: "TER", quoteCcy: "USD", instrumentType: "EQUITY" }, // Teradyne
  US68236H2040: { symbol: "ONDS", quoteCcy: "USD", instrumentType: "EQUITY" }, // Ondas
  US75886F1075: { symbol: "REGN", quoteCcy: "USD", instrumentType: "EQUITY" }, // Regeneron
  US05605H1005: { symbol: "BWXT", quoteCcy: "USD", instrumentType: "EQUITY" }, // BWX Tech
  US7731211089: { symbol: "RKLB", quoteCcy: "USD", instrumentType: "EQUITY" }, // Rocket Lab Corp (post-merger)
  US5024311095: { symbol: "LHX", quoteCcy: "USD", instrumentType: "EQUITY" }, // L3Harris
  US5398301094: { symbol: "LMT", quoteCcy: "USD", instrumentType: "EQUITY" }, // Lockheed
  US00760J1088: { symbol: "AEHR", quoteCcy: "USD", instrumentType: "EQUITY" }, // Aehr Test
  US30231G1022: { symbol: "XOM", quoteCcy: "USD", instrumentType: "EQUITY" }, // Exxon
  US0316521006: { symbol: "AMKR", quoteCcy: "USD", instrumentType: "EQUITY" }, // Amkor
  US0080731088: { symbol: "ABNB", quoteCcy: "USD", instrumentType: "EQUITY" }, // Airbnb (US0080731088)
  US25402D1028: { symbol: "DJT", quoteCcy: "USD", instrumentType: "EQUITY" }, // Trump Media
  CA50077N1024: { symbol: "PNG.V", exchangeMic: "XTSE", quoteCcy: "CAD", instrumentType: "EQUITY" }, // Kraken Robotics
  CA26142Q3044: { symbol: "DPRO", quoteCcy: "USD", instrumentType: "EQUITY" }, // Draganfly
  FI0009000681: { symbol: "NOK", quoteCcy: "USD", instrumentType: "EQUITY" }, // Nokia ADR
  IT0003027817: {
    symbol: "IRE.MI",
    exchangeMic: "XMIL",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  }, // Iren
  FR0000121014: { symbol: "MC.PA", exchangeMic: "XPAR", quoteCcy: "EUR", instrumentType: "EQUITY" }, // LVMH
  FR0000121972: { symbol: "SU.PA", exchangeMic: "XPAR", quoteCcy: "EUR", instrumentType: "EQUITY" }, // Schneider
  CH0012221716: {
    symbol: "ABBN.SW",
    exchangeMic: "XSWX",
    quoteCcy: "CHF",
    instrumentType: "EQUITY",
  }, // ABB
  DE0007236101: {
    symbol: "SIE.DE",
    exchangeMic: "XETR",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  }, // Siemens
  DE000ENER6Y0: {
    symbol: "ENR.DE",
    exchangeMic: "XETR",
    quoteCcy: "EUR",
    instrumentType: "EQUITY",
  }, // Siemens Energy
  GB00BMHVL512: { symbol: "KLAR", quoteCcy: "USD", instrumentType: "EQUITY" }, // Klarna
  NL0010273215: { symbol: "ASML", quoteCcy: "USD", instrumentType: "EQUITY" }, // ASML ADR
  DK0015998017: {
    symbol: "BAVA.CO",
    exchangeMic: "XCSE",
    quoteCcy: "DKK",
    instrumentType: "EQUITY",
  }, // Bavarian Nordic
  DK0062498333: { symbol: "NVO", quoteCcy: "USD", instrumentType: "EQUITY" }, // Novo Nordisk ADR
  US58733R1023: { symbol: "MELI", quoteCcy: "USD", instrumentType: "EQUITY" }, // MercadoLibre
  US09175A2069: { symbol: "BMNR", quoteCcy: "USD", instrumentType: "EQUITY" }, // BitMine Immersion
  US5949724083: { symbol: "META", quoteCcy: "USD", instrumentType: "EQUITY" }, // Meta secondary
  US83443Q1031: { symbol: "SOLM", quoteCcy: "USD", instrumentType: "EQUITY" }, // Solstice Advanced Materials
  IE00B4BNMY34: { symbol: "ACN", quoteCcy: "USD", instrumentType: "EQUITY" }, // Accenture (Irish-domiciled, NYSE primary)
};

const ISIN_TO_TICKER: Record<string, TickerMapping> = {
  ...CRYPTO,
  ...ETFS,
  ...EQUITIES,
};

/**
 * Look up a Yahoo-friendly ticker for a Trade Republic ISIN.
 * Returns null if no mapping is known — caller should fall back to the
 * raw ISIN (price won't sync but cost basis still imports correctly).
 */
export function lookupTicker(isin: string): TickerMapping | null {
  return ISIN_TO_TICKER[isin] ?? null;
}
