-- Donkeyfolio · one-off cleanup: remove orphaned portfolio snapshots
-- left behind by a DELETED account (0 activities, no row in `accounts`).
-- These accumulate ~300 MB of dead snapshot cache and slow every query/startup.
--
-- Generic + safe: targets ONLY account_ids that no longer exist in `accounts`,
-- so the live Trade Republic account is never touched. No hardcoded ids.
--
-- Run with the Donkeyfolio app CLOSED (the DB must not be in use):
--   sqlite3 "~/Library/Application Support/com.luisgoncalves.donkeyfolio/app.db" \
--     < fork/_archive/donkey-orphan-snapshot-cleanup.sql
--
-- Re-runnable: a no-op once there are no orphans.

-- 1) child rows first (snapshot_positions references holdings_snapshots.id)
DELETE FROM snapshot_positions
 WHERE snapshot_id IN (
   SELECT id FROM holdings_snapshots
    WHERE account_id NOT IN (SELECT id FROM accounts)
 );

-- 2) the orphaned daily snapshots themselves (~759 KB each)
DELETE FROM holdings_snapshots
 WHERE account_id NOT IN (SELECT id FROM accounts);

-- 3) orphaned per-day account valuations
DELETE FROM daily_account_valuation
 WHERE account_id NOT IN (SELECT id FROM accounts);

-- 4) reclaim the freed pages → the .db file actually shrinks
VACUUM;
