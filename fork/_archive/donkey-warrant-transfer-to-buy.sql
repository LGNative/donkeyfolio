-- Donkeyfolio · Performance chart fix (user-approved: "dá zero não tem impacto").
--
-- ROOT CAUSE of the broken Performance page (TWR = N/A, portfolio line "not
-- plotted"): the ENOVIX warrant (ENVXW, ISIN US2935941318) was received free on
-- 2025-07-22 as a STOCK_DIVIDEND and mapped to a TRANSFER_IN. The performance
-- engine cannot resolve that single, unpaired transfer's portfolio boundary and
-- stores the 2025-07-22 daily valuation row as `UNKNOWN_BOUNDARY_TRANSFER`.
-- `ExternalFlowSource::UnknownBoundaryTransfer.is_unavailable_for_returns()` is
-- true, so TWR is marked "unavailable for 2025-07-22" and the whole portfolio
-- return series won't plot. Marking the transfer `metadata.flow.is_external=true`
-- did NOT help — a full "Rebuild Full History" still produced
-- UNKNOWN_BOUNDARY_TRANSFER (the flag is not honored for an unpaired single-
-- account transfer; upstream engine limitation).
--
-- FIX: convert the free receipt from TRANSFER_IN to a zero-cost BUY. A BUY is an
-- internal flow (flow_classifier: "everything else is internal"), so it never
-- blocks TWR. Net effect is unchanged: BUY 19.051312 @ €0 then the existing
-- SELL 19.051312 @ €0 (2025-09-30) => net quantity 0, €0 cost, €0 proceeds.
-- The warrant is already is_active=0 and worthless, so this only removes the
-- boundary ambiguity — no value/holdings impact.
--
-- Run with the Donkeyfolio app CLOSED, then "Rebuild Full History".

UPDATE activities
SET activity_type = 'BUY',
    unit_price    = '0',
    amount        = '0',
    updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = '92b28f1c-6f4e-436c-a9cd-675aeb7f30d6'
  AND activity_type = 'TRANSFER_IN'
  AND asset_id = (SELECT id FROM assets WHERE display_code = 'US2935941318');
