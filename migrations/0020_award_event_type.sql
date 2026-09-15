PRAGMA defer_foreign_keys = ON;

DROP TRIGGER bidding_events_fts_insert;
DROP TRIGGER bidding_events_fts_delete;
DROP TRIGGER bidding_events_fts_update;

CREATE TABLE bidding_events_with_awards (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(id),
  event_identity TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  source_event_id TEXT,
  source_opportunity_id TEXT,
  source_url TEXT NOT NULL,
  source_event_type TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('tender', 'modification', 'award', 'cancellation')),
  opportunity_name TEXT NOT NULL,
  description TEXT,
  client_name TEXT,
  funder_names_json TEXT NOT NULL DEFAULT '[]',
  procuring_entity_name TEXT,
  implementing_entity_names_json TEXT NOT NULL DEFAULT '[]',
  place_of_performance TEXT,
  country_code TEXT,
  value_amount REAL,
  value_currency TEXT,
  due_date TEXT,
  eligibility TEXT,
  source_status TEXT,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  ocds_release_json TEXT NOT NULL CHECK (json_valid(ocds_release_json)),
  source_data_json TEXT NOT NULL CHECK (json_valid(source_data_json)),
  inherited_fields_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(inherited_fields_json)),
  addressability_status TEXT NOT NULL CHECK (addressability_status IN ('addressable', 'uncertain')),
  addressability_score REAL NOT NULL,
  addressability_config_version INTEGER NOT NULL,
  addressability_evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(addressability_evidence_json)),
  technical_classification_version INTEGER NOT NULL,
  technical_area_labels TEXT NOT NULL DEFAULT '',
  UNIQUE (source_id, event_identity, content_fingerprint)
);

INSERT INTO bidding_events_with_awards SELECT * FROM bidding_events;
DROP TABLE bidding_events;
ALTER TABLE bidding_events_with_awards RENAME TO bidding_events;

CREATE INDEX bidding_events_discovered_at_idx ON bidding_events(discovered_at DESC);
CREATE INDEX bidding_events_event_type_idx ON bidding_events(event_type);
CREATE INDEX bidding_events_addressability_status_idx ON bidding_events(addressability_status);
CREATE INDEX bidding_events_client_name_idx ON bidding_events(client_name);
CREATE INDEX bidding_events_source_opportunity_idx
  ON bidding_events(source_id, source_opportunity_id, published_at DESC);
CREATE INDEX bidding_events_due_date_idx ON bidding_events(due_date);

CREATE TRIGGER bidding_events_fts_insert AFTER INSERT ON bidding_events BEGIN
  INSERT INTO bidding_events_fts(
    rowid, opportunity_name, description, client_name, place_of_performance, technical_area_labels
  ) VALUES (
    new.rowid, new.opportunity_name, new.description, new.client_name,
    new.place_of_performance, new.technical_area_labels
  );
END;

CREATE TRIGGER bidding_events_fts_delete AFTER DELETE ON bidding_events BEGIN
  INSERT INTO bidding_events_fts(
    bidding_events_fts, rowid, opportunity_name, description, client_name,
    place_of_performance, technical_area_labels
  ) VALUES (
    'delete', old.rowid, old.opportunity_name, old.description, old.client_name,
    old.place_of_performance, old.technical_area_labels
  );
END;

CREATE TRIGGER bidding_events_fts_update AFTER UPDATE ON bidding_events BEGIN
  INSERT INTO bidding_events_fts(
    bidding_events_fts, rowid, opportunity_name, description, client_name,
    place_of_performance, technical_area_labels
  ) VALUES (
    'delete', old.rowid, old.opportunity_name, old.description, old.client_name,
    old.place_of_performance, old.technical_area_labels
  );
  INSERT INTO bidding_events_fts(
    rowid, opportunity_name, description, client_name, place_of_performance, technical_area_labels
  ) VALUES (
    new.rowid, new.opportunity_name, new.description, new.client_name,
    new.place_of_performance, new.technical_area_labels
  );
END;

INSERT INTO bidding_events_fts(bidding_events_fts) VALUES('rebuild');

PRAGMA defer_foreign_keys = OFF;
