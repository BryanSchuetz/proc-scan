-- EBRD moved its procurement to GEP SMART. Keep the Source ID so existing
-- events, uploads, and addressability rules carry over.
UPDATE sources
SET display_name = 'EBRD GEP SMART',
    phase = 2,
    access_mode = 'login',
    adapter_version = '2.0.0',
    updated_at = '2026-11-05T00:00:00.000Z'
WHERE id = 'ecepp';
