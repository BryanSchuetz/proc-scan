import type { SourceCandidate } from "../sources/adapter";
import { processSourceCandidates, type SourceProcessingResult } from "./run-source";

export async function runQueuedUploads(
  context: Parameters<typeof processSourceCandidates>[0],
): Promise<SourceProcessingResult> {
  const uploads = await context.db.prepare(`SELECT id, filename, processed_at,
      row_count, retained_count, excluded_count, duplicate_count
    FROM opportunity_uploads WHERE scan_run_id = ? AND source_id = ?
    ORDER BY created_at, id`).bind(context.scanRunId, context.sourceId).all<{
      id: string; filename: string; processed_at: string | null;
      row_count: number; retained_count: number; excluded_count: number; duplicate_count: number;
    }>();
  const totals: SourceProcessingResult = { discoveredCount: 0, retainedCount: 0, excludedCount: 0, duplicateCount: 0 };
  for (const upload of uploads.results) {
    let result: SourceProcessingResult;
    if (upload.processed_at) {
      result = {
        discoveredCount: upload.row_count, retainedCount: upload.retained_count,
        excludedCount: upload.excluded_count, duplicateCount: upload.duplicate_count,
      };
    } else {
      // Load one workbook's rows at a time, rather than the entire queue into memory.
      const stored = await context.db.prepare("SELECT candidates_json FROM opportunity_uploads WHERE id = ?")
        .bind(upload.id).first<{ candidates_json: string }>();
      const candidates = (JSON.parse(stored!.candidates_json) as SourceCandidate[]).map((candidate) => ({
        ...candidate,
        sourceData: { ...candidate.sourceData, upload: { id: upload.id, filename: upload.filename } },
      }));
      result = await processSourceCandidates(context, candidates);
      // Keep completed-file counts even if a later file or automated discovery fails.
      await context.db.batch([
        context.db.prepare(`UPDATE opportunity_uploads SET processed_at = ?,
          retained_count = ?, excluded_count = ?, duplicate_count = ? WHERE id = ?`)
          .bind(new Date().toISOString(), result.retainedCount, result.excludedCount, result.duplicateCount, upload.id),
        context.db.prepare(`UPDATE source_runs SET
          (discovered_count, retained_count, excluded_count) = (
            SELECT COALESCE(SUM(row_count), 0), COALESCE(SUM(retained_count), 0), COALESCE(SUM(excluded_count), 0)
            FROM opportunity_uploads WHERE scan_run_id = ? AND source_id = ? AND processed_at IS NOT NULL
          ) WHERE id = ? AND status = 'running'`)
          .bind(context.scanRunId, context.sourceId, context.sourceRunId),
      ]);
    }
    totals.discoveredCount += result.discoveredCount;
    totals.retainedCount += result.retainedCount;
    totals.excludedCount += result.excludedCount;
    totals.duplicateCount += result.duplicateCount;
  }
  return totals;
}
