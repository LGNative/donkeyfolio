/**
 * Crypto Holdings Reconciliation Panel (v2.17.0).
 *
 * After parsing the PDF, this panel surfaces every crypto holding detected
 * from cash trades (XF000* ISINs) and lets the user reconcile against what
 * the TR app actually shows. The two unknowns the PDF can't capture are:
 *
 *   1. Staking rewards — TR pays them as additional crypto, not cash, so
 *      they never appear in the cash-only Account Statement.
 *   2. "Compra direta" qty imprecision — those rows have cash but no qty
 *      in the description, so we resolve via daily-close prices which
 *      drift a few percent from TR's intraday execution prices.
 *
 * The panel asks for two numbers per crypto:
 *   - "TR app qty"          : the exact quantity TR currently shows
 *   - "Cumulative staking €" : total fair-value of staking received (only
 *                              shown for assets where TR offers staking)
 *
 * On Apply, the parent page emits two kinds of synthetic activities:
 *   - INTEREST/Staking Reward for the staking portion (qty + cost basis)
 *   - TRANSFER_IN/TR_QTY_RECONCILE for the residual qty diff (cost basis
 *     defaulted to the asset's cash-buy avg price so realized gains stay
 *     accurate on later sells)
 *
 * Cryptos where TR offers staking on EUR accounts (verified Apr 2026):
 *   SOL, ETH, ADA, DOT, MATIC, AVAX, ATOM
 * BTC and XRP are NOT on the staking whitelist — for those, the panel only
 * asks for the TR qty (any diff is pure price-imprecision).
 */
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import React from "react";

import { CRYPTO_PSEUDO_TO_YAHOO } from "../lib/tr-crypto-resolver";
import type { TradingTransaction } from "../lib/tr-parser";

// Cryptos for which TR offers staking on the EUR account. If a crypto isn't
// on this list the panel hides the staking input — qty diff is then assumed
// to be pure price-imprecision and emitted as a TRANSFER_IN top-up.
const TR_STAKING_WHITELIST = new Set(["SOL", "ETH", "ADA", "DOT", "MATIC", "AVAX", "ATOM"]);

export interface CryptoReconcileEntry {
  isin: string;
  symbol: string; // e.g. "SOL-EUR"
  symbolName: string; // e.g. "Solana"
  computedQty: number; // qty derived from cash trades only
  computedCost: number; // total cash spent on cash buys
  trQty?: number; // user input
  stakingQty?: number; // user input (only for staking-supported cryptos)
  stakingValueEur?: number; // user input (only for staking-supported cryptos)
  hasStaking: boolean; // whether the panel should show the staking input
}

export function buildCryptoReconcileEntries(trading: TradingTransaction[]): CryptoReconcileEntry[] {
  const byIsin = new Map<string, { qty: number; cost: number; name: string }>();
  for (const tx of trading) {
    if (!tx.isin || !tx.isin.startsWith("XF000")) continue;
    const existing = byIsin.get(tx.isin) ?? {
      qty: 0,
      cost: 0,
      name: tx.cleanStockName || tx.stockName || "",
    };
    const qty = tx.quantity ?? 0;
    if (tx.isBuy) {
      existing.qty += qty;
      existing.cost += Math.abs(tx.amount);
    } else {
      existing.qty -= qty;
      existing.cost -= Math.abs(tx.amount); // approx — proper FIFO done elsewhere
    }
    if (!existing.name && (tx.cleanStockName || tx.stockName)) {
      existing.name = tx.cleanStockName || tx.stockName || "";
    }
    byIsin.set(tx.isin, existing);
  }

  const entries: CryptoReconcileEntry[] = [];
  for (const [isin, agg] of byIsin) {
    if (agg.qty <= 0) continue;
    const yahoo = CRYPTO_PSEUDO_TO_YAHOO[isin] ?? "";
    const tickerCode = yahoo.split("-")[0]; // BTC-EUR → BTC
    const hasStaking = TR_STAKING_WHITELIST.has(tickerCode);
    entries.push({
      isin,
      symbol: yahoo || isin,
      symbolName: agg.name || tickerCode,
      computedQty: agg.qty,
      computedCost: agg.cost,
      hasStaking,
    });
  }
  // Stable order: cryptos with staking first (more user attention), then alpha by symbol.
  entries.sort((a, b) => {
    if (a.hasStaking !== b.hasStaking) return a.hasStaking ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
  return entries;
}

/**
 * (v2.18.0) Manual holding entry for assets the PDF doesn't capture
 * (spin-offs, gifts, inherited shares, etc.). Emitted as TRANSFER_IN with
 * the supplied cost basis.
 */
export interface ManualHoldingDraft {
  symbol: string;
  isin: string;
  name: string;
  quantity: string; // raw input — parsed at apply
  costBasisEur: string;
  date: string; // YYYY-MM-DD
  source: string; // free text e.g. "Spin-off from HON"
}

interface CryptoReconcilePanelProps {
  entries: CryptoReconcileEntry[];
  manualHoldings: ManualHoldingDraft[];
  onApply: (updated: CryptoReconcileEntry[], manualHoldings: ManualHoldingDraft[]) => void;
  onSkip: () => void;
  applied: boolean;
  defaultDate: string; // last activity date — used as fallback in the Add modal
}

function formatQty(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatEur(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  });
}

function emptyManualDraft(date: string): ManualHoldingDraft {
  return { symbol: "", isin: "", name: "", quantity: "", costBasisEur: "", date, source: "" };
}

export default function CryptoReconcilePanel({
  entries,
  manualHoldings,
  onApply,
  onSkip,
  applied,
  defaultDate,
}: CryptoReconcilePanelProps) {
  const [editable, setEditable] = React.useState<CryptoReconcileEntry[]>(entries);
  const [drafts, setDrafts] = React.useState<ManualHoldingDraft[]>(manualHoldings);
  const [showAdd, setShowAdd] = React.useState(false);
  const [newDraft, setNewDraft] = React.useState<ManualHoldingDraft>(emptyManualDraft(defaultDate));

  React.useEffect(() => {
    setEditable(entries);
  }, [entries]);
  React.useEffect(() => {
    setDrafts(manualHoldings);
  }, [manualHoldings]);
  React.useEffect(() => {
    setNewDraft((d) => ({ ...d, date: d.date || defaultDate }));
  }, [defaultDate]);

  if (entries.length === 0 && drafts.length === 0) {
    // Still surface the panel — user might want to add a spin-off / gift even
    // when no crypto is in the PDF.
  }

  const update = (idx: number, patch: Partial<CryptoReconcileEntry>) => {
    setEditable((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };

  const parseInputNumber = (raw: string): number | undefined => {
    const cleaned = raw.replace(/\s/g, "").replace(",", ".");
    if (!cleaned) return undefined;
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : undefined;
  };

  const totalStaking = editable.reduce((sum, e) => sum + (e.stakingValueEur ?? 0), 0);
  const hasAnyInput =
    editable.some((e) => e.trQty !== undefined || e.stakingValueEur !== undefined) ||
    drafts.length > 0;

  const newDraftValid =
    newDraft.symbol.trim() !== "" &&
    parseInputNumber(newDraft.quantity) !== undefined &&
    parseInputNumber(newDraft.costBasisEur) !== undefined;

  const commitDraft = () => {
    if (!newDraftValid) return;
    setDrafts((prev) => [...prev, newDraft]);
    setNewDraft(emptyManualDraft(defaultDate));
    setShowAdd(false);
  };

  const removeDraft = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icons.Coins className="h-4 w-4" />
          Crypto Holdings Reconciliation
          {applied ? (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
              <Icons.CheckCircle className="h-3 w-3" /> applied
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>
          Enter the actual quantity TR app shows for each crypto, and (where applicable) the
          cumulative staking reward value. The addon will emit synthetic{" "}
          <code>INTEREST/Staking Reward</code> and <code>TRANSFER_IN</code> activities so your
          imported holdings match TR exactly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Crypto</TableHead>
              <TableHead className="text-right">PDF computed qty</TableHead>
              <TableHead className="text-right">TR app qty</TableHead>
              <TableHead className="text-right">Staking qty</TableHead>
              <TableHead className="text-right">Staking €</TableHead>
              <TableHead className="text-right">Implied diff</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {editable.map((e, idx) => {
              const qtyDiff = e.trQty !== undefined ? e.trQty - e.computedQty : undefined;
              return (
                <TableRow key={e.isin}>
                  <TableCell>
                    <div className="font-medium">
                      {e.symbol}
                      {e.hasStaking ? (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                          stakeable
                        </span>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground text-xs">{e.symbolName}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(e.computedQty)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder={formatQty(e.computedQty)}
                      defaultValue={e.trQty !== undefined ? String(e.trQty) : ""}
                      onChange={(ev) =>
                        update(idx, {
                          trQty: parseInputNumber(ev.currentTarget.value),
                        })
                      }
                      className="h-8 w-32 text-right tabular-nums"
                      disabled={applied}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {e.hasStaking ? (
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.000"
                        defaultValue={e.stakingQty !== undefined ? String(e.stakingQty) : ""}
                        onChange={(ev) =>
                          update(idx, {
                            stakingQty: parseInputNumber(ev.currentTarget.value),
                          })
                        }
                        className="h-8 w-24 text-right tabular-nums"
                        disabled={applied}
                      />
                    ) : (
                      <span className="text-muted-foreground text-xs">n/a</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {e.hasStaking ? (
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        defaultValue={
                          e.stakingValueEur !== undefined ? String(e.stakingValueEur) : ""
                        }
                        onChange={(ev) =>
                          update(idx, {
                            stakingValueEur: parseInputNumber(ev.currentTarget.value),
                          })
                        }
                        className="h-8 w-24 text-right tabular-nums"
                        disabled={applied}
                      />
                    ) : (
                      <span className="text-muted-foreground text-xs">n/a</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {qtyDiff === undefined ? (
                      "—"
                    ) : Math.abs(qtyDiff) < 1e-6 ? (
                      <span className="text-emerald-600 dark:text-emerald-400">✓ match</span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">
                        {qtyDiff > 0 ? "+" : ""}
                        {formatQty(qtyDiff)}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {/* (v2.19.0) Manual holdings to add — for spin-offs, gifts, anything
            not in the cash transactions. Each draft becomes a TRANSFER_IN
            with its own cost basis. */}
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Other holdings to add</div>
            {!applied && !showAdd && (
              <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
                + Add holding
              </Button>
            )}
          </div>
          {drafts.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>ISIN</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Cost basis</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drafts.map((d, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="font-medium">{d.symbol}</TableCell>
                    <TableCell className="font-mono text-xs">{d.isin}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">€{d.costBasisEur}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{d.source}</TableCell>
                    <TableCell>
                      {!applied && (
                        <Button size="sm" variant="ghost" onClick={() => removeDraft(idx)}>
                          Remove
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {showAdd && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-muted-foreground text-xs">Symbol *</label>
                  <Input
                    value={newDraft.symbol}
                    onChange={(e) =>
                      setNewDraft((d) => ({ ...d, symbol: e.currentTarget.value.trim() }))
                    }
                    placeholder="e.g. SOLST"
                    className="h-8"
                  />
                </div>
                <div>
                  <label className="text-muted-foreground text-xs">ISIN</label>
                  <Input
                    value={newDraft.isin}
                    onChange={(e) =>
                      setNewDraft((d) => ({ ...d, isin: e.currentTarget.value.trim() }))
                    }
                    placeholder="e.g. US83443Q1031"
                    className="h-8"
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-muted-foreground text-xs">Name</label>
                  <Input
                    value={newDraft.name}
                    onChange={(e) => setNewDraft((d) => ({ ...d, name: e.currentTarget.value }))}
                    placeholder="e.g. Solstice Advanced Materials"
                    className="h-8"
                  />
                </div>
                <div>
                  <label className="text-muted-foreground text-xs">Quantity *</label>
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={newDraft.quantity}
                    onChange={(e) =>
                      setNewDraft((d) => ({ ...d, quantity: e.currentTarget.value }))
                    }
                    placeholder="0.404784"
                    className="h-8 text-right tabular-nums"
                  />
                </div>
                <div>
                  <label className="text-muted-foreground text-xs">Cost basis (EUR) *</label>
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={newDraft.costBasisEur}
                    onChange={(e) =>
                      setNewDraft((d) => ({ ...d, costBasisEur: e.currentTarget.value }))
                    }
                    placeholder="58.21"
                    className="h-8 text-right tabular-nums"
                  />
                </div>
                <div>
                  <label className="text-muted-foreground text-xs">Date (YYYY-MM-DD)</label>
                  <Input
                    value={newDraft.date}
                    onChange={(e) => setNewDraft((d) => ({ ...d, date: e.currentTarget.value }))}
                    placeholder={defaultDate}
                    className="h-8"
                  />
                </div>
                <div>
                  <label className="text-muted-foreground text-xs">Source / note</label>
                  <Input
                    value={newDraft.source}
                    onChange={(e) => setNewDraft((d) => ({ ...d, source: e.currentTarget.value }))}
                    placeholder="Spin-off from HON"
                    className="h-8"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowAdd(false);
                    setNewDraft(emptyManualDraft(defaultDate));
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={commitDraft} disabled={!newDraftValid}>
                  Add
                </Button>
              </div>
            </div>
          )}
          {drafts.length === 0 && !showAdd && (
            <p className="text-muted-foreground text-xs">
              No manual holdings added. Use this for spin-off shares, gifts, inheritances, or
              anything else the PDF doesn't capture.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 pt-2">
          <div className="text-muted-foreground text-xs">
            Total staking value: {formatEur(totalStaking)}
            {drafts.length > 0 &&
              ` · ${drafts.length} manual holding${drafts.length === 1 ? "" : "s"}`}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onSkip} disabled={applied}>
              Skip
            </Button>
            <Button
              size="sm"
              onClick={() => onApply(editable, drafts)}
              disabled={applied || !hasAnyInput}
            >
              {applied ? "Applied" : "Apply Adjustments"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
