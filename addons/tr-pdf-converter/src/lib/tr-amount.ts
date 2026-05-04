/**
 * Single source of truth for parsing EUR amounts from TR PDFs. (v3.1.1)
 *
 * Why this file exists:
 *   Before v3.1.1 we had 6 different copies of `parseEuroAmount` scattered
 *   across the addon (tr-parser, tr-reconcile, tr-to-activities, tr-multi-pdf,
 *   tr-converter-page, tr-validation-snapshot). Each had drifted slightly:
 *   the v3.0.4 fix for "comma is always decimal in PT" was applied only to
 *   tr-parser.ts, leaving tr-reconcile and tr-to-activities still treating
 *   "89,777" as thousands → producing the €89,777 phantom interest the user
 *   reported. The Cash-flow summary table fed off the buggy versions while
 *   the snapshot tile (a different copy) showed the corrected number, hence
 *   numbers visibly disagreed across panels for the same data.
 *
 *   v3.1.1 consolidates everything here. Every parser site imports
 *   `parseEuroAmount` from this module. Bug found → one place fixes it.
 *
 * Locale detection:
 *   TR ships PDFs in 6 locales. Two number formats:
 *     - "dot-decimal" (PT/EN): "1,234.56" thousands+decimal, "0.384" decimal
 *     - "comma-decimal" (DE/IT/FR/ES): "1.234,56" thousands+decimal, "0,384" decimal
 *
 *   When BOTH separators are present we use the right-most-is-decimal rule
 *   (unambiguous). When only ONE is present we need the locale to decide.
 *   `detectAmountLocale()` infers locale from a corpus of values by counting
 *   "X.YY" vs "X,YY" patterns (2 trailing digits — these are unambiguous).
 *
 * Default locale:
 *   `parseEuroAmount(raw)` without a locale defaults to "dot-decimal" because
 *   (a) most TR PT/EN users land here, (b) the previous heuristic that treated
 *   "X.YYY" with non-zero integer as thousands was the source of the
 *   €89,777-from-€89.78 inflation bug. Defaulting to decimal is safer for the
 *   PT/EN majority and DE PDFs always include a comma somewhere (their
 *   detection trips and they're parsed correctly).
 */

export type AmountLocale = "dot-decimal" | "comma-decimal";

/**
 * Parse-quality telemetry. Counts how many values went through the strict
 * (regex-only, no guessing) path vs the lenient heuristic fallback.
 * High strict-hit ratio = trustworthy numbers. High heuristic ratio
 * = some PDF rows have unusual formatting and need attention.
 *
 * v3.1.4: also capture a sample of the first N heuristic-hit raw strings
 * so we can see WHAT formats are escaping the strict regex without having
 * to guess. Surfaced via the snapshot tile + console log.
 */
const _parseStats = {
  strictHits: 0,
  heuristicHits: 0,
  /** First HEURISTIC_SAMPLE_LIMIT raw strings that failed the strict regex.
   *  Trimmed to avoid blowing memory on a 4000-row cash array. */
  heuristicSamples: [] as string[],
};
const HEURISTIC_SAMPLE_LIMIT = 20;

export function getParseStats(): {
  strictHits: number;
  heuristicHits: number;
  heuristicSamples: string[];
} {
  return {
    strictHits: _parseStats.strictHits,
    heuristicHits: _parseStats.heuristicHits,
    heuristicSamples: [..._parseStats.heuristicSamples],
  };
}
export function resetParseStats(): void {
  _parseStats.strictHits = 0;
  _parseStats.heuristicHits = 0;
  _parseStats.heuristicSamples = [];
}

/**
 * Strict-format regexes per locale. Match the EXACT shape TR emits.
 * Anything that doesn't match is rejected (returns null) rather than
 * being subjected to lossy heuristics. Inspired by TrackRepublic
 * (DE-only `\d{1,3}(?:\.\d{3})*,\d{2}`) but multi-locale.
 *
 * Patterns accept:
 *   - optional minus
 *   - integer part EITHER with thousands separator ("1,234" / "1.234")
 *     OR plain ("1234" / "12345" / "0") — TR omits the separator
 *     for amounts under €10K depending on layout, so we must accept both
 *   - 2 or 3 decimal places (currency precision is 2dp; interest accruals
 *     and share quantities sometimes use 3dp)
 *
 * v3.1.4: relaxed regex to accept no-thousands-separator integers (was
 * the source of the 9% heuristic-hit rate on PT statements where many
 * cash rows write small amounts without commas).
 */
const RE_STRICT_PT_2DP = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/;
const RE_STRICT_PT_3DP = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{3}$/;
const RE_STRICT_DE_2DP = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}$/;
const RE_STRICT_DE_3DP = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{3}$/;

/**
 * Strict parser. Returns the parsed number when the cleaned string EXACTLY
 * matches the expected locale pattern, or null when it doesn't (caller
 * decides: skip, log, or fall back to lenient parse).
 *
 * Eliminates the X.YYY inflation bug by design — there's no heuristic to
 * misfire. Either the format is exactly right, or we refuse to guess.
 */
/**
 * Parse a SHARE QUANTITY (not a currency amount). Quantities have very
 * different precision from money: a single TR row might list "0.129117"
 * shares (6dp) or "11.980687" or pure integers like "3" / "100". They
 * also use ONE separator (the decimal) — thousands separators in qty
 * are virtually unheard of.
 *
 * v3.2.2: Routing share-qty parses here keeps them OUT of the currency
 * parse-quality stats. The "Parse strict %" indicator should only reflect
 * currency parsing (where strict-format matters); quantity parsing is
 * inherently more permissive because TR doesn't emit ambiguous formats
 * for qty.
 */
export function parseQty(
  raw: string | null | undefined,
  locale: AmountLocale = "dot-decimal",
): number {
  if (!raw) return 0;
  const cleaned = String(raw).replace(/[€\s]/g, "").replace(/^\+/, "");
  if (!cleaned) return 0;
  const normalized =
    locale === "comma-decimal"
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

export function parseEuroAmountStrict(
  raw: string | null | undefined,
  locale: AmountLocale,
): number | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[€\s]/g, "").replace(/^\+/, "");
  if (!cleaned) return null;
  if (locale === "comma-decimal") {
    if (RE_STRICT_DE_2DP.test(cleaned) || RE_STRICT_DE_3DP.test(cleaned)) {
      const n = parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
      return Number.isFinite(n) ? n : null;
    }
  } else {
    if (RE_STRICT_PT_2DP.test(cleaned) || RE_STRICT_PT_3DP.test(cleaned)) {
      const n = parseFloat(cleaned.replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/**
 * Infer the dominant locale from a corpus of value strings. Counts
 * unambiguous 2-digit-after-separator patterns and returns whichever wins.
 * Tie or empty corpus → "dot-decimal" (TR PT/EN default).
 */
export function detectAmountLocale(samples: Iterable<string | null | undefined>): AmountLocale {
  let dotDecimal = 0;
  let commaDecimal = 0;
  for (const raw of samples) {
    if (!raw) continue;
    const s = String(raw).replace(/[€\s]/g, "");
    // Match "X,YY" → comma-decimal evidence
    if (/^[\d,]*\d,\d{2}$/.test(s)) commaDecimal += 1;
    // Match "X.YY" → dot-decimal evidence
    if (/^[\d.]*\d\.\d{2}$/.test(s)) dotDecimal += 1;
  }
  return commaDecimal > dotDecimal ? "comma-decimal" : "dot-decimal";
}

/**
 * Format-aware EUR parser. Returns 0 on empty/invalid input — callers should
 * treat 0 as "absent" rather than "zero euros" since both flow through this
 * function the same way.
 *
 * Examples (locale = "dot-decimal", PT/EN):
 *   "€13,862.66" → 13862.66
 *   "0.384"      → 0.384      (decimal — share quantity)
 *   "5.123"      → 5.123      (decimal — NOT 5123, was the bug pre-v3.1.1)
 *   "89,777"     → 89.777     (decimal — v3.0.4 PT 3-decimal fix)
 *   "1.234.567"  → 1234567    (multi-dot can only be thousands)
 *
 * Examples (locale = "comma-decimal", DE):
 *   "€13.862,66" → 13862.66
 *   "0,384"      → 0.384
 *   "5.123"      → 5123       (thousands — DE convention)
 *   "1.234,56"   → 1234.56
 */
export function parseEuroAmount(
  raw: string | null | undefined,
  locale: AmountLocale = "dot-decimal",
): number {
  if (!raw) return 0;
  // (v3.1.2) Try STRICT parse first — covers 99% of TR values cleanly
  // and is immune to the X.YYY heuristic bug by design. Only fall through
  // to lenient heuristics for edge cases (rare formats, sub-cent values,
  // etc.). Counts strict-hit vs heuristic-hit for the UI's parse-quality
  // indicator.
  // (v3.2.1) Try PRIMARY locale first, then the OTHER locale before falling
  // through to heuristics. Some TR PDFs emit a mix — PT body with the page-1
  // SUMMARY block in DE format (TR's internal templating). Per-value
  // dispatching makes both formats parse correctly without us having to
  // choose one over the other.
  const strict = parseEuroAmountStrict(raw, locale);
  if (strict !== null) {
    _parseStats.strictHits += 1;
    return strict;
  }
  const otherLocale: AmountLocale = locale === "dot-decimal" ? "comma-decimal" : "dot-decimal";
  const strictOther = parseEuroAmountStrict(raw, otherLocale);
  if (strictOther !== null) {
    _parseStats.strictHits += 1;
    return strictOther;
  }
  _parseStats.heuristicHits += 1;
  // Capture sample for debugging — see WHAT format escapes the strict regex.
  if (_parseStats.heuristicSamples.length < HEURISTIC_SAMPLE_LIMIT) {
    const sample = String(raw).slice(0, 32);
    if (!_parseStats.heuristicSamples.includes(sample)) {
      _parseStats.heuristicSamples.push(sample);
    }
  }
  const s = String(raw).replace(/[€\s]/g, "");
  if (!s) return 0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let normalized: string = s;

  if (hasComma && hasDot) {
    // Both separators present — the last one is unambiguously the decimal.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      // EU: "1.234,56" → "1234.56"
      normalized = s.replace(/\./g, "").replace(",", ".");
    } else {
      // US: "1,234.56" → "1234.56"
      normalized = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    // Single comma — locale decides.
    if (locale === "comma-decimal") {
      // DE: comma is decimal. "1234,56" → 1234.56.
      normalized = s.replace(",", ".");
    } else {
      // PT/EN: v3.0.4 — TR statements use comma as DECIMAL even with 3
      // digits after ("16,664" = €16.664, "89,777" = €89.78). Older
      // heuristic treated "X,YYY" as thousands and inflated 1000×.
      normalized = s.replace(",", ".");
    }
  } else if (hasDot) {
    // Single dot — locale decides.
    const parts = s.split(".");
    if (parts.length > 2) {
      // "1.234.567" → multiple dots can only be thousands. Locale-independent.
      normalized = s.replace(/\./g, "");
    } else if (locale === "comma-decimal") {
      // DE: dot is THOUSANDS. "5.123" → 5123. But "0.384" stays decimal
      // (share qty). Heuristic: 3 digits after dot AND integer part
      // non-zero → thousands.
      if (parts[1].length === 3 && !/^0+$/.test(parts[0])) {
        normalized = s.replace(/\./g, "");
      }
      // else: leave as decimal — parseFloat handles "0.384".
    } else {
      // PT/EN: dot is DECIMAL. "5.123" → 5.123 (NOT 5123, that was the
      // pre-v3.1.1 bug). "0.384" → 0.384. No transformation needed.
    }
  }

  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}
