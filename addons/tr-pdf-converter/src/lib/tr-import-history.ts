/**
 * Track imported PDF periods in localStorage so the user can do
 * incremental imports across years without overlapping/duplicating
 * data. (v3.0.10)
 *
 * Why this exists:
 *   User does 1 PDF per year (or per quarter). Idempotency keys at the
 *   activity level prevent DUPLICATE writes — but the user has no
 *   visual feedback about which periods they've already imported. This
 *   module:
 *     1. Stores `{accountId, startDate, endDate, fileName, importedAt}`
 *        per import.
 *     2. Lets the UI surface a warning when a new PDF's period
 *        overlaps an already-imported one ("you imported 2025 already
 *        — re-import will only ADD missing rows").
 *     3. Lets the user see the history of which extracts they've
 *        imported.
 *
 *   Storage scoped per accountId so multiple TR accounts don't cross-
 *   contaminate.
 */

const STORAGE_KEY = "tr-pdf-converter:imported-periods:v1";
const MAX_ENTRIES = 100; // Bounded to prevent unbounded localStorage growth.

export interface ImportedPeriod {
  /** Donkeyfolio account ID (TR account). */
  accountId: string;
  /** ISO YYYY-MM-DD — first cash date in the imported PDF. */
  startDate: string;
  /** ISO YYYY-MM-DD — last cash date in the imported PDF. */
  endDate: string;
  /** Original PDF filename (for user reference). */
  fileName: string;
  /** ISO timestamp of when the import ran. */
  importedAt: string;
  /** How many activities the import created (informational). */
  activitiesCreated?: number;
}

interface PeriodStore {
  entries: ImportedPeriod[];
}

function loadStore(): PeriodStore {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { entries: [] };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.entries)) return parsed as PeriodStore;
    return { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function saveStore(store: PeriodStore): void {
  try {
    if (typeof localStorage === "undefined") return;
    // Bound size — keep most-recent N entries.
    const trimmed = store.entries
      .slice()
      .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))
      .slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: trimmed }));
  } catch {
    // localStorage full / blocked — silently skip; the worst that
    // happens is no overlap warning on next import.
  }
}

/**
 * Get all imported periods for one account, sorted descending by import
 * timestamp (most recent first). Empty array when nothing has been
 * imported yet.
 */
export function getImportedPeriods(accountId: string): ImportedPeriod[] {
  const store = loadStore();
  return store.entries
    .filter((e) => e.accountId === accountId)
    .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}

/**
 * Record a new import. Called after the import flow completes
 * successfully — the period will be available for overlap checks on
 * the next PDF drop.
 */
export function recordImport(period: ImportedPeriod): void {
  if (!period.accountId || !period.startDate || !period.endDate) return;
  const store = loadStore();
  store.entries.push(period);
  saveStore(store);
}

/**
 * Check whether a new period overlaps any already-imported period for
 * the same account. Returns the overlapping entries (if any). Empty
 * array means no overlap → safe to import without dedup concerns.
 *
 * Two periods overlap when neither one ends before the other begins.
 * E.g. [2024-01-01, 2024-12-31] overlaps [2024-06-01, 2025-05-31] but
 * NOT [2025-01-01, 2025-12-31] (boundary touch is not overlap).
 */
export function findOverlappingPeriods(
  accountId: string,
  start: string,
  end: string,
): ImportedPeriod[] {
  if (!start || !end) return [];
  const periods = getImportedPeriods(accountId);
  return periods.filter((p) => !(p.endDate < start || p.startDate > end));
}

/** Remove an entry by exact match — used by "I'm sure, import anyway" UX. */
export function clearImportedPeriod(accountId: string, fileName: string): void {
  const store = loadStore();
  store.entries = store.entries.filter(
    (e) => !(e.accountId === accountId && e.fileName === fileName),
  );
  saveStore(store);
}

/** Wipe all entries — useful when user wants to reset the history. */
export function clearAllImportedPeriods(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
