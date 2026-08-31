PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO sources (
  id, display_name, phase, access_mode, enabled, adapter_version, created_at, updated_at
) VALUES
  ('grants-gov', 'Grants.gov', 1, 'public', 1, 'fixture-v1', '2026-08-26T10:00:00.000Z', '2026-08-26T10:00:00.000Z'),
  ('ted', 'TED', 1, 'public', 1, 'fixture-v1', '2026-08-26T10:00:00.000Z', '2026-08-26T10:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  enabled = excluded.enabled,
  adapter_version = excluded.adapter_version,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO scan_runs (
  id, cycle_key, scheduled_for, started_at, completed_at, status, discovered_count, retained_count
) VALUES (
  'scan_fixture_2026_08_26_am',
  '2026-08-26:AM',
  '2026-08-26T10:00:00.000Z',
  '2026-08-26T10:00:00.000Z',
  '2026-08-26T10:02:14.000Z',
  'completed',
  6,
  6
);

INSERT OR IGNORE INTO source_runs (
  id, scan_run_id, source_id, started_at, completed_at, status,
  discovered_count, retained_count, excluded_count
) VALUES
  (
    'source_run_fixture_grants', 'scan_fixture_2026_08_26_am', 'grants-gov',
    '2026-08-26T10:00:01.000Z', '2026-08-26T10:01:12.000Z', 'completed', 3, 3, 0
  ),
  (
    'source_run_fixture_ted', 'scan_fixture_2026_08_26_am', 'ted',
    '2026-08-26T10:00:01.000Z', '2026-08-26T10:02:10.000Z', 'completed', 3, 3, 0
  );

INSERT OR IGNORE INTO technical_areas (id, taxonomy_version, name, parent_id, source_url) VALUES
  ('climate-and-environment', 1, 'Climate and Environment', NULL, 'https://example.test/taxonomy/climate-and-environment'),
  ('nature-oceans-and-biodiversity', 1, 'Nature, Oceans, and Biodiversity', 'climate-and-environment', 'https://example.test/taxonomy/nature-oceans-and-biodiversity'),
  ('digital', 1, 'Digital', NULL, 'https://example.test/taxonomy/digital'),
  ('digital-strategy-and-advisory', 1, 'Digital Strategy and Advisory', 'digital', 'https://example.test/taxonomy/digital-strategy-and-advisory'),
  ('economic-growth', 1, 'Economic Growth', NULL, 'https://example.test/taxonomy/economic-growth'),
  ('agriculture-and-market-systems', 1, 'Agriculture and Market Systems', 'economic-growth', 'https://example.test/taxonomy/agriculture-and-market-systems'),
  ('global-health', 1, 'Global Health', NULL, 'https://example.test/taxonomy/global-health'),
  ('health-systems', 1, 'Health Systems', 'global-health', 'https://example.test/taxonomy/health-systems');

INSERT OR IGNORE INTO bidding_events (
  id, source_id, scan_run_id, event_identity, content_fingerprint,
  source_event_id, source_opportunity_id, source_url, source_event_type, event_type,
  opportunity_name, description, client_name, place_of_performance, country_code,
  value_amount, value_currency, due_date, source_status, published_at, discovered_at,
  ocds_release_json, source_data_json, inherited_fields_json,
  addressability_status, addressability_score, addressability_config_version,
  addressability_evidence_json, technical_classification_version, technical_area_labels
) VALUES
  (
    'evt_fixture_digital_tender', 'grants-gov', 'scan_fixture_2026_08_26_am',
    'id:GRANT-2026-1042', 'fixture-digital-tender-v1', 'GRANT-2026-1042', 'OPP-DIGITAL-1042',
    'https://example.test/grants/GRANT-2026-1042', 'forecasted opportunity', 'tender',
    'Digital Public Infrastructure Advisory Services',
    'Technical assistance for a national digital government strategy and digital ecosystem assessment.',
    'Global Development Fund', 'Kenya', 'KE', 8500000, 'USD', '2026-09-30T17:00:00.000Z',
    'open', '2026-08-25T13:30:00.000Z', '2026-08-26T10:00:18.000Z',
    '{"ocid":"ocds-000000-grants-gov-fixture-1042","id":"grants-gov-fixture-1042-v1","date":"2026-08-25T13:30:00.000Z","tag":["tender"],"initiationType":"tender","tender":{"title":"Digital Public Infrastructure Advisory Services"}}',
    '{"fixture":true}', '[]', 'addressable', 14, 1,
    '[{"ruleId":"fixture-preferred-client","points":8},{"ruleId":"fixture-value-band","points":6}]',
    1, 'Digital Strategy and Advisory'
  ),
  (
    'evt_fixture_digital_modification', 'grants-gov', 'scan_fixture_2026_08_26_am',
    'id:GRANT-2026-1042-AMEND-1', 'fixture-digital-mod-v1', 'GRANT-2026-1042-AMEND-1', 'OPP-DIGITAL-1042',
    'https://example.test/grants/GRANT-2026-1042-amendment-1', 'amendment', 'modification',
    'Digital Public Infrastructure Advisory Services',
    'The response deadline was extended by one week.',
    'Global Development Fund', 'Kenya', 'KE', 8500000, 'USD', '2026-10-07T17:00:00.000Z',
    'open', '2026-08-26T08:45:00.000Z', '2026-08-26T10:00:20.000Z',
    '{"ocid":"ocds-000000-grants-gov-fixture-1042","id":"grants-gov-fixture-1042-mod-v1","date":"2026-08-26T08:45:00.000Z","tag":["tenderAmendment"],"initiationType":"tender","tender":{"title":"Digital Public Infrastructure Advisory Services"}}',
    '{"fixture":true}', '[{"field":"value","fromEventId":"evt_fixture_digital_tender"}]',
    'addressable', 14, 1,
    '[{"ruleId":"fixture-preferred-client","points":8},{"ruleId":"fixture-value-band","points":6}]',
    1, 'Digital Strategy and Advisory'
  ),
  (
    'evt_fixture_agriculture_tender', 'ted', 'scan_fixture_2026_08_26_am',
    'id:TED-2026-77821', 'fixture-agriculture-v1', 'TED-2026-77821', 'TED-OPP-77821',
    'https://example.test/ted/TED-2026-77821', 'contract notice', 'tender',
    'Resilient Agricultural Market Systems Programme',
    'Market systems development and climate-smart agriculture support for smallholder producers.',
    'European Cooperation Office', 'Tanzania', 'TZ', 12750000, 'EUR', '2026-10-18T12:00:00.000Z',
    'active', '2026-08-24T09:00:00.000Z', '2026-08-26T10:00:22.000Z',
    '{"ocid":"ocds-000000-ted-fixture-77821","id":"ted-fixture-77821-v1","date":"2026-08-24T09:00:00.000Z","tag":["tender"],"initiationType":"tender","tender":{"title":"Resilient Agricultural Market Systems Programme"}}',
    '{"fixture":true}', '[]', 'addressable', 12, 1,
    '[{"ruleId":"fixture-preferred-client","points":7},{"ruleId":"fixture-value-band","points":5}]',
    1, 'Agriculture and Market Systems'
  ),
  (
    'evt_fixture_health_tender', 'grants-gov', 'scan_fixture_2026_08_26_am',
    'id:GRANT-2026-0817', 'fixture-health-v1', 'GRANT-2026-0817', 'OPP-HEALTH-0817',
    'https://example.test/grants/GRANT-2026-0817', 'grant opportunity', 'tender',
    'District Health Systems Strengthening Activity',
    'Support for primary care governance, health workforce planning, and service quality.',
    'International Health Partnership', 'Uganda', 'UG', NULL, NULL, '2026-09-22T16:00:00.000Z',
    'open', '2026-08-23T15:15:00.000Z', '2026-08-26T10:00:24.000Z',
    '{"ocid":"ocds-000000-grants-gov-fixture-0817","id":"grants-gov-fixture-0817-v1","date":"2026-08-23T15:15:00.000Z","tag":["tender"],"initiationType":"tender","tender":{"title":"District Health Systems Strengthening Activity"}}',
    '{"fixture":true}', '[]', 'uncertain', 4, 1,
    '[{"ruleId":"fixture-sector-fit","points":4}]',
    1, 'Health Systems'
  ),
  (
    'evt_fixture_climate_cancel', 'ted', 'scan_fixture_2026_08_26_am',
    'id:TED-2026-60118-CANCEL', 'fixture-climate-cancel-v1', 'TED-2026-60118-CANCEL', 'TED-OPP-60118',
    'https://example.test/ted/TED-2026-60118-cancellation', 'contract award cancellation', 'cancellation',
    'Coastal Biodiversity and Protected Areas Support',
    'The procurement procedure has been cancelled by the buyer.',
    'Regional Climate Facility', 'Mozambique', 'MZ', 4200000, 'EUR', NULL,
    'cancelled', '2026-08-26T07:20:00.000Z', '2026-08-26T10:00:26.000Z',
    '{"ocid":"ocds-000000-ted-fixture-60118","id":"ted-fixture-60118-cancel-v1","date":"2026-08-26T07:20:00.000Z","tag":["tenderCancellation"],"initiationType":"tender","tender":{"title":"Coastal Biodiversity and Protected Areas Support","status":"cancelled"}}',
    '{"fixture":true}', '[{"field":"value","fromEventId":"evt_fixture_climate_tender_prior"}]',
    'addressable', 10, 1,
    '[{"ruleId":"fixture-preferred-client","points":6},{"ruleId":"fixture-sector-fit","points":4}]',
    1, 'Nature, Oceans, and Biodiversity'
  ),
  (
    'evt_fixture_unclassified_tender', 'ted', 'scan_fixture_2026_08_26_am',
    'id:TED-2026-88002', 'fixture-unclassified-v1', 'TED-2026-88002', 'TED-OPP-88002',
    'https://example.test/ted/TED-2026-88002', 'prior information notice', 'tender',
    'Framework Agreement for General Advisory Support',
    NULL, 'Municipal Services Agency', NULL, NULL, 950000, 'GBP', NULL,
    'planned', '2026-08-22T11:00:00.000Z', '2026-08-26T10:00:28.000Z',
    '{"ocid":"ocds-000000-ted-fixture-88002","id":"ted-fixture-88002-v1","date":"2026-08-22T11:00:00.000Z","tag":["tender"],"initiationType":"tender","tender":{"title":"Framework Agreement for General Advisory Support"}}',
    '{"fixture":true}', '[]', 'uncertain', 0, 1, '[]', 1, 'Unclassified'
  );

INSERT OR IGNORE INTO bidding_event_technical_areas (
  bidding_event_id, technical_area_id, score, evidence_json
) VALUES
  ('evt_fixture_digital_tender', 'digital-strategy-and-advisory', 6, '["digital strategy","digital ecosystem assessment"]'),
  ('evt_fixture_digital_modification', 'digital-strategy-and-advisory', 6, '["inherited from evt_fixture_digital_tender"]'),
  ('evt_fixture_agriculture_tender', 'agriculture-and-market-systems', 9, '["market systems development","climate smart agriculture"]'),
  ('evt_fixture_health_tender', 'health-systems', 3, '["health systems"]'),
  ('evt_fixture_climate_cancel', 'nature-oceans-and-biodiversity', 6, '["biodiversity","protected areas"]');
