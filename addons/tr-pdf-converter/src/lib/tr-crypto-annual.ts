/**
 * TR Crypto Annual Statement parser. (v3.1.0)
 *
 * What this is:
 *   Trade Republic publishes an annual "Crypto Annual Statement" PDF
 *   ("Extrato anual de criptomoedas" in PT) that lists every crypto
 *   trade with full ground-truth: DATE, DIRECTION, ASSETS (qty),
 *   PRICE PER UNIT, FEES (€1.00 explicit), VOLUME.
 *
 *   This solves two long-standing pain points:
 *   1. The regular Account Statement (extrato de conta) lists crypto
 *      "Compra direta" rows WITHOUT qty — we previously skipped them
 *      and asked the user to add manually (since v2.19.7).
 *   2. The €1 fee on crypto BUYs is implicit in the cash leg in the
 *      Account Statement; the Crypto Annual Statement makes it explicit.
 *
 * Format:
 *   Each crypto has its own section header followed by a table:
 *
 *     CARDANO (CARDANO)
 *     DATE          DIRECTION  ASSETS      PRICE PER UNIT  FEES    VOLUME
 *     03.12.2024    BUY        128.198882  €1.17           €1.00   €149.99
 *     07.12.2024    BUY        86.738844   €1.15           €1.00   €99.99
 *     ...
 *
 *     BITCOIN (BITCOIN)
 *     DATE          DIRECTION  ASSETS      PRICE PER UNIT  FEES    VOLUME
 *     11.11.2024    BUY        0.001218    €82,100.65      €1.00   €100.00
 *     ...
 *
 *   Crypto symbols recognised:
 *     CARDANO → ADA, BITCOIN → BTC, ETHEREUM → ETH, SOLANA → SOL,
 *     XRP → XRP, POLKADOT → DOT, DOGECOIN → DOGE, LITECOIN → LTC.
 *
 *   Direction values:
 *     BUY, SELL, RECEIVE (transfer in), SEND (transfer out),
 *     EARN (staking reward).
 *
 * Detection:
 *   The PDF starts with "CRYPTO ANNUAL STATEMENT" or "Extrato anual
 *   de criptomoedas". We detect this and route to this parser instead
 *   of the regular Account Statement parser.
 *
 * Limitations:
 *   - One PDF = one calendar year. To cover multiple years, drop
 *     multiple Crypto Annual Statements alongside.
 *   - TR may add new crypto sections over time; unknown crypto names
 *     are logged but not aborted (we fall through to the fallback
 *     where the symbol equals the section header verbatim).
 */

const CRYPTO_NAME_TO_SYMBOL: Record<string, { symbol: string; pseudoIsin: string }> = {
  CARDANO: { symbol: "ADA-EUR", pseudoIsin: "XF000ADA0018" },
  BITCOIN: { symbol: "BTC-EUR", pseudoIsin: "XF000BTC0017" },
  ETHEREUM: { symbol: "ETH-EUR", pseudoIsin: "XF000ETH0019" },
  SOLANA: { symbol: "SOL-EUR", pseudoIsin: "XF000SOL0012" },
  XRP: { symbol: "XRP-EUR", pseudoIsin: "XF000XRP0018" },
  POLKADOT: { symbol: "DOT-EUR", pseudoIsin: "XF000DOT0010" },
  DOGECOIN: { symbol: "DOGE-EUR", pseudoIsin: "XF000DOGE001" },
  LITECOIN: { symbol: "LTC-EUR", pseudoIsin: "XF000LTC0010" },
};

export interface CryptoAnnualEntry {
  date: string; // dd.mm.yyyy as printed in the PDF
  direction: "BUY" | "SELL" | "RECEIVE" | "SEND" | "EARN";
  /** Crypto qty (e.g. 128.198882). Always positive — direction sets sign. */
  qty: number;
  /** Price per unit in EUR (e.g. 1.17). */
  pricePerUnit: number;
  /** Fee in EUR (e.g. 1.00). */
  fee: number;
  /** Total volume in EUR (e.g. 149.99). Equals qty × price (rounded). */
  volume: number;
  /** Crypto name as printed (CARDANO, BITCOIN, ...). */
  cryptoName: string;
  /** Yahoo-style ticker (ADA-EUR, BTC-EUR, ...) when known, else the
   *  cryptoName lower-cased. Used by the activity builder. */
  symbol: string;
  /** TR pseudo-ISIN (XF000ADA0018, ...) when known. Used to dedupe
   *  against Account Statement crypto rows on import. */
  pseudoIsin?: string;
}

/**
 * Detect whether a PDF text body is a Crypto Annual Statement. Header
 * matching covers the languages TR ships in (EN/DE/PT). Returns false
 * for the regular Account Statement (which has its own detection).
 */
export function isCryptoAnnualStatement(text: string): boolean {
  if (!text) return false;
  // Use a window of the first ~4000 chars to avoid scanning the whole
  // document. The headers always sit on page 1.
  const head = text.slice(0, 4000);
  return (
    /\bCRYPTO\s+ANNUAL\s+STATEMENT\b/i.test(head) ||
    /\bExtrato\s+anual\s+de\s+criptomoedas\b/i.test(head) ||
    /\bKrypto-?Jahressteuerbescheinigung\b/i.test(head) ||
    /\bRelev[ée]?\s+annuel\s+(?:des\s+)?cryptomonnaies\b/i.test(head)
  );
}

/** Parse a single price/fee/volume value (handles "€1,234.56" / "€149.99"). */
function parseEurValue(raw: string): number {
  const s = raw.replace(/[€\s]/g, "");
  if (!s) return 0;
  // The Crypto Annual Statement uses US format throughout (period decimal,
  // comma thousands): €1,234.56 or €149.99 or €82,100.65. So replace
  // all commas as thousands separators.
  const normalized = s.replace(/,/g, "");
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

/** Same for qty values like "128.198882" — always US format, no €. */
function parseQty(raw: string): number {
  const s = raw.replace(/\s/g, "").replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a Crypto Annual Statement PDF text body into structured entries.
 * Walks the text section-by-section: each crypto name header starts a
 * new sub-table, the table header row is skipped, then data rows until
 * the next section header or end-of-document.
 *
 * Resilient to the column-spacing differences we observed across
 * sections (CARDANO uses wider columns, SOLANA narrower) — splits on
 * 2+ whitespace and matches by token POSITION, not absolute offset.
 */
export function parseCryptoAnnualStatement(text: string): CryptoAnnualEntry[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out: CryptoAnnualEntry[] = [];
  let currentName: string | null = null;
  let inTable = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Section header: "CARDANO (CARDANO)" / "BITCOIN (BITCOIN)" / etc.
    // Allow plural names like "POLKADOT (POLKADOT)".
    const sectionMatch = line.match(/^([A-Z][A-Z0-9]*)\s*\(\s*[A-Z0-9]+\s*\)\s*$/);
    if (sectionMatch) {
      currentName = sectionMatch[1];
      inTable = false;
      continue;
    }

    // Table header — skip but flag we're now inside a table for the
    // current section.
    if (/^DATE\s+DIRECTION\s+ASSETS\s+PRICE\s+PER\s+UNIT\s+FEES\s+VOLUME/i.test(line)) {
      inTable = true;
      continue;
    }

    if (!inTable || !currentName) continue;

    // Data row. Examples (variable spacing):
    //   "03.12.2024  BUY   128.198882  €1.17  €1.00  €149.99"
    //   "11.11.2024  BUY   0.001218    €82,100.65  €1.00  €100.00"
    // Tokenize on 2+ spaces (but a 1-space split can also work because
    // none of the values themselves contain a space after we tokenize).
    const tokens = line.split(/\s{2,}|\s+/).filter(Boolean);
    if (tokens.length < 6) continue;

    const dateMatch = tokens[0].match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!dateMatch) continue;
    const direction = tokens[1].toUpperCase();
    if (
      direction !== "BUY" &&
      direction !== "SELL" &&
      direction !== "RECEIVE" &&
      direction !== "SEND" &&
      direction !== "EARN"
    ) {
      continue;
    }
    const qty = parseQty(tokens[2]);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const pricePerUnit = parseEurValue(tokens[3]);
    const fee = parseEurValue(tokens[4]);
    const volume = parseEurValue(tokens[5]);

    const mapping = CRYPTO_NAME_TO_SYMBOL[currentName];
    out.push({
      date: tokens[0],
      direction,
      qty,
      pricePerUnit,
      fee,
      volume,
      cryptoName: currentName,
      symbol: mapping?.symbol ?? currentName.toLowerCase(),
      pseudoIsin: mapping?.pseudoIsin,
    });
  }

  return out;
}
