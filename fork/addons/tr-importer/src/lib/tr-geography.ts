/**
 * ISIN → country / region resolver.
 *
 * The first 2 chars of an ISIN are the ISO 3166-1 alpha-2 country code of
 * the registering authority — NOT necessarily where the company operates
 * or trades. Examples:
 *   - US0378331005 (Apple)         → US — registered + operates in US
 *   - IE00B5BMR087 (iShares S&P)   → IE — registered in Ireland (UCITS),
 *                                          tracks US S&P 500
 *   - KYG6683N1034 (Nu Holdings)   → KY — Cayman registered, NYSE listed,
 *                                          Brazilian operations
 *   - DK0062498333 (Novo-Nordisk)  → DK — Danish company
 *
 * For UCITS umbrella jurisdictions (IE/LU) we flag them so the dashboard
 * can call out that the registration country isn't the underlying market.
 *
 * For crypto (no ISIN), we return a synthetic "CRYPTO" entry.
 *
 * No external dependencies, no provider lookups — pure ISO data table.
 */

export interface CountryInfo {
  /** ISO 3166-1 alpha-2 code (or "CRYPTO" for digital assets). */
  code: string;
  /** Display name in Portuguese. */
  name: string;
  /** Emoji flag (or ₿ for crypto). */
  flag: string;
  /** Coarse region for grouping (América do Norte, Europa, Ásia-Pacífico, …). */
  region: string;
  /** True for UCITS / mutual-fund umbrella jurisdictions where the
   *  registration country doesn't reflect the underlying market exposure. */
  isUmbrella?: boolean;
  /** True for offshore registrations of companies that primarily trade on
   *  another market (KY/BMU/JE → usually US-listed). */
  isOffshore?: boolean;
}

const UNKNOWN_REGION = "Unknown";

const COUNTRIES: Record<string, CountryInfo> = {
  // North America
  US: { code: "US", name: "United States", flag: "🇺🇸", region: "North America" },
  CA: { code: "CA", name: "Canada", flag: "🇨🇦", region: "North America" },
  MX: { code: "MX", name: "Mexico", flag: "🇲🇽", region: "North America" },
  // Offshore (typically US-listed)
  KY: {
    code: "KY",
    name: "Cayman Islands",
    flag: "🇰🇾",
    region: "North America",
    isOffshore: true,
  },
  BM: { code: "BM", name: "Bermuda", flag: "🇧🇲", region: "North America", isOffshore: true },
  VG: {
    code: "VG",
    name: "British Virgin Islands",
    flag: "🇻🇬",
    region: "North America",
    isOffshore: true,
  },
  PA: { code: "PA", name: "Panama", flag: "🇵🇦", region: "North America", isOffshore: true },

  // Europe — UCITS umbrellas
  IE: { code: "IE", name: "Ireland (UCITS ETFs)", flag: "🇮🇪", region: "Europe", isUmbrella: true },
  LU: { code: "LU", name: "Luxembourg (Funds)", flag: "🇱🇺", region: "Europe", isUmbrella: true },
  JE: { code: "JE", name: "Jersey", flag: "🇯🇪", region: "Europe", isOffshore: true },

  // Europe — operating
  DE: { code: "DE", name: "Germany", flag: "🇩🇪", region: "Europe" },
  FR: { code: "FR", name: "France", flag: "🇫🇷", region: "Europe" },
  GB: { code: "GB", name: "United Kingdom", flag: "🇬🇧", region: "Europe" },
  NL: { code: "NL", name: "Netherlands", flag: "🇳🇱", region: "Europe" },
  CH: { code: "CH", name: "Switzerland", flag: "🇨🇭", region: "Europe" },
  IT: { code: "IT", name: "Italy", flag: "🇮🇹", region: "Europe" },
  ES: { code: "ES", name: "Spain", flag: "🇪🇸", region: "Europe" },
  PT: { code: "PT", name: "Portugal", flag: "🇵🇹", region: "Europe" },
  BE: { code: "BE", name: "Belgium", flag: "🇧🇪", region: "Europe" },
  AT: { code: "AT", name: "Austria", flag: "🇦🇹", region: "Europe" },
  SE: { code: "SE", name: "Sweden", flag: "🇸🇪", region: "Europe" },
  NO: { code: "NO", name: "Norway", flag: "🇳🇴", region: "Europe" },
  FI: { code: "FI", name: "Finland", flag: "🇫🇮", region: "Europe" },
  DK: { code: "DK", name: "Denmark", flag: "🇩🇰", region: "Europe" },
  PL: { code: "PL", name: "Poland", flag: "🇵🇱", region: "Europe" },
  CZ: { code: "CZ", name: "Czechia", flag: "🇨🇿", region: "Europe" },
  GR: { code: "GR", name: "Greece", flag: "🇬🇷", region: "Europe" },
  HU: { code: "HU", name: "Hungary", flag: "🇭🇺", region: "Europe" },
  IS: { code: "IS", name: "Iceland", flag: "🇮🇸", region: "Europe" },

  // Asia-Pacific
  JP: { code: "JP", name: "Japan", flag: "🇯🇵", region: "Asia-Pacific" },
  CN: { code: "CN", name: "China", flag: "🇨🇳", region: "Asia-Pacific" },
  HK: { code: "HK", name: "Hong Kong", flag: "🇭🇰", region: "Asia-Pacific" },
  TW: { code: "TW", name: "Taiwan", flag: "🇹🇼", region: "Asia-Pacific" },
  KR: { code: "KR", name: "South Korea", flag: "🇰🇷", region: "Asia-Pacific" },
  SG: { code: "SG", name: "Singapore", flag: "🇸🇬", region: "Asia-Pacific" },
  IN: { code: "IN", name: "India", flag: "🇮🇳", region: "Asia-Pacific" },
  AU: { code: "AU", name: "Australia", flag: "🇦🇺", region: "Asia-Pacific" },
  NZ: { code: "NZ", name: "New Zealand", flag: "🇳🇿", region: "Asia-Pacific" },
  TH: { code: "TH", name: "Thailand", flag: "🇹🇭", region: "Asia-Pacific" },
  VN: { code: "VN", name: "Vietnam", flag: "🇻🇳", region: "Asia-Pacific" },
  ID: { code: "ID", name: "Indonesia", flag: "🇮🇩", region: "Asia-Pacific" },
  MY: { code: "MY", name: "Malaysia", flag: "🇲🇾", region: "Asia-Pacific" },
  PH: { code: "PH", name: "Philippines", flag: "🇵🇭", region: "Asia-Pacific" },

  // South America
  BR: { code: "BR", name: "Brazil", flag: "🇧🇷", region: "South America" },
  AR: { code: "AR", name: "Argentina", flag: "🇦🇷", region: "South America" },
  CL: { code: "CL", name: "Chile", flag: "🇨🇱", region: "South America" },
  CO: { code: "CO", name: "Colombia", flag: "🇨🇴", region: "South America" },
  PE: { code: "PE", name: "Peru", flag: "🇵🇪", region: "South America" },

  // Middle East / Africa
  IL: { code: "IL", name: "Israel", flag: "🇮🇱", region: "Middle East" },
  AE: { code: "AE", name: "United Arab Emirates", flag: "🇦🇪", region: "Middle East" },
  SA: { code: "SA", name: "Saudi Arabia", flag: "🇸🇦", region: "Middle East" },
  TR: { code: "TR", name: "Turkey", flag: "🇹🇷", region: "Middle East" },
  ZA: { code: "ZA", name: "South Africa", flag: "🇿🇦", region: "Africa" },
  EG: { code: "EG", name: "Egypt", flag: "🇪🇬", region: "Africa" },
  NG: { code: "NG", name: "Nigeria", flag: "🇳🇬", region: "Africa" },
};

const CRYPTO_INFO: CountryInfo = {
  code: "CRYPTO",
  name: "Crypto",
  flag: "₿",
  region: "Decentralized",
};

/**
 * Look up the country info for a TR CSV row's symbol + asset class.
 * Falls back to a placeholder for unrecognized country codes.
 */
export function resolveCountry(symbol: string, assetClass: string): CountryInfo {
  if (assetClass === "CRYPTO") return CRYPTO_INFO;
  if (!symbol || symbol.length < 2) {
    return { code: "??", name: "Unknown", flag: "🏳️", region: UNKNOWN_REGION };
  }
  const cc = symbol.slice(0, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) {
    return { code: "??", name: "Unknown", flag: "🏳️", region: UNKNOWN_REGION };
  }
  const info = COUNTRIES[cc];
  if (info) return info;
  // Unknown but valid-looking ISO code — use the code itself as name.
  return { code: cc, name: cc, flag: "🏳️", region: UNKNOWN_REGION };
}
