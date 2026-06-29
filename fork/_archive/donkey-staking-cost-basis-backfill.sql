-- Donkeyfolio · backfill crypto staking-reward cost basis.
--
-- TR ships the FMV of each Saveback / staking reward; the importer kept it in
-- metadata (tr_fmv_at_receipt) but booked the reward as a zero-cost TRANSFER_IN.
-- So each reward's whole value read as gain and v3.5.3's data-health check
-- flags those positions (ADA / ETH / SOL) as "incomplete cost basis".
--
-- This sets unit_price = that stored FMV for the existing reward lots, giving
-- each a real cost basis (~EUR 116 of phantom gain removed). The cost-basis
-- check reads unit_price (core/health/service.rs).
--
-- Safe + re-runnable: only touches tr_staking rows that still have no price.
-- Run with the Donkeyfolio app CLOSED, then run "Rebuild History" in the app:
--   sqlite3 "~/Library/Application Support/com.luisgoncalves.donkeyfolio/app.db" \
--     < fork/_archive/donkey-staking-cost-basis-backfill.sql
--
-- The importer itself is already fixed (mapFreeReceipt now sets unitPrice=FMV),
-- so future imports won't need this.

UPDATE activities
SET unit_price = CAST(json_extract(metadata, '$.tr_fmv_at_receipt') AS TEXT),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE json_extract(metadata, '$.tr_staking') = 1
  AND json_extract(metadata, '$.tr_fmv_at_receipt') IS NOT NULL
  AND (unit_price IS NULL OR CAST(unit_price AS REAL) = 0);

-- Verify (optional): should report 0 rows after a successful run.
-- SELECT COUNT(*) FROM activities
--  WHERE json_extract(metadata,'$.tr_staking')=1
--    AND (unit_price IS NULL OR CAST(unit_price AS REAL)=0);
