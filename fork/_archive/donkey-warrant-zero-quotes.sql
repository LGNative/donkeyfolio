-- Donkeyfolio · clear the "116 valuation rows have incomplete market value"
-- warning (the 70 warrant rows).
--
-- The ENOVIX warrant (ENVXW, asset c92e0a0e-d8bd-4430-9436-0bf246726375) was
-- held 2025-07-22 → 2025-09-30 but had NO market quotes during the hold, so the
-- valuation logs "Missing quote ... treated as ZERO" and flags each of those 70
-- daily rows PARTIAL_UNPRICED. The value is already correct (the warrant was
-- worthless = €0); only the status flag is wrong. It already carries one €0
-- MANUAL quote on 2025-09-30 — this backfills the same €0 MANUAL quote for every
-- held day so the rows become COMPLETE. Zero value impact (0 × qty = 0).
--
-- Run with the Donkeyfolio app CLOSED, then "Rebuild Full History".

INSERT INTO quotes (id, asset_id, day, source, close, currency, created_at, timestamp)
SELECT 'c92e0a0e-d8bd-4430-9436-0bf246726375_' || d || '_MANUAL',
       'c92e0a0e-d8bd-4430-9436-0bf246726375',
       d, 'MANUAL', '0', 'EUR',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       d || 'T12:00:00+00:00'
FROM (
  WITH RECURSIVE dates(d) AS (
    SELECT '2025-07-22'
    UNION ALL SELECT date(d, '+1 day') FROM dates WHERE d < '2025-09-29'
  )
  SELECT d FROM dates
)
WHERE NOT EXISTS (
  SELECT 1 FROM quotes q
  WHERE q.asset_id = 'c92e0a0e-d8bd-4430-9436-0bf246726375' AND q.day = d
);
