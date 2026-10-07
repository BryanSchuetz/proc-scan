ALTER TABLE bidding_events ADD COLUMN manual_addressability_status TEXT
  CHECK (manual_addressability_status IN ('addressable', 'uncertain'));
ALTER TABLE bidding_events ADD COLUMN manually_marked_by TEXT;
ALTER TABLE bidding_events ADD COLUMN manually_marked_at TEXT;
