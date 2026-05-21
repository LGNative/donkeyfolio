/**
 * Incremental-import dedup for the TR Importer.
 *
 * The TR CSV ships a globally-unique `transaction_id` (UUID) per row —
 * verified 4222/4222 unique on a real full history. We use it as the dedup
 * key: on each import we skip rows whose id is already in localStorage,
 * then add the newly-imported ids back to the set.
 *
 * Storage layout:
 *   localStorage["tr-importer:v1:imported-tx-ids"] = JSON.stringify(string[])
 *
 * The list is plain JSON (not a Set) so it survives page reloads and is
 * trivially debuggable in DevTools. We bound growth at MAX_IDS items —
 * 4222 transactions over 2 years is ~6,500 expected lifetime, comfortably
 * under the cap. When/if we exceed MAX_IDS, the OLDEST half is evicted
 * (FIFO via insertion order). The user would re-confirm any older
 * imports manually if that ever happens — extremely unlikely.
 *
 * No external dependencies, no SDK calls — pure browser storage.
 */

const STORAGE_KEY = "tr-importer:v1:imported-tx-ids";
const MAX_IDS = 50_000;

export interface ImportHistory {
  ids: Set<string>;
  raw: string[];
}

/** Load the set of already-imported transaction ids. Returns empty when
 *  storage is unavailable (e.g. SSR) or the value is malformed. */
export function loadImportHistory(): ImportHistory {
  if (typeof localStorage === "undefined") return { ids: new Set(), raw: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ids: new Set(), raw: [] };
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return { ids: new Set(), raw: [] };
    const filtered = arr.filter((x): x is string => typeof x === "string");
    return { ids: new Set(filtered), raw: filtered };
  } catch {
    return { ids: new Set(), raw: [] };
  }
}

/** Add new ids to the persisted set. Idempotent — duplicates are
 *  automatically de-duped. Trims to MAX_IDS keeping the most recently
 *  added entries. */
export function recordImported(newIds: string[]): void {
  if (typeof localStorage === "undefined") return;
  if (newIds.length === 0) return;
  const { raw } = loadImportHistory();
  const seen = new Set(raw);
  const out = [...raw];
  for (const id of newIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  // Trim oldest half if we ever blow the cap.
  const trimmed = out.length > MAX_IDS ? out.slice(out.length - Math.floor(MAX_IDS / 2)) : out;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota / privacy mode — fail silently. The import still succeeds; only
    // future incremental dedup will not skip this batch.
  }
}

/** Clear all stored ids. Exposed for the UI's "Reset import history"
 *  action so the user can force a full re-import. */
export function clearImportHistory(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/** Partition a list of transaction ids into "already imported" vs "new". */
export function partitionByHistory<T extends { transactionId: string }>(
  rows: T[],
  history: ImportHistory,
): { newRows: T[]; alreadyImported: T[] } {
  const newRows: T[] = [];
  const alreadyImported: T[] = [];
  for (const r of rows) {
    if (r.transactionId && history.ids.has(r.transactionId)) {
      alreadyImported.push(r);
    } else {
      newRows.push(r);
    }
  }
  return { newRows, alreadyImported };
}
