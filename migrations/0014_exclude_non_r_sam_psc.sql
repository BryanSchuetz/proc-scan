PRAGMA foreign_keys = ON;

DELETE FROM digest_items
WHERE bidding_event_id IN (
  SELECT id
  FROM bidding_events
  WHERE source_id = 'sam-gov'
    AND COALESCE(TRIM(json_extract(source_data_json, '$.classificationCode')), '') <> ''
    AND UPPER(SUBSTR(TRIM(json_extract(source_data_json, '$.classificationCode')), 1, 1)) <> 'R'
);

DELETE FROM bidding_events
WHERE source_id = 'sam-gov'
  AND COALESCE(TRIM(json_extract(source_data_json, '$.classificationCode')), '') <> ''
  AND UPPER(SUBSTR(TRIM(json_extract(source_data_json, '$.classificationCode')), 1, 1)) <> 'R';
