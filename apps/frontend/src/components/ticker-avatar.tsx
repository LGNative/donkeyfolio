import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { Avatar, AvatarFallback, AvatarImage } from "@wealthfolio/ui";

interface TickerAvatarProps {
  symbol: string;
  className?: string;
  imageClassName?: string;
}

const CASH_AVATAR_LABELS: Record<string, string> = {
  USD: "$",
  CAD: "C$",
  AUD: "A$",
  NZD: "NZ$",
};

const CASH_SYMBOL_PATTERN = /^\$?CASH[-_:]([A-Z]{3})$/;

const getCashAvatarLabel = (symbol: string): string | null => {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === "$CASH" || normalized === "CASH") return "$";

  const currency = CASH_SYMBOL_PATTERN.exec(normalized)?.[1];
  if (!currency) return null;

  return CASH_AVATAR_LABELS[currency] ?? currency;
};

const getFallbackAvatarLabel = (symbol: string): string => symbol.slice(0, 4);

// ── One uniform DARK chip; dark logos are whitened to read on it ────────────
// Every logo sits on the SAME dark chip (uniform, not a patchwork of tiles).
// White and colourful logos read on it as-is; the ones that would vanish are
// dark marks (a navy DELL, the GE Vernova monogram, a black wordmark). For
// THOSE we whiten the logo to a light silhouette (measured per-logo from pixel
// luminance) so it reads on the dark chip — the chip itself never changes.
const CHIP_BG = "hsl(40 6% 28%)"; // the one uniform chip
const CHIP_TEXT = "hsl(45 14% 92%)"; // initials on the chip
const DARK_LOGO_MAX_LUMINANCE = 0.45; // avg luminance ≤ this → whiten the logo

interface LogoStats {
  lum: number; // average luminance of opaque pixels, 0..1
}

// Per-URL cache; null = measured but unreadable (couldn't sample pixels).
const LOGO_STATS_CACHE = new Map<string, LogoStats | null>();

function measureLogo(url: string): Promise<LogoStats | null> {
  return new Promise((resolve) => {
    if (LOGO_STATS_CACHE.has(url)) return resolve(LOGO_STATS_CACHE.get(url) ?? null);
    if (typeof document === "undefined") return resolve(null);

    const img = new Image();
    img.onload = () => {
      let stats: LogoStats | null = null;
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0, size, size);
          const { data } = ctx.getImageData(0, 0, size, size);
          let lumSum = 0;
          let count = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 24) continue; // skip (near-)transparent pixels
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            count += 1;
          }
          if (count > 0) stats = { lum: lumSum / count };
        }
      } catch {
        stats = null;
      }
      LOGO_STATS_CACHE.set(url, stats);
      resolve(stats);
    };
    img.onerror = () => {
      LOGO_STATS_CACHE.set(url, null);
      resolve(null);
    };
    img.src = url;
  });
}

export const TickerAvatar = ({
  symbol,
  className = "size-8",
  imageClassName = "object-contain p-2",
}: TickerAvatarProps) => {
  // For OCC option symbols (e.g. "AAPL250321C00150000"), use the underlying ticker for logo
  const parsed = symbol ? parseOccSymbol(symbol) : null;
  const logoSymbol = parsed ? parsed.underlying : symbol;

  // Extract the base symbol (before any dot, hyphen, or colon) for fallback
  const baseSymbol = logoSymbol ? logoSymbol.split(/[.:-]/)[0].toUpperCase() : "";
  const fullSymbol = logoSymbol ? logoSymbol.toUpperCase() : "";

  // Try full symbol first, then fallback to base symbol
  const primaryLogoUrl = fullSymbol ? `/ticker-logos/${fullSymbol}.png` : "";
  const fallbackLogoUrl = baseSymbol ? `/ticker-logos/${baseSymbol}.png` : "";
  const cashAvatarLabel = getCashAvatarLabel(fullSymbol);
  const fallbackAvatarLabel = baseSymbol ? getFallbackAvatarLabel(baseSymbol) : "•";
  const [logoUrl, setLogoUrl] = useState(primaryLogoUrl);

  useEffect(() => {
    setLogoUrl(primaryLogoUrl);
  }, [primaryLogoUrl]);

  // Measure the current logo's luminance so we can pick a contrasting chip.
  const [stats, setStats] = useState<LogoStats | null>(
    () => LOGO_STATS_CACHE.get(primaryLogoUrl) ?? null,
  );
  useEffect(() => {
    if (!logoUrl) {
      setStats(null);
      return;
    }
    if (LOGO_STATS_CACHE.has(logoUrl)) {
      setStats(LOGO_STATS_CACHE.get(logoUrl) ?? null);
      return;
    }
    let active = true;
    measureLogo(logoUrl).then((value) => {
      if (active) setStats(value);
    });
    return () => {
      active = false;
    };
  }, [logoUrl]);

  const whitenLogo = stats != null && stats.lum <= DARK_LOGO_MAX_LUMINANCE;

  if (cashAvatarLabel) {
    return (
      <Avatar className={cn("border-border font-semibold backdrop-blur-md", className)}>
        <AvatarFallback
          className="text-xs font-semibold"
          style={{ backgroundColor: CHIP_BG, color: CHIP_TEXT }}
        >
          <span className="p-1" title={fullSymbol}>
            {cashAvatarLabel}
          </span>
        </AvatarFallback>
      </Avatar>
    );
  }

  return (
    <Avatar
      className={cn("border-border backdrop-blur-md", className)}
      style={{ backgroundColor: CHIP_BG }}
    >
      <AvatarImage
        src={logoUrl}
        alt={fullSymbol}
        className={imageClassName}
        style={whitenLogo ? { filter: "brightness(0) invert(1)" } : undefined}
        onLoadingStatusChange={(status) => {
          if (
            status === "error" &&
            logoUrl === primaryLogoUrl &&
            fallbackLogoUrl !== primaryLogoUrl
          ) {
            setLogoUrl(fallbackLogoUrl);
          }
        }}
      />
      <AvatarFallback
        className="font-medium"
        style={{ backgroundColor: CHIP_BG, color: CHIP_TEXT }}
      >
        <span
          className={cn(
            "px-0.5 leading-none",
            fallbackAvatarLabel.length >= 4 ? "text-[10px]" : "text-xs",
          )}
          title={fullSymbol}
        >
          {fallbackAvatarLabel}
        </span>
      </AvatarFallback>
    </Avatar>
  );
};
