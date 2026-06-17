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

// ── One uniform DARK tile; dark logos inverted to read on it ────────────────
// Every logo sits on the SAME dark chip in light AND dark mode (uniform look,
// not a patchwork of circles). On a dark chip, white/light and colourful logos
// read naturally; the ones that vanish are dark/black near-monochrome marks —
// so for THOSE we invert the logo (black → white). Coloured logos keep their
// real colours (we only invert near-monochrome ones).
const CHIP_BG = "hsl(40 6% 28%)";
const CHIP_TEXT = "hsl(45 14% 92%)";
const INVERT_MAX_LUMINANCE = 0.52; // logo this dark or darker is a candidate
const INVERT_MAX_SATURATION = 0.18; // …but only if near-monochrome (not a colour logo)

interface LogoStats {
  lum: number; // average luminance of opaque pixels, 0..1
  sat: number; // average (max-min)/255 saturation of opaque pixels, 0..1
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
          let satSum = 0;
          let count = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 24) continue; // skip (near-)transparent pixels
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            satSum += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
            count += 1;
          }
          if (count > 0) stats = { lum: lumSum / count, sat: satSum / count };
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

  // Measure the current logo so we can invert light, near-monochrome marks.
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

  const invertLogo =
    stats != null && stats.lum <= INVERT_MAX_LUMINANCE && stats.sat < INVERT_MAX_SATURATION;

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
        style={invertLogo ? { filter: "invert(1)" } : undefined}
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
