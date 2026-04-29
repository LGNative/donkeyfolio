/**
 * ISIN validation helpers. (v2.10.1)
 *
 * The bare regex `/\b[A-Z]{2}[A-Z0-9]{10}\b/` is way too permissive — the
 * literal English word "SUBSCRIPTION" is 12 chars of A-Z and matches it,
 * which on real user data created a fake asset with ticker SUBSCRIPTION
 * (Yahoo couldn't price it → "No data found" Data Health alert).
 *
 * Real ISINs (ISO 6166):
 *   - 2-letter ISO 3166 country code
 *   - 9 alphanumeric (A-Z + 0-9) NSIN
 *   - 1 numeric check digit, computed via Luhn-mod-10 over the
 *     alphabetic-expanded string (A=10, B=11, ..., Z=35)
 *
 * The check digit alone catches almost every false positive (English words
 * very rarely end in a digit). The Luhn check is the belt-and-braces.
 */

export function isValidIsin(s: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s)) return false;
  let expanded = "";
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") expanded += ch;
    else expanded += String(ch.charCodeAt(0) - 55);
  }
  let sum = 0;
  let dbl = false;
  for (let i = expanded.length - 1; i >= 0; i--) {
    let d = expanded.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Extract the first valid ISIN from a freeform string, or undefined. */
export function extractIsin(text: string): string | undefined {
  const candidates = text.match(/\b[A-Z][A-Z][A-Z0-9]{10}\b/g);
  if (!candidates) return undefined;
  for (const c of candidates) {
    if (isValidIsin(c)) return c;
  }
  return undefined;
}
