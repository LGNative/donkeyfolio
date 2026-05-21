import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
  Input,
} from "@wealthfolio/ui";
import React from "react";

import type { MapperResult } from "../lib/tr-csv-mapper";

interface AssetSummary {
  symbol: string;
  displayName: string;
  bucket?: string;
  country?: string;
  flag?: string;
  defaultQuoteCcy?: string;
  instrumentType?: string;
  activityCount: number;
}

export interface AssetOverride {
  /** New quoteCcy chosen by the user (e.g. "EUR"). */
  quoteCcy: string;
}

interface Props {
  mapping: MapperResult;
  /** Existing overrides keyed by asset symbol (Yahoo-friendly form). */
  overrides: Map<string, AssetOverride>;
  onChange: (next: Map<string, AssetOverride>) => void;
  onBack: () => void;
  onContinue: () => void;
}

const COMMON_CURRENCIES = ["EUR", "USD", "GBP", "GBp", "CHF", "JPY", "CAD", "DKK", "SEK", "NOK"];

interface AssetActivity {
  symbol?: { symbol?: string; name?: string; quoteCcy?: string; instrumentType?: string };
  metadata?: string | Record<string, unknown>;
}

export function ReviewAssetsView({
  mapping,
  overrides,
  onChange,
  onBack,
  onContinue,
}: Props): React.JSX.Element {
  const [filter, setFilter] = React.useState("");
  const [showOnlyEdited, setShowOnlyEdited] = React.useState(false);

  // Aggregate unique assets from the mapping output.
  const assets: AssetSummary[] = React.useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const a of mapping.activities as AssetActivity[]) {
      const sym = a.symbol;
      if (!sym?.symbol) continue;
      const key = sym.symbol;
      const cur = map.get(key);
      let parsedMeta: Record<string, unknown> | null = null;
      try {
        if (typeof a.metadata === "string") {
          parsedMeta = JSON.parse(a.metadata) as Record<string, unknown>;
        } else if (a.metadata && typeof a.metadata === "object") {
          parsedMeta = a.metadata as Record<string, unknown>;
        }
      } catch {
        parsedMeta = null;
      }
      if (cur) {
        cur.activityCount++;
      } else {
        map.set(key, {
          symbol: key,
          displayName: sym.name ?? key,
          bucket: parsedMeta?.tr_asset_bucket as string | undefined,
          country: parsedMeta?.tr_country as string | undefined,
          flag: parsedMeta?.tr_country_flag as string | undefined,
          defaultQuoteCcy: sym.quoteCcy,
          instrumentType: sym.instrumentType,
          activityCount: 1,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.activityCount - a.activityCount);
  }, [mapping]);

  const filtered = React.useMemo(() => {
    let list = assets;
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      list = list.filter(
        (a) =>
          a.symbol.toLowerCase().includes(q) ||
          a.displayName.toLowerCase().includes(q) ||
          (a.country ?? "").toLowerCase().includes(q),
      );
    }
    if (showOnlyEdited) list = list.filter((a) => overrides.has(a.symbol));
    return list;
  }, [assets, filter, showOnlyEdited, overrides]);

  const setOverride = React.useCallback(
    (symbol: string, quoteCcy: string) => {
      const next = new Map(overrides);
      const defaultCcy = assets.find((a) => a.symbol === symbol)?.defaultQuoteCcy;
      if (!quoteCcy.trim() || quoteCcy === defaultCcy) {
        next.delete(symbol);
      } else {
        next.set(symbol, { quoteCcy: quoteCcy.toUpperCase() });
      }
      onChange(next);
    },
    [overrides, onChange, assets],
  );

  const setAllToEur = React.useCallback(() => {
    const next = new Map(overrides);
    for (const a of assets) {
      if (a.defaultQuoteCcy !== "EUR") {
        next.set(a.symbol, { quoteCcy: "EUR" });
      }
    }
    onChange(next);
  }, [assets, overrides, onChange]);

  const resetOverrides = React.useCallback(() => {
    onChange(new Map());
  }, [onChange]);

  const editedCount = overrides.size;
  const eurCount = assets.filter(
    (a) => (overrides.get(a.symbol)?.quoteCcy ?? a.defaultQuoteCcy) === "EUR",
  ).length;
  const usdCount = assets.filter(
    (a) => (overrides.get(a.symbol)?.quoteCcy ?? a.defaultQuoteCcy) === "USD",
  ).length;
  const otherCount = assets.length - eurCount - usdCount;

  return (
    <div className="space-y-4">
      <WizardStepIndicator
        steps={[
          { label: "Carregar", state: "done" },
          { label: "Mapear", state: "done" },
          { label: "Rever assets", state: "current" },
          { label: "Importar", state: "future" },
        ]}
      />

      {/* v4.6.0 — auto-detection banner. The override target currency is
          NOT hardcoded — it's whatever the trades say. ABCL → EUR for a TR
          PT user; some other asset on a USD account → USD; etc. */}
      {editedCount > 0 && <SuggestionsBanner overrides={overrides} assets={assets} />}

      {/* Top KPI strip */}
      <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Assets únicos</CardTitle>
            <span className="text-xl font-bold tabular-nums sm:text-2xl">{assets.length}</span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <Row label="Editados" value={editedCount} accent={editedCount > 0 ? "primary" : ""} />
            <Row label="Default ETF/UCITS" value={eurCount} />
          </CardContent>
        </Card>

        <Card className="border-success/10 bg-success/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Em EUR</CardTitle>
            <span className="text-success text-xl font-bold tabular-nums sm:text-2xl">
              {eurCount}
            </span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <Row label="Crypto + ETFs Xetra" value={eurCount} />
            <p className="text-muted-foreground text-xs">
              Todos os preços vão aparecer em EUR sem conversão.
            </p>
          </CardContent>
        </Card>

        <Card className="border-amber-500/10 bg-amber-500/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 pt-4">
            <CardTitle className="text-sm font-medium">Em outras moedas</CardTitle>
            <span className="text-xl font-bold tabular-nums sm:text-2xl">
              {usdCount + otherCount}
            </span>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <Row label="USD" value={usdCount} />
            <Row label="Outras (GBp/CHF/CAD/...)" value={otherCount} />
            <p className="text-muted-foreground text-xs">
              Donkeyfolio converte para EUR via FX. Toggle 🌐 no Holdings para mostrar EUR.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Bulk actions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Override em massa</CardTitle>
          <CardDescription>
            Forçar todos os assets a ter <code>quoteCcy=EUR</code> elimina conversões FX no display.
            Cuidado: se o provider Yahoo devolver USD para AAPL e disseres EUR, Wealthfolio mostra o
            número USD com símbolo €. Recomendado: deixa default e usa o toggle 🌐 no Holdings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={setAllToEur}>
            <Icons.HandCoins className="mr-2 h-4 w-4" />
            Forçar todos a EUR
          </Button>
          <Button variant="ghost" size="sm" onClick={resetOverrides} disabled={editedCount === 0}>
            <Icons.Refresh className="mr-2 h-4 w-4" />
            Reverter overrides
          </Button>
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Procurar por ticker, nome ou país..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-sm"
        />
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={showOnlyEdited}
            onChange={(e) => setShowOnlyEdited(e.target.checked)}
            disabled={editedCount === 0}
          />
          Só editados ({editedCount})
        </label>
        <span className="text-muted-foreground ml-auto text-xs">
          {filtered.length} de {assets.length}
        </span>
      </div>

      {/* Asset list */}
      <Card>
        <CardContent className="p-0">
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0">
                <tr className="text-muted-foreground text-xs uppercase tracking-wider">
                  <th className="p-3 text-left font-medium">Asset</th>
                  <th className="p-3 text-left font-medium">Bucket</th>
                  <th className="p-3 text-right font-medium">Activities</th>
                  <th className="p-3 text-left font-medium">quoteCcy</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => {
                  const override = overrides.get(a.symbol);
                  const effective = override?.quoteCcy ?? a.defaultQuoteCcy ?? "—";
                  const isEdited = !!override;
                  return (
                    <tr key={a.symbol} className="hover:bg-muted/20 border-t">
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className="text-base">{a.flag ?? "🏳️"}</span>
                          <div>
                            <p className="font-medium">{a.displayName}</p>
                            <p className="text-muted-foreground text-xs">
                              {a.symbol} · {a.country ?? "?"}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="p-3">
                        <Badge variant="secondary" className="text-xs">
                          {a.bucket ?? "?"}
                        </Badge>
                      </td>
                      <td className="text-muted-foreground p-3 text-right tabular-nums">
                        {a.activityCount}
                      </td>
                      <td className="p-3">
                        <select
                          value={effective}
                          onChange={(e) => setOverride(a.symbol, e.target.value)}
                          className={
                            "bg-background w-24 rounded-md border px-2 py-1 text-xs " +
                            (isEdited ? "border-primary text-primary" : "")
                          }
                        >
                          {!COMMON_CURRENCIES.includes(effective) && (
                            <option value={effective}>{effective}</option>
                          )}
                          {COMMON_CURRENCIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        {a.defaultQuoteCcy && a.defaultQuoteCcy !== effective && (
                          <p className="text-muted-foreground mt-1 text-xs">
                            era {a.defaultQuoteCcy}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <Button variant="outline" onClick={onBack}>
            ← Voltar
          </Button>
          <div className="text-muted-foreground text-xs">
            {editedCount > 0
              ? `${editedCount} asset(s) com quoteCcy override aplicado.`
              : "Sem overrides — todos os assets usam o quoteCcy default do mapper."}
          </div>
          <Button onClick={onContinue} size="lg">
            <Icons.ArrowDownLeft className="mr-2 h-4 w-4" />
            Importar {mapping.activities.length} activities
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Banner shown above the asset list when the wizard pre-populated one or
 * more overrides. The currency labels come from the actual overrides map
 * — no hardcoded "EUR" text. If a USD-account user ends up with USD
 * suggestions, the banner says "USD" instead.
 */
function SuggestionsBanner({
  overrides,
  assets,
}: {
  overrides: Map<string, AssetOverride>;
  assets: AssetSummary[];
}): React.JSX.Element {
  // Distribution of override target currencies → "5 → EUR, 1 → USD"
  const ccyCounts = new Map<string, number>();
  for (const o of overrides.values()) {
    ccyCounts.set(o.quoteCcy, (ccyCounts.get(o.quoteCcy) ?? 0) + 1);
  }
  const distribution = [...ccyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ccy, n]) => `${n} → ${ccy}`)
    .join(", ");

  // Distinct previous currencies → "USD, CAD"
  const prevCcys = new Set<string>();
  for (const sym of overrides.keys()) {
    const prev = assets.find((a) => a.symbol === sym)?.defaultQuoteCcy;
    if (prev) prevCcys.add(prev);
  }
  const prevList = [...prevCcys].sort().join(", ");

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="flex items-start gap-3 py-3 text-sm">
        <Icons.Sparkles className="text-primary mt-0.5 h-5 w-5 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium">
            Pré-marquei {overrides.size} asset(s) com override de <code>quoteCcy</code> (
            {distribution})
          </p>
          <p className="text-muted-foreground text-xs">
            Para estes assets, todas as transações no CSV foram numa moeda única que difere do{" "}
            <code>quoteCcy</code> mapeado ({prevList || "—"}). Aplicar o override faz o{" "}
            <code>Book Cost</code> e <code>Average cost</code> baterem exato com o que foi pago no
            TR. <code>Today's Price</code> pode ficar desencontrado (Yahoo continua a devolver na
            moeda nativa do mercado). Podes desmarcar individualmente abaixo ou usar "Reverter
            overrides".
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={"font-medium tabular-nums " + (accent === "primary" ? "text-primary" : "")}>
        {value.toLocaleString("pt-PT")}
      </span>
    </div>
  );
}

interface WizardStep {
  label: string;
  state: "done" | "current" | "future";
}

export function WizardStepIndicator({ steps }: { steps: WizardStep[] }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1">
      {steps.map((s, i) => (
        <React.Fragment key={s.label}>
          <div className="flex items-center gap-2">
            <div
              className={
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold " +
                (s.state === "done"
                  ? "bg-success/20 text-success"
                  : s.state === "current"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground")
              }
            >
              {s.state === "done" ? <Icons.CheckCircle className="h-4 w-4" /> : i + 1}
            </div>
            <span
              className={
                "text-sm " +
                (s.state === "current"
                  ? "font-medium"
                  : s.state === "done"
                    ? "text-muted-foreground"
                    : "text-muted-foreground/60")
              }
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && <div className="bg-border h-px flex-1" />}
        </React.Fragment>
      ))}
    </div>
  );
}
