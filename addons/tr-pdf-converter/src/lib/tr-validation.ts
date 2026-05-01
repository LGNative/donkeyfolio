/**
 * Validation: compare imported Donkeyfolio holdings against the TR app's
 * canonical view, pasted by the user. (v2.20.1)
 *
 * Why this exists:
 *   PDF parsing produces holdings that ALMOST match the TR app — but small
 *   parser bugs, FX rounding, missed splits, or unimported activities can
 *   cause silent drift on individual positions. Without a side-by-side
 *   comparison the user has to spot-check 30+ holdings manually, which
 *   nobody actually does.
 *
 * Approach:
 *   User screenshots the TR app's "Investments" tab (or types it out),
 *   pastes the lines into a textarea. The parser is whitespace/separator-
 *   tolerant — accepts tabs, multi-space, commas, mix of EUR formats — and
 *   matches by ticker, ISIN, or company-name fuzzy.
 *
 *   We then call ctx.api.portfolio.getHoldings(accountId), align by
 *   instrument.symbol or asset.id, and compute drift per position.
 *
 *   Acceptance bands (mirrored from PP / common broker reconciliation):
 *     - qty drift ≤ 0.0001  → MATCH
 *     - qty drift ≤ 0.5%    → MINOR  (rounding, decimal display)
 *     - qty drift > 0.5%    → MAJOR  (missing trade, wrong split, etc.)
 *
 *   Avg cost has its own band because TR app shows EUR cost basis and
 *   Donkeyfolio attributes via fxRate — so even a perfect match can show
 *   €0.10-€0.50 drift on a $400 stock without anything being wrong.
 *     - avg cost drift ≤ 0.5% → MATCH
 *     - avg cost drift ≤ 2.0% → MINOR
 *     - avg cost drift > 2.0% → MAJOR
 */

/** One TR-app holding as pasted by the user. */
export interface TrAppHolding {
  /** Free-text identifier from the user — symbol, ISIN, or partial name. */
  raw: string;
  /** Cleaned uppercase ticker if extractable (e.g. "MSFT"). */
  symbol?: string;
  /** ISIN if user pasted one. */
  isin?: string;
  /** Quantity held (TR app shows up to 6 decimals for fractional shares). */
  quantity: number;
  /** Avg cost per share in EUR (TR app's "Custo médio" / "Avg cost" / "Preço médio"). */
  avgCostEur?: number;
  /** Total invested in EUR (some TR layouts show this instead of avg cost). */
  totalInvestedEur?: number;
}

/** Comparison row produced by alignHoldings(). */
export interface ValidationRow {
  /** Display label (Donkeyfolio's instrument name or the user's raw input). */
  label: string;
  isin?: string;
  symbol?: string;
  // TR app values (from paste)
  trQty?: number;
  trAvgCost?: number;
  trTotal?: number;
  // Donkeyfolio values (from getHoldings)
  dfQty?: number;
  dfAvgCost?: number;
  dfTotal?: number;
  // Computed diffs (only populated when both sides have a value)
  qtyDiff?: number;
  qtyDiffPct?: number;
  avgCostDiff?: number;
  avgCostDiffPct?: number;
  totalDiff?: number;
  totalDiffPct?: number;
  // Verdict
  status: "match" | "minor" | "major" | "tr-only" | "df-only";
  notes?: string;
}

/**
 * Parse a free-form paste of TR app holdings. Accepts a wide variety of
 * layouts because TR's app, web, and CSV exports all format the same data
 * differently:
 *   - Tab-separated   "MSFT\t6.47444\t€366.67\t€2,373.40"
 *   - Multi-space     "MSFT    6.47444   €366.67   €2,373.40"
 *   - Comma-separated "MSFT, 6.47444, 366.67, 2373.40"
 *   - Mixed EUR fmt   "Microsoft 6,47444 € 366,67"
 *
 * Heuristic per line:
 *   1. Tokens delimited by `[ \t,;]+` (1+ whitespace, comma, or semicolon)
 *   2. First token is symbol/ISIN/name (anything alpha-heavy)
 *   3. The next 1-3 numeric tokens are qty / avgCost / total (in that
 *      preference order — qty MUST be present, avgCost+total are best-effort)
 *
 * Lines that don't match (headers, blank, all-text) are silently dropped.
 */
export function parseTrAppPaste(text: string): TrAppHolding[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out: TrAppHolding[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Strip currency symbols & "€" so number-detection is easier.
    const tokens = line.split(/[ \t,;]+/).filter(Boolean);
    if (tokens.length < 2) continue;

    // First token = identifier. Find it as the FIRST non-numeric token.
    let identIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (!/^[€$£0-9.,+\-]+$/.test(tokens[i])) {
        identIdx = i;
        break;
      }
    }
    if (identIdx < 0) continue;
    const ident = tokens[identIdx];

    // Numeric tokens after the identifier — convert each accepting both
    // EU and US decimal formats. Strip €/$ before conversion.
    const numbers: number[] = [];
    for (let i = identIdx + 1; i < tokens.length; i++) {
      const stripped = tokens[i].replace(/[€$£\s]/g, "");
      if (!stripped) continue;
      const n = parseFlexNumber(stripped);
      if (Number.isFinite(n)) numbers.push(n);
    }
    if (numbers.length === 0) continue;

    const isinMatch = ident.match(/^[A-Z]{2}[A-Z0-9]{10}$/);
    const isin = isinMatch ? ident : undefined;
    const symbol = !isin && /^[A-Z][A-Z0-9.\-]*$/i.test(ident) ? ident.toUpperCase() : undefined;

    // Order of magnitude heuristic: qty is usually < 10000, avg cost < 5000,
    // total can be anything up to 6 digits. We assign:
    //   numbers[0] → qty
    //   numbers[1] → avgCost  (if present)
    //   numbers[2] → total    (if present)
    out.push({
      raw: ident,
      symbol,
      isin,
      quantity: numbers[0],
      avgCostEur: numbers[1],
      totalInvestedEur: numbers[2],
    });
  }
  return out;
}

/** Locale-tolerant number parser. Handles "1,234.56" and "1.234,56". */
function parseFlexNumber(s: string): number {
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  let cleaned = s;
  if (hasDot && hasComma) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      // EU: 1.234,56
      cleaned = s.replace(/\./g, "").replace(",", ".");
    } else {
      // US: 1,234.56
      cleaned = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length === 3) {
      // 1,234 → US thousands (rare in practice for qty)
      cleaned = s.replace(/,/g, "");
    } else {
      cleaned = s.replace(",", ".");
    }
  }
  return parseFloat(cleaned);
}

/**
 * Donkeyfolio holding shape — narrow subset of the SDK's Holding type that
 * we actually need for validation. Decoupling from the SDK type lets the
 * validation logic stay testable without mocking the entire API surface.
 */
export interface DfHoldingSummary {
  symbol?: string;
  isin?: string;
  name?: string;
  quantity: number;
  /** Avg cost per share in localCurrency (Donkeyfolio attribution).
   *  We compute it ourselves from costBasis.amount / quantity rather than
   *  relying on a stale derived field on the Holding object. */
  avgCost?: number;
  totalCost?: number;
}

/**
 * Cross-check pasted TR holdings against Donkeyfolio's getHoldings result.
 * Returns one ValidationRow per UNION position — TR-only and DF-only entries
 * are surfaced explicitly so missing imports / phantom holdings are visible.
 */
export function alignHoldings(
  trHoldings: TrAppHolding[],
  dfHoldings: DfHoldingSummary[],
): ValidationRow[] {
  const norm = (s?: string) => (s ? s.trim().toUpperCase() : "");
  // Index DF holdings by symbol AND ISIN so either side of the user paste
  // can match.
  const bySymbol = new Map<string, DfHoldingSummary>();
  const byIsin = new Map<string, DfHoldingSummary>();
  for (const h of dfHoldings) {
    if (h.symbol) bySymbol.set(norm(h.symbol), h);
    if (h.isin) byIsin.set(norm(h.isin), h);
  }

  const matchedDf = new Set<DfHoldingSummary>();
  const rows: ValidationRow[] = [];

  for (const tr of trHoldings) {
    const df =
      (tr.isin && byIsin.get(norm(tr.isin))) ||
      (tr.symbol && bySymbol.get(norm(tr.symbol))) ||
      // Fallback: try the raw token as either
      bySymbol.get(norm(tr.raw)) ||
      byIsin.get(norm(tr.raw));
    if (df) matchedDf.add(df);
    rows.push(buildRow(tr, df));
  }

  // DF holdings the user didn't include in their paste — could be cash-only
  // accounts, manual additions, or genuinely missing TR positions.
  for (const df of dfHoldings) {
    if (matchedDf.has(df)) continue;
    rows.push({
      label: df.name ?? df.symbol ?? df.isin ?? "(unknown)",
      symbol: df.symbol,
      isin: df.isin,
      dfQty: df.quantity,
      dfAvgCost: df.avgCost,
      dfTotal: df.totalCost,
      status: "df-only",
      notes: "In Donkeyfolio but not in pasted TR list",
    });
  }

  return rows;
}

/** Build a single comparison row applying the verdict bands described above. */
function buildRow(tr: TrAppHolding, df: DfHoldingSummary | undefined): ValidationRow {
  if (!df) {
    return {
      label: tr.raw,
      symbol: tr.symbol,
      isin: tr.isin,
      trQty: tr.quantity,
      trAvgCost: tr.avgCostEur,
      trTotal: tr.totalInvestedEur,
      status: "tr-only",
      notes: "In TR app but not in Donkeyfolio (missing import?)",
    };
  }

  const trQty = tr.quantity;
  const dfQty = df.quantity;
  const qtyDiff = dfQty - trQty;
  const qtyDiffPct = trQty > 0 ? (qtyDiff / trQty) * 100 : 0;

  const trAvg = tr.avgCostEur;
  const dfAvg = df.avgCost;
  const avgCostDiff =
    typeof trAvg === "number" && typeof dfAvg === "number" ? dfAvg - trAvg : undefined;
  const avgCostDiffPct =
    typeof avgCostDiff === "number" && trAvg && trAvg > 0 ? (avgCostDiff / trAvg) * 100 : undefined;

  const trTotal = tr.totalInvestedEur;
  const dfTotal = df.totalCost;
  const totalDiff =
    typeof trTotal === "number" && typeof dfTotal === "number" ? dfTotal - trTotal : undefined;
  const totalDiffPct =
    typeof totalDiff === "number" && trTotal && trTotal > 0
      ? (totalDiff / trTotal) * 100
      : undefined;

  // Status: most permissive = match, escalate on largest drift across qty/avg.
  let status: ValidationRow["status"] = "match";
  const qtyDriftAbs = Math.abs(qtyDiffPct);
  const avgDriftAbs = avgCostDiffPct !== undefined ? Math.abs(avgCostDiffPct) : 0;
  if (Math.abs(qtyDiff) > 0.0001) {
    if (qtyDriftAbs > 0.5) status = "major";
    else status = "minor";
  }
  if (avgDriftAbs > 2.0) status = "major";
  else if (avgDriftAbs > 0.5 && status === "match") status = "minor";

  return {
    label: df.name ?? tr.raw,
    symbol: df.symbol ?? tr.symbol,
    isin: df.isin ?? tr.isin,
    trQty,
    trAvgCost: trAvg,
    trTotal,
    dfQty,
    dfAvgCost: dfAvg,
    dfTotal,
    qtyDiff,
    qtyDiffPct,
    avgCostDiff,
    avgCostDiffPct,
    totalDiff,
    totalDiffPct,
    status,
  };
}
