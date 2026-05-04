import type { AssetResolutionInput, QuoteMode, SymbolSearchResult } from "./types";

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function buildAssetResolutionInput(input: {
  id?: unknown;
  symbol?: unknown;
  exchangeMic?: unknown;
  kind?: unknown;
  name?: unknown;
  quoteMode?: unknown;
  quoteCcy?: unknown;
  instrumentType?: unknown;
}): AssetResolutionInput | undefined {
  const asset: AssetResolutionInput = {
    id: normalizeOptionalString(input.id),
    symbol: normalizeOptionalString(input.symbol),
    exchangeMic: normalizeOptionalString(input.exchangeMic),
    kind: normalizeOptionalString(input.kind),
    name: normalizeOptionalString(input.name),
    quoteMode: normalizeOptionalString(input.quoteMode) as QuoteMode | undefined,
    quoteCcy: normalizeOptionalString(input.quoteCcy),
    instrumentType: normalizeOptionalString(input.instrumentType),
  };

  return Object.values(asset).some((value) => value !== undefined) ? asset : undefined;
}

export function buildAssetResolutionInputFromSearchResult(
  result: SymbolSearchResult,
  symbol: string = result.symbol,
): AssetResolutionInput {
  return {
    id: normalizeOptionalString(result.existingAssetId),
    symbol: normalizeOptionalString(symbol),
    exchangeMic: normalizeOptionalString(result.exchangeMic),
    kind: normalizeOptionalString(result.assetKind),
    name: normalizeOptionalString(result.longName) ?? normalizeOptionalString(result.shortName),
    quoteMode: result.dataSource === "MANUAL" ? "MANUAL" : "MARKET",
    quoteCcy: normalizeOptionalString(result.currency),
    instrumentType: normalizeOptionalString(result.quoteType),
  };
}
