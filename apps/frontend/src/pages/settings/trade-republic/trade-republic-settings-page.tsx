import {
  trGetStatus,
  trSaveCredentials,
  trDeleteCredentials,
  trStartLogin,
  trConfirmLogin,
  trSyncPortfolio,
  trDisconnect,
} from "@/adapters";
import type { TrStatus, TrSyncResult } from "@/adapters/shared/trade-republic";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { useCallback, useEffect, useState } from "react";
import { SettingsHeader } from "../settings-header";

type Step = "idle" | "credentials" | "awaiting_2fa" | "syncing";

const LAST_SYNC_KEY = "tr_last_sync_at";

function formatLastSync(iso: string | null): string {
  if (!iso) return "Nunca";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "agora mesmo";
  if (mins < 60) return `há ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}

export default function TradeRepublicSettingsPage() {
  const [_status, setStatus] = useState<TrStatus | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<TrSyncResult | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(() =>
    typeof window !== "undefined" ? window.localStorage.getItem(LAST_SYNC_KEY) : null,
  );

  const refreshStatus = useCallback(async () => {
    try {
      const s = await trGetStatus();
      setStatus(s);
      if (s.hasCredentials) {
        setStep("idle");
      } else {
        setStep("credentials");
      }
    } catch {
      setStep("credentials");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleSaveCredentials = async () => {
    if (!phone || !pin) return;
    setLoading(true);
    try {
      await trSaveCredentials(phone, pin);
      toast({
        title: "Credentials saved",
        description: "Stored securely in your system keychain.",
      });
      setPin("");
      await refreshStatus();
    } catch (e) {
      toast({ title: "Error", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async () => {
    setLoading(true);
    try {
      await trStartLogin();
      setStep("awaiting_2fa");
      toast({
        title: "Confirma no teu telemóvel",
        description: "Abre a app Trade Republic e confirma o pedido de login.",
      });
    } catch (e) {
      toast({ title: "Login falhou", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm2FA = async () => {
    if (!code || code.length !== 4) return;
    setLoading(true);
    setStep("syncing");
    setSyncResult(null);
    try {
      await trConfirmLogin(code);
      setCode("");

      const result = await trSyncPortfolio();
      setSyncResult(result);

      const now = new Date().toISOString();
      window.localStorage.setItem(LAST_SYNC_KEY, now);
      setLastSyncAt(now);

      const cashSummary = result.cashBalances.map((c) => `${c.amount} ${c.currency}`).join(", ");
      toast({
        title: "Atualização concluída",
        description: `${result.positionsCount} posições, ${result.activitiesCreated} novas atividades${
          cashSummary ? ` · Cash: ${cashSummary}` : ""
        }`,
      });
    } catch (e) {
      toast({ title: "Falha na atualização", description: String(e), variant: "destructive" });
    } finally {
      await trDisconnect().catch(() => {});
      setStep("idle");
      setLoading(false);
    }
  };

  const handleRemoveCredentials = async () => {
    setLoading(true);
    try {
      await trDeleteCredentials();
      setStep("credentials");
      setSyncResult(null);
      toast({
        title: "Credenciais removidas",
        description: "Removidas do keychain.",
      });
      await refreshStatus();
    } catch (e) {
      toast({ title: "Erro", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        heading="Trade Republic"
        text="Connect directly to your Trade Republic account. All data stays on your device."
      />
      <Separator />

      {/* Security notice */}
      <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20">
        <CardContent className="flex items-start gap-3 pt-4">
          <Icons.Shield className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
          <div className="text-sm">
            <p className="font-medium">Local-first & secure</p>
            <p className="text-muted-foreground mt-1">
              Credentials are stored in your system keychain (macOS Keychain). Session tokens are
              kept in memory only. All data syncs directly to your local database — no cloud
              intermediary.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Step 1: Credentials */}
      {step === "credentials" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Configurar Credenciais</CardTitle>
            <CardDescription>
              Insere o teu número de telemóvel e PIN da Trade Republic. Serão guardados de forma
              segura no keychain do sistema.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tr-phone">Número de telemóvel</Label>
              <Input
                id="tr-phone"
                type="tel"
                placeholder="+351 912 345 678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tr-pin">PIN (4 dígitos)</Label>
              <Input
                id="tr-pin"
                type="password"
                maxLength={4}
                placeholder="••••"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            </div>
            <Button onClick={handleSaveCredentials} disabled={loading || !phone || !pin}>
              {loading ? <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" /> : null}
              Guardar Credenciais
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Idle — one-click update */}
      {step === "idle" && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Trade Republic</CardTitle>
                <CardDescription>Última atualização: {formatLastSync(lastSyncAt)}</CardDescription>
              </div>
              <Badge variant="secondary">Pronto</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button onClick={handleUpdate} disabled={loading}>
                {loading ? (
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Icons.RefreshCw className="mr-2 h-4 w-4" />
                )}
                Atualizar Portfolio
              </Button>
              <Button variant="ghost" onClick={handleRemoveCredentials} disabled={loading}>
                Remover Credenciais
              </Button>
            </div>

            {syncResult && (
              <div className="bg-muted space-y-2 rounded-lg p-4 text-sm">
                <p>
                  <strong>Última atualização:</strong> {syncResult.positionsCount} posições,{" "}
                  {syncResult.activitiesCreated} novas atividades importadas
                </p>
                {syncResult.cashBalances.length > 0 && (
                  <div>
                    <p className="font-medium">Cash disponível na Trade Republic:</p>
                    <ul className="text-muted-foreground mt-1 space-y-0.5">
                      {syncResult.cashBalances.map((c) => (
                        <li key={c.currency}>
                          {c.amount} {c.currency}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === "awaiting_2fa" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Confirmar Login</CardTitle>
            <CardDescription>
              Foi enviado um pedido de confirmação para a tua app Trade Republic. Insere o código de
              4 dígitos mostrado no teu telemóvel.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tr-code">Código de confirmação</Label>
              <Input
                id="tr-code"
                type="text"
                maxLength={4}
                placeholder="1234"
                className="w-32 text-center text-lg tracking-widest"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                autoFocus
              />
            </div>
            <Button onClick={handleConfirm2FA} disabled={loading || code.length !== 4}>
              {loading ? <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" /> : null}
              Confirmar e Sincronizar
            </Button>
          </CardContent>
        </Card>
      )}

      {step === "syncing" && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">A sincronizar...</CardTitle>
                <CardDescription>
                  A ligar à Trade Republic e a importar transações. Isto pode demorar uns segundos.
                </CardDescription>
              </div>
              <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                <Icons.Spinner className="mr-2 h-3 w-3 animate-spin" />
                Ativo
              </Badge>
            </div>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
