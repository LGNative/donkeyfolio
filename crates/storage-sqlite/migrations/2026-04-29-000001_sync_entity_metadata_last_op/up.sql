ALTER TABLE sync_entity_metadata ADD COLUMN last_op TEXT NOT NULL DEFAULT 'update';

UPDATE sync_entity_metadata
SET last_op = COALESCE(
    (
        SELECT sync_outbox.op
        FROM sync_outbox
        WHERE sync_outbox.event_id = sync_entity_metadata.last_event_id
        LIMIT 1
    ),
    last_op
);

INSERT INTO sync_entity_metadata (
    entity,
    entity_id,
    last_event_id,
    last_client_timestamp,
    last_op,
    last_seq
)
SELECT
    latest.entity,
    latest.entity_id,
    latest.event_id,
    latest.client_timestamp,
    latest.op,
    0
FROM sync_outbox AS latest
WHERE latest.event_id = (
    SELECT candidate.event_id
    FROM sync_outbox AS candidate
    WHERE candidate.entity = latest.entity
      AND candidate.entity_id = latest.entity_id
    ORDER BY candidate.client_timestamp DESC, candidate.event_id DESC
    LIMIT 1
)
ON CONFLICT(entity, entity_id) DO UPDATE SET
    last_event_id = excluded.last_event_id,
    last_client_timestamp = excluded.last_client_timestamp,
    last_op = excluded.last_op,
    last_seq = sync_entity_metadata.last_seq
WHERE excluded.last_client_timestamp > sync_entity_metadata.last_client_timestamp
   OR (
       excluded.last_client_timestamp = sync_entity_metadata.last_client_timestamp
       AND excluded.last_event_id > sync_entity_metadata.last_event_id
   );

-- Older metadata rows did not store the last operation. Rows whose entity no
-- longer exists are tombstones, including remote-pulled deletes that never had
-- a local sync_outbox entry to join above.
UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'account'
  AND NOT EXISTS (SELECT 1 FROM "accounts" WHERE "accounts"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'asset'
  AND NOT EXISTS (SELECT 1 FROM "assets" WHERE "assets"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'quote'
  AND NOT EXISTS (SELECT 1 FROM "quotes" WHERE "quotes"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'asset_taxonomy_assignment'
  AND NOT EXISTS (SELECT 1 FROM "asset_taxonomy_assignments" WHERE "asset_taxonomy_assignments"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'activity'
  AND NOT EXISTS (SELECT 1 FROM "activities" WHERE "activities"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'activity_import_profile'
  AND NOT EXISTS (SELECT 1 FROM "import_account_templates" WHERE "import_account_templates"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'import_template'
  AND NOT EXISTS (SELECT 1 FROM "import_templates" WHERE "import_templates"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'goal'
  AND NOT EXISTS (SELECT 1 FROM "goals" WHERE "goals"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'goal_plan'
  AND NOT EXISTS (SELECT 1 FROM "goal_plans" WHERE "goal_plans"."goal_id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'goals_allocation'
  AND NOT EXISTS (SELECT 1 FROM "goals_allocation" WHERE "goals_allocation"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'ai_thread'
  AND NOT EXISTS (SELECT 1 FROM "ai_threads" WHERE "ai_threads"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'ai_message'
  AND NOT EXISTS (SELECT 1 FROM "ai_messages" WHERE "ai_messages"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'ai_thread_tag'
  AND NOT EXISTS (SELECT 1 FROM "ai_thread_tags" WHERE "ai_thread_tags"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'contribution_limit'
  AND NOT EXISTS (SELECT 1 FROM "contribution_limits" WHERE "contribution_limits"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'platform'
  AND NOT EXISTS (SELECT 1 FROM "platforms" WHERE "platforms"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'snapshot'
  AND NOT EXISTS (SELECT 1 FROM "holdings_snapshots" WHERE "holdings_snapshots"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'custom_provider'
  AND NOT EXISTS (SELECT 1 FROM "market_data_custom_providers" WHERE "market_data_custom_providers"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'custom_taxonomy'
  AND NOT EXISTS (SELECT 1 FROM "taxonomies" WHERE "taxonomies"."id" = sync_entity_metadata.entity_id);

UPDATE sync_entity_metadata
SET last_op = 'delete'
WHERE entity = 'import_run'
  AND NOT EXISTS (SELECT 1 FROM "import_runs" WHERE "import_runs"."id" = sync_entity_metadata.entity_id);
