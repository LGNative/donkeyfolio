/**
 * TypeScript declaration merging — extend Wealthfolio SDK types WITHOUT
 * modifying upstream sources. (LGNative/addon-extensions)
 *
 * Why this file exists:
 *   The Rust `NewActivity` struct (crates/core/src/activities/activities_model.rs)
 *   accepts MORE fields at the JSON deserialization layer than what
 *   `@wealthfolio/addon-sdk` types document. Specifically:
 *     - status, needsReview, sourceSystem, sourceRecordId, idempotencyKey
 *       at top level
 *     - quoteCcy, instrumentType inside SymbolInput
 *
 *   We need TypeScript to recognize these so `addons/tr-pdf-converter`
 *   compiles cleanly without `as any` casts. Modifying the SDK source
 *   would conflict on every upstream merge from afadil/wealthfolio.
 *   Declaration merging is the standard TS way to extend a package's
 *   types from outside without touching it.
 *
 * How TypeScript picks this up:
 *   tsconfig.json's `include` covers LGNative/addon-extensions/*.d.ts,
 *   OR the addon's tsconfig adds a `types` reference. Declaration files
 *   are merged automatically with the original module's types.
 *
 * Maintenance:
 *   When Wealthfolio adds a field officially that we'd been augmenting
 *   here, REMOVE it from this file (avoid duplicate definitions).
 *   Run a quick `pnpm type-check` after every upstream merge to catch
 *   that case.
 */

import "@wealthfolio/addon-sdk";

declare module "@wealthfolio/addon-sdk" {
  /**
   * Fields the Rust NewActivity accepts that the SDK type doesn't list.
   * Verified against crates/core/src/activities/activities_model.rs:241.
   */
  interface ActivityCreate {
    /** Activity status (e.g. PENDING, EXECUTED). Defaults to EXECUTED. */
    status?: string | null;
    /** Flag activities that need user review post-import. */
    needsReview?: boolean | null;
    /** Provider system tag (TR_PDF, SNAPTRADE, MANUAL, CSV, etc.). */
    sourceSystem?: string | null;
    /** Provider's record ID for traceability. */
    sourceRecordId?: string | null;
    /** Stable hash for de-duplication on re-import. */
    idempotencyKey?: string | null;
  }

  /** Same fields are valid on update — symmetry preserved. */
  interface ActivityUpdate {
    status?: string | null;
    needsReview?: boolean | null;
    sourceSystem?: string | null;
    sourceRecordId?: string | null;
    idempotencyKey?: string | null;
  }

  /**
   * Fields the Rust SymbolInput accepts that the SDK type doesn't list.
   * Verified against crates/core/src/activities/activities_model.rs:219.
   */
  interface SymbolInput {
    /** Quote currency from symbol search/provider (USD, EUR, GBp, etc.). */
    quoteCcy?: string;
    /** Instrument type (EQUITY, CRYPTO, ETF, BOND, INDEX). */
    instrumentType?: string;
  }
}
