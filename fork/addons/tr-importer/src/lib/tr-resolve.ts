/**
 * Dynamic ISIN → EUR-listing resolver.
 *
 * Replaces the hand-maintained ISIN→ticker table. For each ISIN we ask the
 * app's OWN market-data providers (Yahoo + OpenFIGI, via
 * `ctx.api.market.searchTicker`) for every listing, then prefer the
 * EUR-denominated one (Xetra / Frankfurt / Tradegate). The asset becomes
 * natively EUR — matching Trade Republic — so its daily history flows in EUR
 * from Börse Frankfurt / Yahoo `.DE` with no FX guesswork.
 *
 * Design constraints (per project owner):
 *   - No hardcoded per-asset mappings — the providers decide.
 *   - No base-code changes — we only call the documented SDK host API.
 *   - Crypto is handled upstream by the mapper (assetClass === "CRYPTO");
 *     TR crypto pseudo-ISINs (XF000…) are excluded here.
 */
import type { AddonContext, SymbolSearchResult } from "@wealthfolio/addon-sdk";
import { lookupTicker } from "./tr-isin-tickers";
import { isValidIsin } from "./tr-isin-utils";

export interface ResolvedAsset {
  /** Canonical symbol to persist (e.g. "EUNL.DE"). */
  symbol: string;
  /** Resolved exchange MIC, when the provider gives one. */
  exchangeMic?: string;
  /** Quote currency derived from the chosen exchange (EUR when an EUR listing exists). */
  quoteCcy?: string;
  /** Friendly name from the provider (longName → shortName). */
  name?: string;
}

/**
 * Strict ISO-6166 validation (country code + NSIN + Luhn check digit). The
 * loose `/[A-Z]{2}[A-Z0-9]{10}/` shape matched plain words like "SUBSCRIPTION"
 * and minted a fake, unpriceable asset; the check digit rules those out.
 * Excludes Trade Republic crypto pseudo-ISINs (XF000…) — resolved by the mapper.
 */
export function looksLikeIsin(s: string): boolean {
  return isValidIsin(s) && !s.startsWith("XF");
}

function isEur(r: SymbolSearchResult): boolean {
  return (r.currency ?? "").toUpperCase() === "EUR";
}

/**
 * Within the EUR listings, prefer Xetra (deepest EUR history on Yahoo/BF),
 * then Frankfurt, then anything else. Derived from the symbol suffix / MIC —
 * not a per-asset table.
 */
function eurVenueRank(r: SymbolSearchResult): number {
  const mic = (r.exchangeMic ?? "").toUpperCase();
  const sym = (r.symbol ?? "").toUpperCase();
  if (mic === "XETR" || sym.endsWith(".DE")) return 0; // Xetra
  if (mic === "XFRA" || mic === "FRA" || sym.endsWith(".F")) return 1; // Frankfurt
  return 2; // some other EUR venue
}

/** Pick the best listing: EUR first (best German venue, then score), else best score. */
function pick(results: SymbolSearchResult[]): SymbolSearchResult | null {
  if (!results.length) return null;
  const eur = results.filter(isEur);
  const pool = eur.length ? eur : results;
  const sorted = [...pool].sort((a, b) => {
    if (eur.length) {
      const dv = eurVenueRank(a) - eurVenueRank(b);
      if (dv !== 0) return dv;
    }
    return (b.score ?? 0) - (a.score ?? 0);
  });
  return sorted[0];
}

function toResolved(r: SymbolSearchResult): ResolvedAsset {
  return {
    symbol: r.symbol,
    exchangeMic: r.exchangeMic,
    quoteCcy: r.currency,
    name: r.longName || r.shortName || undefined,
  };
}

const CONCURRENCY = 5;

/**
 * Resolve a set of ISINs to their preferred (EUR-first) listing via the app's
 * own provider search. Returns a map keyed by the input ISIN. ISINs that
 * resolve to nothing are simply absent — the caller keeps its ISIN-as-symbol
 * fallback. Per-ISIN errors are swallowed (best-effort) and logged.
 */
export async function resolveIsins(
  ctx: AddonContext,
  isins: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, ResolvedAsset>> {
  // Only resolve ISINs the curated table does NOT already cover — those are
  // handled (table-first) by the mapper, so searching them here is wasted work.
  const unique = [...new Set(isins.filter((s) => looksLikeIsin(s) && !lookupTicker(s)))];
  const out = new Map<string, ResolvedAsset>();
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < unique.length) {
      const isin = unique[cursor++];
      try {
        const results = await ctx.api.market.searchTicker(isin);
        const chosen = pick(results ?? []);
        if (chosen) out.set(isin, toResolved(chosen));
      } catch (e) {
        ctx.api.logger.warn(`[TR resolve] ${isin}: ${(e as Error).message}`);
      } finally {
        onProgress?.(++done, unique.length);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, () => worker()));
  return out;
}
