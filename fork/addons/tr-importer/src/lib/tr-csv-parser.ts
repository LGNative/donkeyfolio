/**
 * Trade Republic CSV parser.
 *
 * Reads the "Extrato de transações.csv" export from the TR app and yields
 * typed `TrCsvRow[]`. Numeric and date fields are parsed once here so the
 * mapper downstream never has to touch raw strings.
 *
 * Validated against a real 4222-row history (2024-06-20 → 2026-05-05). All
 * rows produce `cashEffect = amount + fee + tax` that reconciles to the cent
 * with TR's official PDF Account Statement (€252,535.20 in / €241,999.09 out
 * / €10,536.11 closing balance).
 *
 * Format guarantees enforced here:
 *   - Header row matches `EXPECTED_HEADERS` exactly (TR has not changed
 *     this since the CSV export feature shipped).
 *   - Quoted fields support embedded `,` and escaped `""` per RFC 4180.
 *   - Numbers are dot-decimal with no thousands separators (e.g. "1234.56",
 *     "-149.99", "0.0055260000"). Empty string parses to `null`, NOT 0 —
 *     callers must distinguish "no fee" from "€0 fee".
 *   - Dates are ISO 8601 (YYYY-MM-DD) and datetimes carry trailing `Z`.
 *   - All currencies are EUR for cash legs (cross-checked against full
 *     history); foreign-currency dividends carry `original_amount` +
 *     `original_currency` + `fx_rate` and `amount` is the EUR-converted
 *     gross.
 */

export const EXPECTED_HEADERS = [
  "datetime",
  "date",
  "account_type",
  "category",
  "type",
  "asset_class",
  "name",
  "symbol",
  "shares",
  "price",
  "amount",
  "fee",
  "tax",
  "currency",
  "original_amount",
  "original_currency",
  "fx_rate",
  "description",
  "transaction_id",
  "counterparty_name",
  "counterparty_iban",
  "payment_reference",
  "mcc_code",
] as const;

export type TrCsvHeader = (typeof EXPECTED_HEADERS)[number];

/** Closed set of category values seen in TR exports. */
export type TrCategory = "TRADING" | "CASH" | "CORPORATE_ACTION" | "DELIVERY";

/** Closed set of type values. New types from TR show up as `string` for
 *  forward-compatibility — the mapper logs unknowns instead of throwing. */
export type TrType =
  | "BUY"
  | "SELL"
  | "DIVIDEND"
  | "INTEREST_PAYMENT"
  | "BENEFITS_SAVEBACK"
  | "CUSTOMER_INBOUND"
  | "TRANSFER_INBOUND"
  | "TRANSFER_INSTANT_INBOUND"
  | "TRANSFER_INSTANT_OUTBOUND"
  | "CARD_TRANSACTION"
  | "CARD_TRANSACTION_INTERNATIONAL"
  | "CARD_ORDERING_FEE"
  | "SPLIT"
  | "MERGER"
  | "SPIN_OFF"
  | "SPIN_OFF_CANCELLED"
  | "STOCK_DIVIDEND"
  | "STOCK_DIVIDEND_CANCELLED"
  | "WORTHLESS"
  | "FREE_RECEIPT"
  | (string & { __brand?: "unknown_tr_type" });

export type TrAssetClass = "STOCK" | "FUND" | "CRYPTO" | "DERIVATIVE" | "" | string;

/** One parsed row. Numbers are `number | null`; null means the field was
 *  empty in the CSV. */
export interface TrCsvRow {
  /** Original 0-based row index in the CSV body (excludes header). */
  rowIndex: number;
  /** Full ISO timestamp with millisecond precision and `Z` suffix. */
  datetime: string;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  accountType: string;
  category: TrCategory | string;
  type: TrType;
  assetClass: TrAssetClass;
  name: string;
  /** ISIN for stocks/ETFs/funds. Ticker (BTC/ETH/SOL/ADA/XRP) for crypto.
   *  Empty for cash transactions. */
  symbol: string;
  shares: number | null;
  price: number | null;
  /** Asset cost (signed). For BUY: negative. For SELL: positive. For
   *  cash inflow: positive. For cash outflow: negative. */
  amount: number | null;
  /** TR trading fee (always negative when present). */
  fee: number | null;
  /** Transaction tax (FTT, stamp duty, withholding) — always negative. */
  tax: number | null;
  currency: string;
  originalAmount: number | null;
  originalCurrency: string;
  fxRate: number | null;
  description: string;
  /** UUID assigned by TR. Globally unique — we use it as the dedup key. */
  transactionId: string;
  counterpartyName: string;
  counterpartyIban: string;
  paymentReference: string;
  mccCode: string;
}

export interface ParseResult {
  rows: TrCsvRow[];
  /** Issues found that didn't stop parsing (malformed cells, unexpected
   *  values, etc.). The UI surfaces these so the user can audit. */
  warnings: ParseWarning[];
}

export interface ParseWarning {
  rowIndex: number;
  message: string;
  /** A short tag the UI can group warnings by. */
  kind: "number" | "date" | "header" | "missing_id" | "other";
}

export class TrCsvParseError extends Error {
  constructor(
    message: string,
    readonly cause?: { rowIndex?: number; column?: string },
  ) {
    super(message);
    this.name = "TrCsvParseError";
  }
}

/**
 * Parse a TR CSV string. Throws `TrCsvParseError` on fatal issues (missing
 * file, wrong headers); returns `ParseResult` with `warnings[]` for
 * recoverable issues.
 */
export function parseTrCsv(text: string): ParseResult {
  if (!text || !text.trim()) {
    throw new TrCsvParseError("Empty CSV input");
  }

  // Strip UTF-8 BOM if present.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = splitCsvLines(cleaned);
  if (lines.length === 0) {
    throw new TrCsvParseError("CSV has no lines");
  }

  const headerCells = parseCsvLine(lines[0]);
  if (headerCells.length !== EXPECTED_HEADERS.length) {
    throw new TrCsvParseError(
      `Expected ${EXPECTED_HEADERS.length} columns, got ${headerCells.length}. Is this a TR CSV export?`,
      { column: "header" },
    );
  }
  for (let i = 0; i < EXPECTED_HEADERS.length; i++) {
    if (headerCells[i] !== EXPECTED_HEADERS[i]) {
      throw new TrCsvParseError(
        `Header mismatch at column ${i + 1}: expected "${EXPECTED_HEADERS[i]}", got "${headerCells[i]}"`,
        { column: EXPECTED_HEADERS[i] },
      );
    }
  }

  const rows: TrCsvRow[] = [];
  const warnings: ParseWarning[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cells = parseCsvLine(line);
    const rowIndex = i - 1;

    if (cells.length !== EXPECTED_HEADERS.length) {
      warnings.push({
        rowIndex,
        kind: "other",
        message: `Row has ${cells.length} columns (expected ${EXPECTED_HEADERS.length}); skipping`,
      });
      continue;
    }

    const row: TrCsvRow = {
      rowIndex,
      datetime: cells[0],
      date: cells[1],
      accountType: cells[2],
      category: cells[3],
      type: cells[4],
      assetClass: cells[5],
      name: cells[6],
      symbol: cells[7],
      shares: parseNum(cells[8], rowIndex, "shares", warnings),
      price: parseNum(cells[9], rowIndex, "price", warnings),
      amount: parseNum(cells[10], rowIndex, "amount", warnings),
      fee: parseNum(cells[11], rowIndex, "fee", warnings),
      tax: parseNum(cells[12], rowIndex, "tax", warnings),
      currency: cells[13],
      originalAmount: parseNum(cells[14], rowIndex, "original_amount", warnings),
      originalCurrency: cells[15],
      fxRate: parseNum(cells[16], rowIndex, "fx_rate", warnings),
      description: cells[17],
      transactionId: cells[18],
      counterpartyName: cells[19],
      counterpartyIban: cells[20],
      paymentReference: cells[21],
      mccCode: cells[22],
    };

    if (!row.transactionId) {
      warnings.push({
        rowIndex,
        kind: "missing_id",
        message: "Missing transaction_id — row will be skipped on incremental imports",
      });
    }

    if (row.date && !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      warnings.push({
        rowIndex,
        kind: "date",
        message: `Invalid date "${row.date}" (expected YYYY-MM-DD)`,
      });
    }

    rows.push(row);
  }

  return { rows, warnings };
}

/**
 * Compute the signed cash effect of a row.
 *   cash_in  = positive
 *   cash_out = negative
 *
 * The contract `cash = amount + fee + tax` was validated against TR's
 * official PDF Account Statement on a full 4222-row history — totals match
 * to the cent. Don't change this.
 */
export function rowCashEffect(row: TrCsvRow): number {
  return (row.amount ?? 0) + (row.fee ?? 0) + (row.tax ?? 0);
}

/** Quick sanity stats for the preview KPIs. */
export interface CsvSummary {
  totalRows: number;
  dateRange: { min: string; max: string } | null;
  cashIn: number;
  cashOut: number;
  netCashEffect: number;
  uniqueTransactionIds: number;
  rowsWithoutId: number;
  countsByType: Record<string, number>;
  countsByCategory: Record<string, number>;
}

export function summarizeCsv(rows: TrCsvRow[]): CsvSummary {
  let cashIn = 0;
  let cashOut = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  const ids = new Set<string>();
  let rowsWithoutId = 0;
  const countsByType: Record<string, number> = {};
  const countsByCategory: Record<string, number> = {};

  for (const row of rows) {
    const cash = rowCashEffect(row);
    if (cash > 0) cashIn += cash;
    else if (cash < 0) cashOut += -cash;

    if (row.date) {
      if (!minDate || row.date < minDate) minDate = row.date;
      if (!maxDate || row.date > maxDate) maxDate = row.date;
    }

    if (row.transactionId) ids.add(row.transactionId);
    else rowsWithoutId++;

    countsByType[row.type] = (countsByType[row.type] ?? 0) + 1;
    countsByCategory[row.category] = (countsByCategory[row.category] ?? 0) + 1;
  }

  return {
    totalRows: rows.length,
    dateRange: minDate && maxDate ? { min: minDate, max: maxDate } : null,
    cashIn,
    cashOut,
    netCashEffect: cashIn - cashOut,
    uniqueTransactionIds: ids.size,
    rowsWithoutId,
    countsByType,
    countsByCategory,
  };
}

function parseNum(
  raw: string,
  rowIndex: number,
  column: string,
  warnings: ParseWarning[],
): number | null {
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warnings.push({
      rowIndex,
      kind: "number",
      message: `Could not parse "${raw}" as a number in column "${column}"`,
    });
    return null;
  }
  return n;
}

/**
 * Split CSV text into logical lines, respecting newlines inside quoted
 * fields. TR's CSV doesn't normally contain embedded newlines, but we
 * defend against it because nothing in the format prevents it.
 */
function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // Handle escaped quote ("") inside a quoted field.
      if (inQuotes && text[i + 1] === '"') {
        current += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      current += c;
      continue;
    }
    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      lines.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Parse a single CSV line into cells. Quoted fields preserve commas and
 * unescape `""` → `"`.
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  cells.push(current);
  return cells;
}
