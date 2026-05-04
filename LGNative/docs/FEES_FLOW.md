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
