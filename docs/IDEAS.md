# Donkeyfolio — Ideas & Roadmap

_Consolidated from ideas/, LGNative/docs/, and inspirational screenshots._
_Last updated: 2026-05-21_

---

## From: `ideas/PRIORIDADES.md`

# Prioridades Donkeyfolio

## TOP 3 (por ordem)

1. **Impostos PT (IRS)** — addon JS
   - Cálculo mais-valias FIFO, Anexos G/J/E
   - Simulador englobamento vs taxa liberatória
   - Ver: ideas/addon-impostos-pt.md

2. **Trade Republic** — crate Rust
   - Sync automático de transações/dividendos
   - Auth com 2FA, WebSocket API
   - Ver: ideas/integracao-brokers.md

3. **Calendário de Dividendos** — addon JS
   - Próximos pagamentos das posições em carteira
   - Projeção anual de rendimento
   - Yield on cost, dividend growth
   - Ver: ideas/mais-ideias.md (secção Dividendos)

---

## From: `ideas/addon-avaliacao-empresas.md`

# Addon: Avaliação Fundamental de Empresas

## Conceito

Avaliar automaticamente as empresas em carteira usando métricas fundamentais.
Alpha Vantage já está integrado no Donkeyfolio — pode ser usado como fonte de
dados.

## Funcionalidades

- P/E, P/B, EV/EBITDA, ROE, Dividend Yield, EPS
- Score automático (value score 1-10)
- Comparação entre empresas do mesmo setor
- Fair value estimado vs preço atual (DCF simplificado)
- Histórico de métricas

## APIs

- Alpha Vantage (já integrado) — Company Overview endpoint gratuito
- Financial Modeling Prep — alternativa com DCF, 250 req/dia grátis

---

## From: `ideas/addon-impostos-pt.md`

# Addon: Impostos Portugal (IRS Investimentos)

## Conceito

Addon para calcular automaticamente os impostos sobre investimentos em Portugal,
gerando relatórios prontos para preencher no Portal das Finanças.

Vantagem vs Tax-Wizard (25EUR/ano): dados já estão no Donkeyfolio, sem
export/import.

## Funcionalidades

### Cálculo de Mais-Valias

- Método FIFO (obrigatório em PT)
- Conversão automática de moeda (USD->EUR, etc.) com câmbio do dia
- Separação entre mais-valias e menos-valias
- Detenção >365 dias (possível isenção)

### Separação por Anexo IRS

- **Anexo G** — mais-valias de ativos nacionais
- **Anexo G1** — mais-valias não tributadas (>365 dias se aplicável)
- **Anexo J** — rendimentos obtidos no estrangeiro (brokers internacionais)
- **Anexo E** — dividendos e juros

### Relatório IRS

- Relatório detalhado por transação (data compra, data venda, valor, mais-valia)
- Resumo por anexo com totais
- Formato pronto a preencher no Portal das Finanças
- Possível export em formato XML compatível

### Simulador de Imposto

- Cálculo a 28% (taxa liberatória)
- Simulação de englobamento (escalões IRS)
- Comparação: qual opção paga menos
- Compensação de menos-valias

### Dividendos

- Retenção na fonte (28% PT, taxas estrangeiras)
- Crédito de imposto por dupla tributação
- Separação por país de origem

## Referências

- Tax-Wizard: https://tax-wizard.eu/pt (serviço semelhante, 25EUR, sem API)
- Portal das Finanças: https://irs.portaldasfinancas.gov.pt
- Código IRS: artigos 10, 43, 72 (mais-valias e taxas)

## Notas Técnicas

- Verificar addon SDK em packages/addon-sdk/
- Dados disponíveis: transações, dividendos, holdings, contas
- Pode ser addon local (ZIP) ou futuro addon na store

---

## From: `ideas/integracao-brokers.md`

# Integração com Brokers

## Conceito

Importação automática de transações de brokers populares em Portugal/Europa, sem
necessidade de export manual de CSV.

## Brokers Prioritários

- **Trade Republic** — muito popular em PT, API não oficial disponível
- **Degiro** — popular em PT, export CSV
- **Interactive Brokers** — Flex Query API
- **Revolut** — export CSV
- **Trading 212** — export CSV
- **XTB** — popular em PT
- **eToro** — export CSV

## Níveis de Integração

### Nível 1: Import CSV melhorado

- Templates de mapeamento por broker
- Detecção automática do formato (qual broker é)
- Parsing inteligente (datas, moedas, tipos de operação)

### Nível 2: API directa (onde disponível)

- Trade Republic: API não oficial (reverse engineered)
- Interactive Brokers: Flex Query API oficial
- Sync automático periódico

### Nível 3: Open Banking / Connect

- Já existe sistema "Wealthfolio Connect" no código
- Possível extensão para brokers europeus

## Trade Republic (detalhe)

- Muito usado em PT/Europa
- Não tem API oficial pública
- Existem libs open-source (Python/JS) que fazem scraping da API
- Dados: transações, dividendos, savings plans, crypto
- Risco: API pode mudar sem aviso

## Notas

- Verificar o que já existe em crates/connect/
- O import CSV já funciona (apps/frontend/src/pages/activity/import/)
- Foco inicial: melhorar templates CSV para brokers PT/EU

---

## From: `ideas/mais-ideias.md`

# Ideias Adicionais para Donkeyfolio

## Alertas e Notificações

- Alerta de preço (ação sobe/desce X%)
- Alerta de dividendo próximo
- Alerta de rebalanceamento necessário
- Notificação quando posição atinge target

## Análise de Risco

- Diversificação por setor/geografia/moeda
- Correlação entre ativos
- Drawdown máximo histórico
- Sharpe ratio do portfolio

## Dividendos

- Calendário de dividendos (próximos pagamentos)
- Projeção de rendimento anual de dividendos
- Yield on cost por posição
- Histórico de crescimento de dividendos (dividend growth)

## Benchmark

- Comparar portfolio vs S&P 500, MSCI World, PSI-20
- Alpha e Beta do portfolio
- Performance relativa por período

## Export/Relatórios

- Relatório mensal/anual PDF automático
- Export para Excel com formatação
- Gráficos de performance para partilhar

## Social / Comunidade

- Portfolio anónimo público (partilhar alocação sem valores)
- Comparar alocação com média dos utilizadores

## Crypto

- Tracking de crypto (Bitcoin, ETH, etc.)
- DeFi positions
- Staking rewards

## Imobiliário

- Tracking de imóveis como ativos
- Rendas como income
- Valorização estimada

## Poupança / Objetivos

- Savings rate tracking
- FIRE calculator (Financial Independence)
- Projeção de portfolio futuro com Monte Carlo simulation

## Integrações

- Trade Republic (crate Rust — já em análise)
- Degiro CSV import template
- Interactive Brokers Flex Query
- Revolut CSV
- Banco de Portugal (taxas de câmbio oficiais)

---

## From: `ideas/notificacoes.md`

# Notificações Mobile

## Opção recomendada: Telegram Bot

- Grátis, API simples
- Cria bot via @BotFather, token na app
- Envia alertas de preço, dividendos, resumo diário

## Outras opções

- Pushover (5EUR one-time, API simples)
- Ntfy.sh (grátis, open-source, push notifications)
- Email (grátis, universal)
- WhatsApp Business API (pago, ~0.05EUR/msg, complexo)

## Tipos de notificação

- Alerta de preço (sobe/desce X%)
- Dividendo próximo (ex-date, pay-date)
- Resumo diário/semanal do portfolio
- Rebalanceamento necessário
- Update de impostos (fim do ano fiscal)

---

## From: `LGNative/docs/IDEAS.md`

# Ideas backlog

Running list of things to consider — not commitments, not prioritized. Add stuff
freely as it occurs to you. Triage later in `ROADMAP.md`.

Format per item:

```
## YYYY-MM-DD — short title

- **Why:** the user-visible problem or opportunity
- **What:** rough sketch of the solution
- **Effort:** XS / S / M / L / XL
- **Open questions:** anything to resolve before starting
```

---

## 2026-05-01 — Force EUR display on USD-quoted assets (TR-only mode)

- **Why:** Donkeyfolio asset detail page shows USD for NASDAQ-listed stocks,
  even though TR PT users only ever see EUR. Confusing.
- **What:** Optional setting that overrides asset.quote_ccy = EUR for imported
  assets, with quote_mode = MANUAL. Addon then pushes EUR prices via own quote
  feeder (Yahoo USD × ECB FX).
- **Effort:** M (3-4h)
- **Open questions:** Breaks Yahoo auto-sync. User has rejected forcing the
  platform once already — keep this on ice unless they change their mind.

## 2026-05-01 — pytr-style WebSocket sync addon

- **Why:** PDF parsing has a long tail of edge cases. WebSocket API to TR
  returns structured JSON.
- **What:** Separate `tr-live-sync` addon that uses Anthropic SecretsAPI to
  store TR phone+PIN, talks to TR's WebSocket, delivers transactions in JSON.
- **Effort:** XL (2-3 days)
- **Open questions:** TR can break the API. Violates ToS technically. User has
  access to pytr Python lib — could call it via subprocess?

## 2026-05-01 — AI Wizard auto-extract from screenshots

- **Why:** User has to type/paste TR app data manually. Could OCR screenshots of
  the TR app's holdings list.
- **What:** Add upload button to the AI Wizard that accepts an image, passes it
  to Claude as multimodal input, Claude extracts holdings table to text, then
  runs normal validation flow.
- **Effort:** S (1-2h once Wizard infra exists)
- **Open questions:** Adds vision tokens to API call (~$0.05 extra per
  validation). TR app screenshot UI might change.

## 2026-05-01 — Per-asset import (phased)

- **Why:** Big yearly imports are scary. User wants to validate asset-by-asset.
- **What:** After parsing, show a per-asset list with checkboxes. User imports
  only selected assets first, validates, imports more later.
- **Effort:** M (4-5h)
- **Open questions:** Cash flow gets fragmented. Reconciliation becomes harder.

## 2026-05-01 — Tax Report PDF enhancements

- **Why:** Currently we parse the staking section. TR Tax Report has more:
  realized gains/losses, dividend WHT detail, country breakdown.
- **What:** Extend `tr-tax-report.ts` to extract these. Surface as a "Tax Year
  Summary" tab in the addon.
- **Effort:** M (4-6h)
- **Open questions:** Layout varies year-over-year — needs robust multi-year
  regex.

## 2026-05-01 — Support multiple TR accounts in one user

- **Why:** Some users have TR cash + TR trading + TR crypto as separate
  Wealthfolio accounts.
- **What:** Account picker in addon shows all TR accounts. Drop one PDF per
  account, idempotency keys keep them separate.
- **Effort:** S (already mostly works — just need UX clarification)
- **Open questions:** None blocking.

---

## Triage policy

- Add ideas freely.
- Once a month, review and either:
  - Move to `ROADMAP.md` with priority + estimated start week.
  - Mark `WONT_DO` here with rationale.
  - Leave for later — no pressure.
- Don't delete ideas. The graveyard is useful context.

---

## From: `LGNative/docs/FEES_FLOW.md`

# Onde ficam as comissões — TR PDF → Donkeyfolio

Mapa completo de cada tipo de fee TR e onde aparece no Donkeyfolio após o
import.

## Tabela de fees TR Portugal (oficial 2026)

| Operação TR                        | Fee real  | TR PDF coluna                                            | Activity emitida pelo addon                                | Campo onde aparece em Donkeyfolio    |
| ---------------------------------- | --------- | -------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| Manual BUY ações/ETF/cripto/bonds  | **€1**    | Implícito no cash leg (€151 cash = €150 amount + €1 fee) | `activityType=BUY` + `fee=1`                               | Activity table → coluna **Fee**      |
| Manual SELL ações/ETF/cripto/bonds | **€1**    | Implícito no cash leg (€999 cash = €1000 gross − €1 fee) | `activityType=SELL` + `fee=1`                              | Activity table → coluna **Fee**      |
| **Savings plan** (qualquer ativo)  | **€0**    | Implícito (€10 cash = €10 amount + €0)                   | `activityType=BUY` + `fee=0`                               | Activity table → coluna **Fee** = €0 |
| Withdrawal < €100                  | **€1**    | Linha cash dedicada "Comissão de levantamento −1,00 €"   | `activityType=FEE` + `subtype=WITHDRAWAL_FEE` + `amount=1` | Activity table → linha FEE           |
| Withdrawal ≥ €100                  | **€0**    | n/a                                                      | n/a                                                        | n/a                                  |
| Cartão Classic (uma vez)           | **€5**    | Linha cash dedicada "Cartão Classic −5,00 €"             | `activityType=FEE` + `subtype=CARD_SETUP` + `amount=5`     | Activity table → linha FEE           |
| Cartão Mirror (uma vez)            | **€50**   | Linha cash dedicada "Cartão Mirror −50,00 €"             | `activityType=FEE` + `subtype=CARD_SETUP` + `amount=50`    | Activity table → linha FEE           |
| Custódia / inactividade            | **€0**    | n/a                                                      | n/a                                                        | n/a                                  |
| Dividendos / distribuições ETF     | **€0**    | Linha de income (positiva)                               | `activityType=DIVIDEND` + `fee=0`                          | Income tab                           |
| FX conversion (USD trades)         | **0.15%** | Embebido no spread, NÃO aparece como linha               | n/a (já incluído no cash amount)                           | Inferido via fxRate ECB rate         |
| Transferência incoming             | **€0**    | Linha cash positiva                                      | `activityType=DEPOSIT`                                     | Cash flow                            |

## Detalhe técnico — como o addon separa fee

Para uma BUY de €151 cash leg:

```
PDF row:          "Compra ServiceNow ... €151,00"
                  (fee implícito de €1 dentro dos €151)

Addon parser:     totalCash = 151.00
                  isSavingsPlan = false  (não tem keyword "Plano de poupança")
                  resolvedFee = pdfFee ?? heuristicFee
                              = undefined ?? (false ? 0 : 1)
                              = €1.00
                  grossAmount = isBuy ? totalCash − fee : totalCash + fee
                              = 151 − 1
                              = €150.00
                  unitPrice = grossAmount / qty
                            = 150 / 2.036383
                            = €73.66

Activity sent:    {
                    activityType: "BUY",
                    quantity: 2.036383,
                    unitPrice: 73.66,
                    amount: 150.00,    ← gross, sem fee
                    fee: 1.00,         ← fee separado
                    currency: "EUR",
                    ...
                  }

Donkeyfolio
Activities tab:   [Apr 24] BUY ServiceNow  qty=2.036383  €73.66  fee=€1.00  total=€151.00
                                                                  ↑
                                                          coluna "Fee"
```

## Como verificar no Donkeyfolio após import

1. **Activities tab** → filtra por TR account → tabela mostra coluna **Fee**
   - Soma da coluna Fee = total de comissões pagas no período
2. **Activities tab** → filtra por `activityType=FEE` → vês withdrawal fees +
   card setup fees como linhas separadas
3. **Income tab** → vês todos os DIVIDEND + INTEREST sem fees

## Edge cases que o addon trata

| Cenário                                          | Comportamento v3.0.10                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Partial fill (2 cash rows mesma ordem TR)        | Agrega por `tradeId` ou unit-price proximity → 1 BUY com €1 fee único, não €2 |
| Savings plan multi-língua                        | Regex apanha PT/DE/EN/FR/IT/ES → `fee=0` em todos                             |
| Trade onde gross < fee                           | Defensive: keep cash amount, fee=0 (evita unitPrice negativo)                 |
| Fee linha explícita no PDF (Fremdkostenzuschlag) | Sobrepõe heurística                                                           |
| Fee na cash row mas description diz "Withdrawal" | Mapeado como FEE/WITHDRAWAL_FEE em vez de WITHDRAWAL com amount errado        |

## Caveats conhecidos

- **FX conversion 0.15%** não é tracked como activity separada porque está
  embedded no spread. Se quiseres ver impacto, tens de calcular off-line:
  `0.15% × valor_USD_trades_no_periodo`.
- **Saveback ETF reinvestments** entram como CREDIT (não BUY) com
  subtype=SAVEBACK. Não tem fee.
- **Spreads cripto** (~0.8-1%) não tracked separadamente — embedded no preço de
  execução TR.

---


## Visual Inspiration

Screenshots in `Insparação/` folder:

- `Insparação/Screenshot 2026-05-06 at 16.04.55.png`
- `Insparação/Screenshot 2026-05-06 at 16.05.00.png`
- `Insparação/Screenshot 2026-05-06 at 16.05.04.png`
- `Insparação/Screenshot 2026-05-06 at 16.05.09.png`
- `Insparação/Screenshot 2026-05-06 at 16.05.15.png`
- `Insparação/Screenshot 2026-05-06 at 16.08.28.png`
