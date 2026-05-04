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
