import type { SourceCandidate } from "../sources/adapter";
import type { UploadSummary } from "../api/types";

export async function listUploads(db: D1Database): Promise<UploadSummary[]> {
  const rows = await db.prepare(`SELECT u.id, u.filename, u.source_id AS sourceId,
    s.display_name AS sourceName, u.created_at AS createdAt, u.row_count AS rowCount,
    CASE WHEN u.processed_at IS NOT NULL THEN 'processed'
      WHEN r.status = 'running' THEN 'processing' ELSE 'queued' END AS status,
    u.retained_count AS retainedCount, u.excluded_count AS excludedCount,
    u.duplicate_count AS duplicateCount
    FROM opportunity_uploads u JOIN sources s ON s.id = u.source_id
    LEFT JOIN scan_runs r ON r.id = u.scan_run_id
    ORDER BY u.created_at DESC, u.id LIMIT 30`).all<UploadSummary>();
  return rows.results;
}

export async function queueUpload(db: D1Database, upload: {
  id: string; sourceId: string; filename: string; uploadedBy?: string; candidates: SourceCandidate[];
}): Promise<boolean> {
  const result = await db.prepare(`INSERT OR IGNORE INTO opportunity_uploads
    (id, source_id, filename, created_at, uploaded_by, candidates_json, row_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
    upload.id, upload.sourceId, upload.filename, new Date().toISOString(),
    upload.uploadedBy ?? null, JSON.stringify(upload.candidates), upload.candidates.length,
  ).run();
  return result.meta.changes === 1;
}

// Claim a fixed snapshot. Later uploads wait for the next scan, and overlapping scans
// cannot consume the same file. Unfinished files from a failed scan remain retryable.
export async function claimUploadsForScan(db: D1Database, scanRunId: string, cutoff: string): Promise<string[]> {
  await db.prepare(`UPDATE opportunity_uploads SET scan_run_id = ?
    WHERE processed_at IS NULL AND created_at <= ?
      AND (scan_run_id IS NULL OR scan_run_id IN
        (SELECT id FROM scan_runs WHERE status IN ('failed', 'partial', 'completed')))`)
    .bind(scanRunId, cutoff).run();
  const result = await db.prepare(`SELECT DISTINCT source_id FROM opportunity_uploads
    WHERE scan_run_id = ? ORDER BY source_id`).bind(scanRunId).all<{ source_id: string }>();
  return result.results.map((row) => row.source_id);
}
