PRAGMA foreign_keys = ON;

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  phase INTEGER NOT NULL CHECK (phase IN (1, 2, 3)),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('public', 'api-key', 'login', 'two-factor')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  adapter_version TEXT NOT NULL,
  cursor_json TEXT,
  reauthentication_required INTEGER NOT NULL DEFAULT 0 CHECK (reauthentication_required IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  cycle_key TEXT NOT NULL UNIQUE,
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed', 'skipped')),
  discovered_count INTEGER NOT NULL DEFAULT 0,
  retained_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE TABLE source_runs (
  id TEXT PRIMARY KEY,
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'reauthentication_required')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  cursor_before_json TEXT,
  cursor_after_json TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  retained_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  UNIQUE (scan_run_id, source_id)
);

CREATE TABLE bidding_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(id),
  event_identity TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  source_event_id TEXT,
  source_opportunity_id TEXT,
  source_url TEXT NOT NULL,
  source_event_type TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('tender', 'modification', 'cancellation')),
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

CREATE INDEX bidding_events_discovered_at_idx ON bidding_events(discovered_at DESC);
CREATE INDEX bidding_events_event_type_idx ON bidding_events(event_type);
CREATE INDEX bidding_events_addressability_status_idx ON bidding_events(addressability_status);
CREATE INDEX bidding_events_client_name_idx ON bidding_events(client_name);
CREATE INDEX bidding_events_source_opportunity_idx ON bidding_events(source_id, source_opportunity_id, published_at DESC);
CREATE INDEX bidding_events_due_date_idx ON bidding_events(due_date);

CREATE TABLE technical_areas (
  id TEXT PRIMARY KEY,
  taxonomy_version INTEGER NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES technical_areas(id),
  source_url TEXT
);

CREATE TABLE bidding_event_technical_areas (
  bidding_event_id TEXT NOT NULL REFERENCES bidding_events(id) ON DELETE CASCADE,
  technical_area_id TEXT NOT NULL REFERENCES technical_areas(id),
  score REAL NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  PRIMARY KEY (bidding_event_id, technical_area_id)
);

CREATE INDEX bidding_event_technical_areas_area_idx
  ON bidding_event_technical_areas(technical_area_id, bidding_event_id);

CREATE TABLE digests (
  id TEXT PRIMARY KEY,
  scan_run_id TEXT NOT NULL UNIQUE REFERENCES scan_runs(id),
  content_fingerprint TEXT NOT NULL,
  provider TEXT,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'skipped_empty', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE bidding_events_fts USING fts5(
  opportunity_name,
  description,
  client_name,
  place_of_performance,
  technical_area_labels,
  content='bidding_events',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER bidding_events_fts_insert AFTER INSERT ON bidding_events BEGIN
  INSERT INTO bidding_events_fts(
    rowid,
    opportunity_name,
    description,
    client_name,
    place_of_performance,
    technical_area_labels
  ) VALUES (
    new.rowid,
    new.opportunity_name,
    new.description,
    new.client_name,
    new.place_of_performance,
    new.technical_area_labels
  );
END;

CREATE TRIGGER bidding_events_fts_delete AFTER DELETE ON bidding_events BEGIN
  INSERT INTO bidding_events_fts(
    bidding_events_fts,
    rowid,
    opportunity_name,
    description,
    client_name,
    place_of_performance,
    technical_area_labels
  ) VALUES (
    'delete',
    old.rowid,
    old.opportunity_name,
    old.description,
    old.client_name,
    old.place_of_performance,
    old.technical_area_labels
  );
END;

CREATE TRIGGER bidding_events_fts_update AFTER UPDATE ON bidding_events BEGIN
  INSERT INTO bidding_events_fts(
    bidding_events_fts,
    rowid,
    opportunity_name,
    description,
    client_name,
    place_of_performance,
    technical_area_labels
  ) VALUES (
    'delete',
    old.rowid,
    old.opportunity_name,
    old.description,
    old.client_name,
    old.place_of_performance,
    old.technical_area_labels
  );
  INSERT INTO bidding_events_fts(
    rowid,
    opportunity_name,
    description,
    client_name,
    place_of_performance,
    technical_area_labels
  ) VALUES (
    new.rowid,
    new.opportunity_name,
    new.description,
    new.client_name,
    new.place_of_performance,
    new.technical_area_labels
  );
END;
