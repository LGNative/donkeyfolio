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

import {
  ask,
  clearApiKey,
  ExpertError,
  getApiKey,
  setApiKey,
  type ExpertContext,
  type ExpertResponse,
} from "../lib/tr-ai-expert";

interface SecretsApi {
  set: (key: string, value: string) => Promise<void>;
  get: (key: string) => Promise<string | null>;
  delete: (key: string) => Promise<void>;
}

interface Props {
  secrets: SecretsApi;
  context?: ExpertContext;
  onClose: () => void;
}

const SUGGESTED_QUESTIONS = [
  "Como funciona o idempotency_key no Wealthfolio?",
  "Porque é que alguns assets aparecem em USD em vez de EUR?",
  "Como declaro dividendos US no Anexo J do IRS?",
  "Que provider devo usar para preços em EUR de US stocks?",
  "Qual a diferença entre BUY com unitPrice=0 e ADJUSTMENT?",
  "Porque é que o Cash Balance não bate com o esperado?",
];

export function ExpertPanel({ secrets, context, onClose }: Props): React.JSX.Element {
  const [keyState, setKeyState] = React.useState<"loading" | "missing" | "present">("loading");
  const [keyDraft, setKeyDraft] = React.useState("");
  const [question, setQuestion] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [response, setResponse] = React.useState<ExpertResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [includeContext, setIncludeContext] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const key = await getApiKey(secrets);
      if (cancelled) return;
      setKeyState(key ? "present" : "missing");
    })();
    return () => {
      cancelled = true;
    };
  }, [secrets]);

  const handleSaveKey = React.useCallback(async () => {
    const trimmed = keyDraft.trim();
    if (!trimmed.startsWith("sk-ant-")) {
      setError("API key inválida — deve começar por 'sk-ant-'.");
      return;
    }
    try {
      await setApiKey(secrets, trimmed);
      setKeyState("present");
      setKeyDraft("");
      setError(null);
    } catch (err) {
      setError(`Não consegui guardar a key: ${(err as Error).message}`);
    }
  }, [keyDraft, secrets]);

  const handleClearKey = React.useCallback(async () => {
    await clearApiKey(secrets);
    setKeyState("missing");
    setResponse(null);
  }, [secrets]);

  const handleAsk = React.useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setPending(true);
      setError(null);
      try {
        const res = await ask(secrets, trimmed, includeContext ? context : undefined);
        setResponse(res);
      } catch (err) {
        if (err instanceof ExpertError && err.kind === "no_key") {
          setKeyState("missing");
        }
        setError((err as Error).message);
      } finally {
        setPending(false);
      }
    },
    [secrets, context, includeContext],
  );

  if (keyState === "loading") {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Icons.Spinner className="text-muted-foreground h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  if (keyState === "missing") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.Sparkles className="h-5 w-5" />
            Configurar Wealthfolio Expert
          </CardTitle>
          <CardDescription>
            Cola a tua Anthropic API key (BYOK). É guardada encriptada no keyring do macOS — fica só
            no teu computador. Cria uma em <code className="text-xs">console.anthropic.com</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            type="password"
            placeholder="sk-ant-api03-..."
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSaveKey();
            }}
          />
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={handleSaveKey} disabled={!keyDraft.trim()}>
              <Icons.CheckCircle className="mr-2 h-4 w-4" />
              Guardar key
            </Button>
            <Button variant="outline" onClick={onClose}>
              Cancelar
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Custo estimado: ~€0.05–0.15 por pergunta (Claude Sonnet 4.5). Respostas idênticas vêm do
            cache local — zero custo em re-perguntas. Tu controlas, tu pagas.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.Sparkles className="h-5 w-5" />
            Wealthfolio Expert
            {context && includeContext && (
              <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">
                contexto anexado
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Pergunta sobre o Donkeyfolio, este addon, mapping ou IRS PT. Respostas em PT, com
            referências a ficheiros quando aplicável.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                handleAsk(question);
              }
            }}
            placeholder="Ex: Porque o ADA aparece com 5368 quando devia ser 5683?"
            className="bg-background min-h-24 w-full rounded-md border p-3 text-sm"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={includeContext}
                onChange={(e) => setIncludeContext(e.target.checked)}
                disabled={!context}
              />
              {context ? "Anexar contexto actual (diagnóstico, erros)" : "Sem contexto disponível"}
            </label>
            <div className="flex gap-2">
              <Button onClick={() => handleAsk(question)} disabled={pending || !question.trim()}>
                {pending ? (
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Icons.Sparkles className="mr-2 h-4 w-4" />
                )}
                Perguntar
              </Button>
            </div>
          </div>

          {/* Suggestions */}
          {!response && !pending && (
            <div className="space-y-1.5 pt-2">
              <p className="text-muted-foreground text-xs font-medium uppercase">Sugestões</p>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => {
                      setQuestion(q);
                      handleAsk(q);
                    }}
                    className="bg-muted/50 hover:bg-muted rounded-md border px-2 py-1 text-xs transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="bg-destructive/10 border-destructive/40 rounded-md border p-3 text-sm">
              <p className="font-medium">Erro</p>
              <p className="font-mono text-xs">{error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {response && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base">Resposta</CardTitle>
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              {response.cached ? (
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">
                  cache · €0
                </Badge>
              ) : (
                <Badge variant="outline">
                  {response.inputTokens} in · {response.outputTokens} out · €
                  {(response.costEur ?? 0).toFixed(4)}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <pre className="bg-muted/30 overflow-auto whitespace-pre-wrap rounded-md border p-3 font-sans text-sm">
                {response.answer}
              </pre>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={onClose}>
          Fechar
        </Button>
        <Button variant="ghost" size="sm" onClick={handleClearKey}>
          <Icons.Trash className="mr-2 h-3 w-3" />
          Remover API key
        </Button>
      </div>
    </div>
  );
}
