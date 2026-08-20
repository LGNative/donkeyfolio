-- Donkeyfolio · remove the worthless ENOVIX warrant entirely (user: "avança").
--
-- The warrant (ENVXW, asset c92e0a0e-d8bd-4430-9436-0bf246726375) was received
-- free and expired worthless: BUY 19.051312 @ €0 (2025-07-22) + SELL 19.051312
-- @ €0 (2025-09-30), net quantity 0, €0 value. Kept, it leaves a cosmetic
-- "Cost basis coverage is incomplete" flag (basis_status = PARTIAL_UNKNOWN on the
-- 70 held days, because a freely-received instrument has no known acquisition
-- cost). Deleting its two €0 activities + the €0 backfill quotes removes it
-- completely with ZERO impact (0 qty, €0 cash, no external flow, TWR unchanged).
-- The Rebuild regenerates snapshots/valuations without it. The (now inactive,
-- reference-free) asset row is left in place — harmless, not held, not flagged.
--
-- Run app-closed, then Rebuild Full History.

DELETE FROM quotes            WHERE asset_id = 'c92e0a0e-d8bd-4430-9436-0bf246726375';
DELETE FROM snapshot_positions WHERE asset_id = 'c92e0a0e-d8bd-4430-9436-0bf246726375';
DELETE FROM activities        WHERE asset_id = 'c92e0a0e-d8bd-4430-9436-0bf246726375';
