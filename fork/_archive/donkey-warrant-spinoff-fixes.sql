-- Donkeyfolio · one-off data corrections (user-approved "tudo perfeito").
--
-- 1) ENOVIX warrant (ISIN-as-symbol US2935941318): received free, expired
--    WORTHLESS, net quantity = 0. A closed/defunct position — mark it inactive
--    so it drops out of the held-asset health checks (outdated price /
--    performance flow boundary / incomplete cost basis). Guarded on net qty = 0.
--
-- 2) Solstice (SOLS) spin-off TRANSFER_IN (0.404784 sh on 2025-10-30) carried no
--    cost basis (TR ships none for spin-offs). Set unit_price to the EUR FMV
--    around the spin-off (EUR 41.83 — the user's own first SOLS buy days later;
--    the 2025-10-31 USD quote $45.07 ~= EUR 41.7). The 0.4 spin-off shares then
--    match the ~11 bought shares (~EUR 41 avg). Approximation; the exact
--    Honeywell parent-basis allocation isn't shipped by TR.
--
-- Run with the Donkeyfolio app CLOSED, then "Rebuild History".

UPDATE assets
SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE display_code = 'US2935941318'
  AND (SELECT SUM(CASE WHEN activity_type IN ('BUY','TRANSFER_IN')  THEN quantity
                       WHEN activity_type IN ('SELL','TRANSFER_OUT') THEN -quantity
                       ELSE 0 END)
       FROM activities WHERE asset_id = assets.id) = 0;

UPDATE activities
SET unit_price = '41.83', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE activity_type = 'TRANSFER_IN'
  AND asset_id = (SELECT id FROM assets WHERE display_code = 'SOLS')
  AND (unit_price IS NULL OR CAST(unit_price AS REAL) = 0);
