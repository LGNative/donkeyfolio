/**
 * Monthly cashflow aggregator. (v3.2.0)
 *
 * Why this exists:
 *   The user wants the Track Republic visual: 5 big cards at the top
 *   (IN · OUT · INVESTED · NET · CASH BALANCE) plus a monthly trend chart
 *   showing In / Out / Invested as bars per month. We already have all the
 *   inputs after parsePDF — this module just rolls them up into the shape
 *   the UI cards / chart components want.
 *
 * Bucket semantics (consistent with tr-validation-snapshot's classifyCash):
 *   IN       = deposits + interest + earnings + rewards + refunds
 *              (everything that reaches the cash balance from external sources
 *              EXCLUDING internal transfers between TR sub-accounts)
 *   OUT      = withdrawals + taxes + fees
 *              (cash leaving the account to external destinations)
 *   INVESTED = trade outflows minus trade inflows (net invested into securities)
 *              When SELLs > BUYs in a month, INVESTED goes negative
 *              (i.e. net divested that month).
 *   NET      = IN − OUT − INVESTED — the user's net cash position change
 *              after all activity that month
 *
 * Internal transfers are excluded by design — moving €1K from Cash to Save &
 * Invest is not income or expense, just a re-shelving. Counting either side
 * would double-count.
 */

import type { CashTransaction, TradingTransaction } from "./tr-parser";
import { parseEuroAmount as parseEuroAmountShared } from "./tr-amount";
import { getDetectedLocale } from "./tr-parser";

export interface MonthlyBucket {
  /** YYYY-MM (e.g. "2024-06"). */
  month: string;
  /** Money in: deposits, interest, earnings, rewards, refunds. */
  in: number;
  /** Money out: withdrawals, taxes, external fees. */
  out: number;
  /** Net invested (BUYs minus SELLs cash). Negative when more was sold than bought. */
  invested: number;
  /** Internal transfer volume (excluded from in/out, tracked for reference). */
  internalTransfers: number;
  /** = in − out − invested */
  net: number;
}

export interface CashflowSummary {
  /** Total IN over the entire period. */
  totalIn: number;
  /** Total OUT. */
  totalOut: number;
  /** Total invested net. */
  totalInvested: number;
  /** Net = totalIn − totalOut − totalInvested. */
  totalNet: number;
  /** Last reported saldo (the user's current balance per the PDF). */
  cashBalance: number;
  /** Per-month buckets sorted chronologically. */
  monthly: MonthlyBucket[];
  /** Average per month (over months with any activity). */
  avgMonthIn: number;
  avgMonthOut: number;
  avgMonthInvested: number;
  avgMonthNet: number;
}

/** Convert a date string (any common TR format) to YYYY-MM. */
function toMonth(raw: string): string | null {
  if (!raw) return null;
  // Already ISO YYYY-MM-DD
  let m = raw.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (m) return `${m[1]}-${m[2]}`;
  // DD.MM.YYYY or DD/MM/YYYY
  m = raw.match(/^\d{1,2}[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[2]}-${m[1].padStart(2, "0")}`;
  // DD MMM YYYY
  m = raw.match(/^\d{1,2}\s+([A-Za-zÀ-ÿ]{3,})\.?\s+(\d{4})/);
  if (m) {
    const months: Record<string, string> = {
      jan: "01",
      fev: "02",
      feb: "02",
      mar: "03",
      mär: "03",
      abr: "04",
      apr: "04",
      mai: "05",
      may: "05",
      jun: "06",
      giu: "06",
      jul: "07",
      lug: "07",
      ago: "08",
      aug: "08",
      set: "09",
      sep: "09",
      out: "10",
      okt: "10",
      oct: "10",
      nov: "11",
      dez: "12",
      dec: "12",
      dic: "12",
    };
    const mm = months[m[1].toLowerCase().slice(0, 3)];
    if (mm) return `${m[2]}-${mm}`;
  }
  return null;
}

/** Bucket type → in/out/internal. Mirrors classifyCash but coarser. */
function bucketize(typ: string, desc: string): "in" | "out" | "internal" | null {
  const t = typ.toLowerCase();
  const d = desc.toLowerCase();

  // Internal first — beats generic transfer/deposit
  if (
    t.includes("internal") ||
    d.includes("save & invest") ||
    d.includes("save and invest") ||
    d.includes("rebalance") ||
    d.includes("transferência interna") ||
    d.includes("transferencia interna")
  )
    return "internal";

  // IN: deposits, interest, earnings, rewards, refunds
  if (
    t.includes("deposit") ||
    t.includes("transfer") ||
    t.includes("eingang") ||
    t.includes("entrada") ||
    t.includes("ingreso") ||
    t.includes("dépôt") ||
    t.includes("versement") ||
    t.includes("interest") ||
    t.includes("zins") ||
    t.includes("juros") ||
    t.includes("intereses") ||
    t.includes("interessi") ||
    t.includes("intéret") ||
    t.includes("intéres") ||
    t.includes("earning") ||
    t.includes("rendiment") ||
    t.includes("ertrag") ||
    t.includes("staking") ||
    t.includes("reward") ||
    t.includes("bonus") ||
    t.includes("recompens") ||
    t.includes("premio") ||
    t.includes("empfehlung") ||
    t.includes("referral") ||
    t.includes("refund") ||
    t.includes("cashback") ||
    t.includes("saveback") ||
    t.includes("reembols") ||
    t.includes("erstattung")
  )
    return "in";

  // OUT: withdrawals, taxes, card transactions, external fees
  if (
    t.includes("withdraw") ||
    t.includes("auszahlung") ||
    t.includes("retirada") ||
    t.includes("retrait") ||
    t.includes("prelievo") ||
    t.includes("levantament") ||
    t.includes("tax") ||
    t.includes("steuer") ||
    t.includes("imposto") ||
    t.includes("impuesto") ||
    t.includes("imposta") ||
    t.includes("card") ||
    t.includes("kartentransaktion") ||
    t.includes("transazione") ||
    t.includes("sepa") ||
    t.includes("fee") ||
    t.includes("gebühr")
  )
    return "out";

  return null;
}

/**
 * Build the monthly cashflow summary from parsed cash + trades. Pure
 * function, deterministic.
 */
export function buildMonthlyCashflow(
  cash: CashTransaction[],
  trades: TradingTransaction[],
  endingBalance: number | null = null,
): CashflowSummary {
  const monthMap = new Map<string, MonthlyBucket>();
  const locale = getDetectedLocale();

  const ensureMonth = (month: string): MonthlyBucket => {
    let b = monthMap.get(month);
    if (!b) {
      b = { month, in: 0, out: 0, invested: 0, internalTransfers: 0, net: 0 };
      monthMap.set(month, b);
    }
    return b;
  };

  // ─── Cash rows → in / out / internal ───────────────────────────────
  for (const c of cash) {
    const month = toMonth(c.datum);
    if (!month) continue;
    const inAmt = parseEuroAmountShared(c.zahlungseingang, locale);
    const outAmt = parseEuroAmountShared(c.zahlungsausgang, locale);
    const bucket = bucketize(c.typ, c.beschreibung);
    if (!bucket) continue;
    const b = ensureMonth(month);
    if (bucket === "internal") {
      b.internalTransfers += inAmt || outAmt;
    } else if (bucket === "in") {
      b.in += inAmt;
    } else if (bucket === "out") {
      b.out += outAmt;
    }
  }

  // ─── Trades → invested (net BUY - SELL per month) ──────────────────
  for (const t of trades) {
    const month = toMonth(t.date);
    if (!month) continue;
    const cashFlow = Math.abs(t.amount);
    const b = ensureMonth(month);
    if (t.isBuy) b.invested += cashFlow;
    else b.invested -= cashFlow;
  }

  // ─── Net + finalize ────────────────────────────────────────────────
  const monthly = Array.from(monthMap.values()).map((b) => ({
    ...b,
    in: round2(b.in),
    out: round2(b.out),
    invested: round2(b.invested),
    internalTransfers: round2(b.internalTransfers),
    net: round2(b.in - b.out - b.invested),
  }));
  monthly.sort((a, b) => (a.month < b.month ? -1 : 1));

  const totalIn = monthly.reduce((s, m) => s + m.in, 0);
  const totalOut = monthly.reduce((s, m) => s + m.out, 0);
  const totalInvested = monthly.reduce((s, m) => s + m.invested, 0);
  const totalNet = totalIn - totalOut - totalInvested;
  const activeMonths = monthly.length || 1;

  return {
    totalIn: round2(totalIn),
    totalOut: round2(totalOut),
    totalInvested: round2(totalInvested),
    totalNet: round2(totalNet),
    cashBalance: endingBalance !== null ? round2(endingBalance) : 0,
    monthly,
    avgMonthIn: round2(totalIn / activeMonths),
    avgMonthOut: round2(totalOut / activeMonths),
    avgMonthInvested: round2(totalInvested / activeMonths),
    avgMonthNet: round2(totalNet / activeMonths),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
