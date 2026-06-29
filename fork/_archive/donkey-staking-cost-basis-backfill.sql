-- Donkeyfolio · re-type existing crypto staking rewards to income (juros).
--
-- TR Saveback / staking rewards ARE income paid in crypto. The importer had
-- booked them as zero-cost TRANSFER_IN, so they read as 100% gain and v3.5.3
-- flags the positions (ADA / ETH / SOL) as "incomplete cost basis".
--
-- This re-types the existing reward rows to INTEREST + subtype STAKING_REWARD
-- and sets unit_price = the FMV already kept in metadata (tr_fmv_at_receipt).
-- On the next **Rebuild History**, the core compiler (compiler.rs
-- compile_staking_reward) expands each into:
--    • INTEREST  → the reward recognised as income (juros), amount = qty × FMV
--    • BUY       → the token lot acquired at FMV (real cost basis)
-- So the rewards finally show as income AND the crypto carries a correct cost
-- basis — no re-import needed.
--
-- Safe + re-runnable (only touches tr_staking TRANSFER_IN rows). Run with the
-- Donkeyfolio app CLOSED, then run "Rebuild History" in the app:
--   sqlite3 "~/Library/Application Support/com.luisgoncalves.donkeyfolio/app.db" \
--     < fork/_archive/donkey-staking-cost-basis-backfill.sql
--
-- The importer (mapFreeReceipt) now books new staking rewards this way too.

UPDATE activities
SET activity_type = 'INTEREST',
    subtype       = 'STAKING_REWARD',
    unit_price    = CAST(json_extract(metadata, '$.tr_fmv_at_receipt') AS TEXT),
    updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE json_extract(metadata, '$.tr_staking') = 1
  AND json_extract(metadata, '$.tr_fmv_at_receipt') IS NOT NULL
  AND activity_type = 'TRANSFER_IN';

-- Verify (optional): should report 0 rows after a successful run.
-- SELECT COUNT(*) FROM activities
--  WHERE json_extract(metadata,'$.tr_staking')=1 AND activity_type='TRANSFER_IN';
