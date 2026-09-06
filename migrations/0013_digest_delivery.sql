PRAGMA foreign_keys = ON;

CREATE TABLE digest_items (
  digest_id TEXT NOT NULL REFERENCES digests(id) ON DELETE CASCADE,
  bidding_event_id TEXT NOT NULL REFERENCES bidding_events(id),
  PRIMARY KEY (digest_id, bidding_event_id)
);

CREATE INDEX digest_items_event_idx
  ON digest_items(bidding_event_id);
