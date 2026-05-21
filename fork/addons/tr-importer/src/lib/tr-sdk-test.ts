/**
 * SDK contract test for the TR Importer.
 *
 * Builds one sample activity per type that we emit (BUY, SELL, DIVIDEND,
 * INTEREST, DEPOSIT, WITHDRAWAL, TRANSFER_IN, FEE, CREDIT, ADJUSTMENT,
 * SPLIT, SELL@0 = worthless), inserts each via `activities.create()`,
 * captures per-type pass/fail, and deletes the inserted ones at the end
 * so the user's account is left untouched.
 *
 * Goal: detect Wealthfolio backend rejections (missing fields, invalid
 * subtypes, etc.) BEFORE the user does a full re-import of 4126 rows.
 *
 * No CSV needed — synthetic samples mirror our mapper's output shape.
 */

import type { ActivityCreate } from "@wealthfolio/addon-sdk";

export interface SdkTestSample {
  label: string;
  activity: ActivityCreate;
}

export interface SdkTestResult {
  label: string;
  activityType: string;
  status: "pass" | "fail";
  error?: string;
  /** ID assigned by the backend if it succeeded — used for cleanup. */
  createdId?: string;
}

/** Build samples that mirror what our mapper emits — same fields, same
 *  metadata shape, same idempotency convention. */
export function buildSamples(accountId: string): SdkTestSample[] {
  const today = new Date().toISOString();
  const meta = (extras: Record<string, unknown>) =>
    JSON.stringify({
      tr_source_system: "TR_CSV",
      tr_test: true,
      ...extras,
    });

  // Use a unique idempotency key per test run so retries don't collide
  const runId = Date.now().toString(36);
  const idem = (kind: string) => `tr-importer:test:${runId}:${kind}`;

  return [
    {
      label: "BUY (stock, EUR)",
      activity: {
        accountId,
        activityType: "BUY",
        activityDate: today,
        symbol: { symbol: "AAPL", kind: "INVESTMENT", quoteCcy: "EUR", instrumentType: "EQUITY" },
        quantity: 0.001,
        unitPrice: 1,
        currency: "EUR",
        fee: 0.01,
        comment: "TR Importer SDK test — BUY",
        metadata: meta({ tr_kind: "test_buy" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("buy"),
        idempotencyKey: idem("buy"),
      } as ActivityCreate,
    },
    {
      label: "SELL (stock, EUR)",
      activity: {
        accountId,
        activityType: "SELL",
        activityDate: today,
        symbol: { symbol: "AAPL", kind: "INVESTMENT", quoteCcy: "EUR", instrumentType: "EQUITY" },
        quantity: 0.001,
        unitPrice: 1,
        currency: "EUR",
        fee: 0.01,
        comment: "TR Importer SDK test — SELL",
        metadata: meta({ tr_kind: "test_sell" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("sell"),
        idempotencyKey: idem("sell"),
      } as ActivityCreate,
    },
    {
      label: "DIVIDEND (net amount)",
      activity: {
        accountId,
        activityType: "DIVIDEND",
        activityDate: today,
        symbol: { symbol: "AAPL", kind: "INVESTMENT", quoteCcy: "EUR", instrumentType: "EQUITY" },
        amount: 0.01,
        currency: "EUR",
        comment: "TR Importer SDK test — DIVIDEND",
        metadata: meta({ tr_kind: "test_dividend", tr_gross: 0.012, tr_wht: 0.002 }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("dividend"),
        idempotencyKey: idem("dividend"),
      } as ActivityCreate,
    },
    {
      label: "INTEREST (cash)",
      activity: {
        accountId,
        activityType: "INTEREST",
        activityDate: today,
        amount: 0.01,
        currency: "EUR",
        comment: "TR Importer SDK test — INTEREST",
        metadata: meta({ tr_kind: "test_interest" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("interest"),
        idempotencyKey: idem("interest"),
      } as ActivityCreate,
    },
    {
      label: "CREDIT/REBATE (saveback)",
      activity: {
        accountId,
        activityType: "CREDIT",
        subtype: "REBATE",
        activityDate: today,
        amount: 0.01,
        currency: "EUR",
        comment: "TR Importer SDK test — CREDIT/REBATE",
        metadata: meta({ tr_kind: "test_credit_rebate" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("credit-rebate"),
        idempotencyKey: idem("credit-rebate"),
      } as ActivityCreate,
    },
    {
      label: "DEPOSIT (cash inbound)",
      activity: {
        accountId,
        activityType: "DEPOSIT",
        activityDate: today,
        amount: 0.01,
        currency: "EUR",
        comment: "TR Importer SDK test — DEPOSIT",
        metadata: meta({ tr_kind: "test_deposit" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("deposit"),
        idempotencyKey: idem("deposit"),
      } as ActivityCreate,
    },
    {
      label: "WITHDRAWAL (cash out)",
      activity: {
        accountId,
        activityType: "WITHDRAWAL",
        activityDate: today,
        amount: 0.01,
        currency: "EUR",
        comment: "TR Importer SDK test — WITHDRAWAL",
        metadata: meta({ tr_kind: "test_withdrawal" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("withdrawal"),
        idempotencyKey: idem("withdrawal"),
      } as ActivityCreate,
    },
    {
      label: "TRANSFER_IN (staking, qty only)",
      activity: {
        accountId,
        activityType: "TRANSFER_IN",
        activityDate: today,
        symbol: {
          symbol: "SOL-EUR",
          kind: "INVESTMENT",
          quoteCcy: "EUR",
          instrumentType: "CRYPTO",
        },
        quantity: 0.001,
        currency: "EUR",
        comment: "TR Importer SDK test — TRANSFER_IN",
        metadata: meta({ tr_kind: "test_transfer_in", tr_staking: true }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("transfer-in"),
        idempotencyKey: idem("transfer-in"),
      } as ActivityCreate,
    },
    {
      label: "FEE (TR card)",
      activity: {
        accountId,
        activityType: "FEE",
        activityDate: today,
        amount: 0.01,
        currency: "EUR",
        comment: "TR Importer SDK test — FEE",
        metadata: meta({ tr_kind: "test_fee" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("fee"),
        idempotencyKey: idem("fee"),
      } as ActivityCreate,
    },
    {
      label: "ADJUSTMENT (merger pair)",
      activity: {
        accountId,
        activityType: "ADJUSTMENT",
        activityDate: today,
        symbol: { symbol: "AAPL", kind: "INVESTMENT", quoteCcy: "EUR", instrumentType: "EQUITY" },
        quantity: 0.001,
        currency: "EUR",
        comment: "TR Importer SDK test — ADJUSTMENT",
        metadata: meta({ tr_kind: "test_adjustment" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("adjustment"),
        idempotencyKey: idem("adjustment"),
      } as ActivityCreate,
    },
    {
      label: "SPLIT (ratio 2:1)",
      activity: {
        accountId,
        activityType: "SPLIT",
        activityDate: today,
        symbol: { symbol: "AAPL", kind: "INVESTMENT", quoteCcy: "EUR", instrumentType: "EQUITY" },
        amount: 2,
        currency: "EUR",
        comment: "TR Importer SDK test — SPLIT",
        metadata: meta({ tr_kind: "test_split" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("split"),
        idempotencyKey: idem("split"),
      } as ActivityCreate,
    },
    {
      label: "DIVIDEND/DIVIDEND_IN_KIND (stock dividend)",
      activity: {
        accountId,
        activityType: "DIVIDEND",
        subtype: "DIVIDEND_IN_KIND",
        activityDate: today,
        symbol: { symbol: "AAPL", kind: "INVESTMENT", quoteCcy: "EUR", instrumentType: "EQUITY" },
        quantity: 0.001,
        amount: 0,
        currency: "EUR",
        comment: "TR Importer SDK test — DIVIDEND_IN_KIND",
        metadata: meta({ tr_kind: "test_dividend_in_kind" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("dividend-in-kind"),
        idempotencyKey: idem("dividend-in-kind"),
      } as ActivityCreate,
    },
    {
      label: "SELL @ 0 (worthless write-off)",
      activity: {
        accountId,
        activityType: "SELL",
        activityDate: today,
        symbol: { symbol: "AAPL", kind: "INVESTMENT", quoteCcy: "EUR", instrumentType: "EQUITY" },
        quantity: 0.001,
        unitPrice: 0,
        amount: 0,
        currency: "EUR",
        comment: "TR Importer SDK test — WORTHLESS",
        metadata: meta({ tr_kind: "test_worthless" }),
        sourceSystem: "TR_CSV",
        sourceRecordId: idem("worthless"),
        idempotencyKey: idem("worthless"),
      } as ActivityCreate,
    },
  ];
}
