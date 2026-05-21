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

const UNKNOWN_REGION = "Desconhecido";

const COUNTRIES: Record<string, CountryInfo> = {
  // North America
  US: { code: "US", name: "Estados Unidos", flag: "🇺🇸", region: "América do Norte" },
  CA: { code: "CA", name: "Canadá", flag: "🇨🇦", region: "América do Norte" },
  MX: { code: "MX", name: "México", flag: "🇲🇽", region: "América do Norte" },
  // Offshore (typically US-listed)
  KY: {
    code: "KY",
    name: "Ilhas Caimão",
    flag: "🇰🇾",
    region: "América do Norte",
    isOffshore: true,
  },
  BM: { code: "BM", name: "Bermudas", flag: "🇧🇲", region: "América do Norte", isOffshore: true },
  VG: {
    code: "VG",
    name: "Ilhas Virgens Britânicas",
    flag: "🇻🇬",
    region: "América do Norte",
    isOffshore: true,
  },
  PA: { code: "PA", name: "Panamá", flag: "🇵🇦", region: "América do Norte", isOffshore: true },

  // Europe — UCITS umbrellas
  IE: { code: "IE", name: "Irlanda (UCITS ETFs)", flag: "🇮🇪", region: "Europa", isUmbrella: true },
  LU: { code: "LU", name: "Luxemburgo (Funds)", flag: "🇱🇺", region: "Europa", isUmbrella: true },
  JE: { code: "JE", name: "Jersey", flag: "🇯🇪", region: "Europa", isOffshore: true },

  // Europe — operating
  DE: { code: "DE", name: "Alemanha", flag: "🇩🇪", region: "Europa" },
  FR: { code: "FR", name: "França", flag: "🇫🇷", region: "Europa" },
  GB: { code: "GB", name: "Reino Unido", flag: "🇬🇧", region: "Europa" },
  NL: { code: "NL", name: "Holanda", flag: "🇳🇱", region: "Europa" },
  CH: { code: "CH", name: "Suíça", flag: "🇨🇭", region: "Europa" },
  IT: { code: "IT", name: "Itália", flag: "🇮🇹", region: "Europa" },
  ES: { code: "ES", name: "Espanha", flag: "🇪🇸", region: "Europa" },
  PT: { code: "PT", name: "Portugal", flag: "🇵🇹", region: "Europa" },
  BE: { code: "BE", name: "Bélgica", flag: "🇧🇪", region: "Europa" },
  AT: { code: "AT", name: "Áustria", flag: "🇦🇹", region: "Europa" },
  SE: { code: "SE", name: "Suécia", flag: "🇸🇪", region: "Europa" },
  NO: { code: "NO", name: "Noruega", flag: "🇳🇴", region: "Europa" },
  FI: { code: "FI", name: "Finlândia", flag: "🇫🇮", region: "Europa" },
  DK: { code: "DK", name: "Dinamarca", flag: "🇩🇰", region: "Europa" },
  PL: { code: "PL", name: "Polónia", flag: "🇵🇱", region: "Europa" },
  CZ: { code: "CZ", name: "Chéquia", flag: "🇨🇿", region: "Europa" },
  GR: { code: "GR", name: "Grécia", flag: "🇬🇷", region: "Europa" },
  HU: { code: "HU", name: "Hungria", flag: "🇭🇺", region: "Europa" },
  IS: { code: "IS", name: "Islândia", flag: "🇮🇸", region: "Europa" },

  // Asia-Pacific
  JP: { code: "JP", name: "Japão", flag: "🇯🇵", region: "Ásia-Pacífico" },
  CN: { code: "CN", name: "China", flag: "🇨🇳", region: "Ásia-Pacífico" },
  HK: { code: "HK", name: "Hong Kong", flag: "🇭🇰", region: "Ásia-Pacífico" },
  TW: { code: "TW", name: "Taiwan", flag: "🇹🇼", region: "Ásia-Pacífico" },
  KR: { code: "KR", name: "Coreia do Sul", flag: "🇰🇷", region: "Ásia-Pacífico" },
  SG: { code: "SG", name: "Singapura", flag: "🇸🇬", region: "Ásia-Pacífico" },
  IN: { code: "IN", name: "Índia", flag: "🇮🇳", region: "Ásia-Pacífico" },
  AU: { code: "AU", name: "Austrália", flag: "🇦🇺", region: "Ásia-Pacífico" },
  NZ: { code: "NZ", name: "Nova Zelândia", flag: "🇳🇿", region: "Ásia-Pacífico" },
  TH: { code: "TH", name: "Tailândia", flag: "🇹🇭", region: "Ásia-Pacífico" },
  VN: { code: "VN", name: "Vietname", flag: "🇻🇳", region: "Ásia-Pacífico" },
  ID: { code: "ID", name: "Indonésia", flag: "🇮🇩", region: "Ásia-Pacífico" },
  MY: { code: "MY", name: "Malásia", flag: "🇲🇾", region: "Ásia-Pacífico" },
  PH: { code: "PH", name: "Filipinas", flag: "🇵🇭", region: "Ásia-Pacífico" },

  // South America
  BR: { code: "BR", name: "Brasil", flag: "🇧🇷", region: "América do Sul" },
  AR: { code: "AR", name: "Argentina", flag: "🇦🇷", region: "América do Sul" },
  CL: { code: "CL", name: "Chile", flag: "🇨🇱", region: "América do Sul" },
  CO: { code: "CO", name: "Colômbia", flag: "🇨🇴", region: "América do Sul" },
  PE: { code: "PE", name: "Peru", flag: "🇵🇪", region: "América do Sul" },

  // Middle East / Africa
  IL: { code: "IL", name: "Israel", flag: "🇮🇱", region: "Médio Oriente" },
  AE: { code: "AE", name: "Emirados Árabes Unidos", flag: "🇦🇪", region: "Médio Oriente" },
  SA: { code: "SA", name: "Arábia Saudita", flag: "🇸🇦", region: "Médio Oriente" },
  TR: { code: "TR", name: "Turquia", flag: "🇹🇷", region: "Médio Oriente" },
  ZA: { code: "ZA", name: "África do Sul", flag: "🇿🇦", region: "África" },
  EG: { code: "EG", name: "Egito", flag: "🇪🇬", region: "África" },
  NG: { code: "NG", name: "Nigéria", flag: "🇳🇬", region: "África" },
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
    return { code: "??", name: "Desconhecido", flag: "🏳️", region: UNKNOWN_REGION };
  }
  const cc = symbol.slice(0, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) {
    return { code: "??", name: "Desconhecido", flag: "🏳️", region: UNKNOWN_REGION };
  }
  const info = COUNTRIES[cc];
  if (info) return info;
  // Unknown but valid-looking ISO code — use the code itself as name.
  return { code: cc, name: cc, flag: "🏳️", region: UNKNOWN_REGION };
}
