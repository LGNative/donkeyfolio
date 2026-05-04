/**
 * Cashflow panel — Track Republic-style header cards + monthly trend. (v3.2.0)
 *
 * Layout:
 *   ┌────────────┬────────────┬────────────┬────────────┬────────────┐
 *   │ IN         │ OUT        │ INVESTED   │ NET        │ CASH BAL.  │
 *   │ €54,698    │ €29,945    │ €7,540     │ +€17,213   │ €25,413    │
 *   │ All data   │ All data   │ All data   │ All data   │ As of …    │
 *   └────────────┴────────────┴────────────┴────────────┴────────────┘
 *
 *   ┌──── Trend (last N months) ─────────────────────────────────────┐
 *   │ ▌▌    ▌▌    ▌▌    ▌▌    ▌▌                                     │
 *   │ ▌▌    ▌▌    ▌▌    ▌▌    ▌▌    ← In (blue)                      │
 *   │ ▌▌█   ▌▌█   ▌▌█   ▌▌█   ▌▌█   ← Out (purple)                   │
 *   │ ▌▌█▎  ▌▌█▎  ▌▌█▎  ▌▌█▎  ▌▌█▎  ← Invested (orange)              │
 *   │  Jun   Jul   Aug   Sep   Oct                                    │
 *   │ Net: +€1.8K  +€1.3K  +€1.6K  +€1.1K  +€1.6K                    │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Pure CSS bars — no chart library dependency. Bar heights normalized
 * against the largest single-bucket value so the chart stays readable
 * across orders of magnitude.
 */
import * as React from "react";
import { Card } from "@wealthfolio/ui";
import type { CashflowSummary } from "../lib/tr-monthly-cashflow";

interface CashflowPanelProps {
  summary: CashflowSummary;
  /** Period label like "All data" / "Last 12 months". */
  periodLabel?: string;
}

function fmtEur(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-PT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtEurSigned(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${fmtEur(n)}`;
}

function fmtMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  const months = [
    "Jan",
    "Fev",
    "Mar",
    "Abr",
    "Mai",
    "Jun",
    "Jul",
    "Ago",
    "Set",
    "Out",
    "Nov",
    "Dez",
  ];
  const idx = parseInt(m, 10) - 1;
  if (idx < 0 || idx > 11) return yyyymm;
  return `${months[idx]} ${y.slice(2)}`;
}

interface MetricCardProps {
  label: string;
  value: string;
  sublabel?: string;
  /** Tailwind text colour class for the value. */
  colorClass: string;
  /** Tailwind background colour class for the icon area. */
  iconBgClass?: string;
}

function MetricCard({ label, value, sublabel, colorClass }: MetricCardProps) {
  return (
    <Card className="bg-card/40 flex-1 border p-3">
      <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase tracking-wider">
        {label}
      </div>
      <div className={`font-mono text-2xl font-bold ${colorClass}`}>{value}</div>
      {sublabel && <div className="text-muted-foreground mt-1 text-[10px]">{sublabel}</div>}
    </Card>
  );
}

export default function CashflowPanel({ summary, periodLabel = "All data" }: CashflowPanelProps) {
  // Show last 12 months only in the trend chart (avoids clutter on long
  // statements). Cards always reflect the full period.
  const recentMonths = summary.monthly.slice(-12);
  const maxAbs = Math.max(...recentMonths.flatMap((m) => [m.in, m.out, Math.abs(m.invested)]), 1);

  return (
    <div className="space-y-3">
      {/* ─── 5 metric cards ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <MetricCard
          label="IN"
          value={fmtEur(summary.totalIn)}
          sublabel={periodLabel}
          colorClass="text-blue-600 dark:text-blue-400"
        />
        <MetricCard
          label="OUT"
          value={fmtEur(summary.totalOut)}
          sublabel={periodLabel}
          colorClass="text-fuchsia-600 dark:text-fuchsia-400"
        />
        <MetricCard
          label="INVESTED"
          value={fmtEur(summary.totalInvested)}
          sublabel={periodLabel}
          colorClass="text-amber-600 dark:text-amber-400"
        />
        <MetricCard
          label="NET"
          value={fmtEurSigned(summary.totalNet)}
          sublabel={periodLabel}
          colorClass={
            summary.totalNet >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
          }
        />
        <MetricCard
          label="CASH BALANCE"
          value={fmtEur(summary.cashBalance)}
          sublabel={`As of last cash row`}
          colorClass="text-foreground"
        />
      </div>

      {/* ─── Monthly trend ─────────────────────────────────────────── */}
      {recentMonths.length > 0 && (
        <Card className="p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <div>
              <div className="text-sm font-semibold">Trend</div>
              <div className="text-muted-foreground text-xs">
                Last {recentMonths.length} {recentMonths.length === 1 ? "month" : "months"}
              </div>
            </div>
            <div className="flex gap-3 text-[10px]">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-blue-500" /> In
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-fuchsia-500" /> Out
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" /> Invested
              </span>
            </div>
          </div>

          {/* Bars row */}
          <div
            className="grid items-end gap-1"
            style={{
              gridTemplateColumns: `repeat(${recentMonths.length}, minmax(0, 1fr))`,
              height: "180px",
            }}
          >
            {recentMonths.map((m) => {
              const inH = (m.in / maxAbs) * 100;
              const outH = (m.out / maxAbs) * 100;
              const invH = (Math.abs(m.invested) / maxAbs) * 100;
              return (
                <div key={m.month} className="flex h-full items-end gap-0.5">
                  <div
                    className="flex-1 rounded-t bg-blue-500/80"
                    style={{ height: `${Math.max(inH, 1)}%` }}
                    title={`In: ${fmtEur(m.in)}`}
                  />
                  <div
                    className="flex-1 rounded-t bg-fuchsia-500/80"
                    style={{ height: `${Math.max(outH, 1)}%` }}
                    title={`Out: ${fmtEur(m.out)}`}
                  />
                  <div
                    className={`flex-1 rounded-t ${
                      m.invested >= 0 ? "bg-amber-500/80" : "bg-amber-500/40"
                    }`}
                    style={{ height: `${Math.max(invH, 1)}%` }}
                    title={`${m.invested >= 0 ? "Invested" : "Divested"}: ${fmtEur(Math.abs(m.invested))}`}
                  />
                </div>
              );
            })}
          </div>

          {/* Month labels */}
          <div
            className="text-muted-foreground mt-1 grid gap-1 text-center text-[10px]"
            style={{ gridTemplateColumns: `repeat(${recentMonths.length}, minmax(0, 1fr))` }}
          >
            {recentMonths.map((m) => (
              <div key={m.month}>{fmtMonth(m.month)}</div>
            ))}
          </div>

          {/* Net per month */}
          <div
            className="mt-2 grid gap-1 text-center font-mono text-[10px]"
            style={{ gridTemplateColumns: `repeat(${recentMonths.length}, minmax(0, 1fr))` }}
          >
            {recentMonths.map((m) => (
              <div
                key={m.month}
                className={
                  m.net >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400"
                }
              >
                {fmtEurSigned(m.net)}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ─── Average per month strip ────────────────────────────────── */}
      <div className="bg-muted/20 rounded-md border p-3">
        <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase tracking-wider">
          Average / month ({summary.monthly.length}{" "}
          {summary.monthly.length === 1 ? "month" : "months"} active)
        </div>
        <div className="grid grid-cols-2 gap-2 font-mono text-xs md:grid-cols-4">
          <div>
            <span className="text-muted-foreground">In: </span>
            <span className="text-blue-600 dark:text-blue-400">{fmtEur(summary.avgMonthIn)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Out: </span>
            <span className="text-fuchsia-600 dark:text-fuchsia-400">
              {fmtEur(summary.avgMonthOut)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Invested: </span>
            <span className="text-amber-600 dark:text-amber-400">
              {fmtEur(summary.avgMonthInvested)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Net: </span>
            <span
              className={
                summary.avgMonthNet >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }
            >
              {fmtEurSigned(summary.avgMonthNet)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
