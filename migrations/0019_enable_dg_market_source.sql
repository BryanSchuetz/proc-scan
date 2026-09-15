PRAGMA foreign_keys = ON;

INSERT INTO sources (
  id, display_name, phase, access_mode, enabled, adapter_version, created_at, updated_at
) VALUES (
  'dg-market-eu-archive', 'dgMarket (legacy EU scope)', 1, 'public', 0, '1.0.0',
  '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z'
);

UPDATE bidding_events
SET source_id = 'dg-market-eu-archive'
WHERE source_id = 'dg-market'
  AND json_extract(source_data_json, '$.clientCohort') = 'eu-member-state-government';

UPDATE sources
SET enabled = 1,
    adapter_version = '1.1.0',
    updated_at = '2026-09-15T00:00:00.000Z'
WHERE id = 'dg-market';
