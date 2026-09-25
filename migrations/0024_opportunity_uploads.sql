CREATE TABLE opportunity_uploads (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL,
  uploaded_by TEXT,
  candidates_json TEXT NOT NULL CHECK (json_valid(candidates_json)),
  row_count INTEGER NOT NULL,
  scan_run_id TEXT REFERENCES scan_runs(id),
  processed_at TEXT,
  retained_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX opportunity_uploads_pending_idx
  ON opportunity_uploads(processed_at, created_at);
