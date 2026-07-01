import { HoldingType } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import { formatAmount } from "@/lib/utils";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useMemo } from "react";

/**
 * Donkeyfolio fork card: cost-weighted return % per instrument type
 * (Stocks / ETFs / Crypto) plus a Cash line. Rendered directly under the
 * Accounts card on the initial dashboard so it reads like a per-type drill-down
 * of the account ("as if sub-accounts"). Groups by the existing Instrument Type
 * taxonomy (holding.instrument.classifications.assetType) — no extra tagging.
 */
interface GainByTypeCardProps {
  holdings?: Holding[];
  baseCurrency: string;
  isLoading?: boolean;
}

// Raw taxonomy category name -> display label + fixed display order.
const TYPE_META: { key: string; label: string }[] = [
  { key: "Stock", label: "Stocks" },
  { key: "ETF", label: "ETFs" },
  { key: "Cryptocurrency", label: "Crypto" },
];

export function GainByTypeCard({ holdings, baseCurrency, isLoading }: GainByTypeCardProps) {
  const { rows, cash } = useMemo(() => {
    const acc = new Map<string, { value: number; cost: number; gain: number }>();
    let cash = 0;

    for (const h of holdings ?? []) {
      const valueBase = h.marketValue?.base ?? 0;
      if (h.holdingType === HoldingType.CASH) {
        cash += valueBase;
        continue;
      }
      const type = h.instrument?.classifications?.assetType?.name ?? "Other";
      const costBase = h.costBasis?.base ?? 0;
      const gainBase = h.unrealizedGain?.base ?? h.totalGain?.base ?? valueBase - costBase;
      const g = acc.get(type) ?? { value: 0, cost: 0, gain: 0 };
      g.value += valueBase;
      g.cost += costBase;
      g.gain += gainBase;
      acc.set(type, g);
    }

    const toRow = (label: string, g: { value: number; cost: number; gain: number }) => ({
      label,
      value: g.value,
      gainPct: g.cost > 0 ? g.gain / g.cost : null,
    });

    const known = TYPE_META.filter((m) => acc.has(m.key)).map((m) =>
      toRow(m.label, acc.get(m.key)!),
    );
    const others = [...acc.entries()]
      .filter(([k]) => !TYPE_META.some((m) => m.key === k))
      .map(([k, g]) => toRow(k, g));

    return { rows: [...known, ...others], cash };
  }, [holdings]);

  return (
    <div className="border-border/40 bg-card/90 shadow-xs rounded-xl border px-4 py-3 backdrop-blur-xl md:px-5 md:py-4">
      <div className="text-muted-foreground mb-3 text-xs font-medium uppercase tracking-wide">
        By type
      </div>
      {isLoading ? (
        <div className="space-y-2.5">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{r.label}</span>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground text-sm tabular-nums">
                  {formatAmount(r.value, baseCurrency)}
                </span>
                {r.gainPct == null ? (
                  <span className="text-muted-foreground w-20 text-right text-sm">N/A</span>
                ) : (
                  <span
                    className={`w-20 text-right text-sm font-medium tabular-nums ${
                      r.gainPct >= 0 ? "text-success" : "text-destructive"
                    }`}
                  >
                    {r.gainPct >= 0 ? "+" : ""}
                    {(r.gainPct * 100).toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          ))}
          {cash > 0 && (
            <div className="border-border/40 flex items-center justify-between gap-3 border-t pt-3">
              <span className="text-sm font-medium">Cash</span>
              <span className="text-muted-foreground text-sm tabular-nums">
                {formatAmount(cash, baseCurrency)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
