export interface ScanRunClaim {
  id: string;
  cycleKey: string;
  scheduledFor: string;
}

export interface SourceRunCompletion {
  discoveredCount: number;
  retainedCount: number;
  excludedCount: number;
  cursorAfter?: unknown;
}

export interface EnabledSource {
  id: string;
  cursor?: { value?: string; lookbackStartedAt?: string };
}

export interface ScanRunCompletion {
  status: "completed" | "partial" | "failed";
  discoveredCount: number;
  retainedCount: number;
  excludedCount: number;
  duplicateCount: number;
  failedSourceCount: number;
}

export async function claimScanRun(db: D1Database, claim: ScanRunClaim): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO scan_runs (
      id, cycle_key, scheduled_for, started_at, status
    ) VALUES (?, ?, ?, ?, 'running')`)
    .bind(claim.id, claim.cycleKey, claim.scheduledFor, new Date().toISOString())
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function listEnabledSources(db: D1Database): Promise<EnabledSource[]> {
  const result = await db
    .prepare("SELECT id, cursor_json FROM sources WHERE enabled = 1 ORDER BY id")
    .all<{ id: string; cursor_json: string | null }>();
  return result.results.map((row) => ({
    id: row.id,
    cursor: row.cursor_json ? JSON.parse(row.cursor_json) : undefined,
  }));
}

export async function startSourceRun(
  db: D1Database,
  scanRunId: string,
  sourceId: string,
  cursorBefore?: unknown,
): Promise<string> {
  const id = `source_run_${scanRunId}_${sourceId}`;
  await db.prepare(`INSERT OR IGNORE INTO source_runs (
    id, scan_run_id, source_id, started_at, status, cursor_before_json
  ) VALUES (?, ?, ?, ?, 'running', ?)`)
    .bind(
      id,
      scanRunId,
      sourceId,
      new Date().toISOString(),
      cursorBefore === undefined ? null : JSON.stringify(cursorBefore),
    )
    .run();
  return id;
}

export async function completeSourceRun(
  db: D1Database,
  id: string,
  completion: SourceRunCompletion,
): Promise<void> {
  const completedAt = new Date().toISOString();
  const cursor = completion.cursorAfter === undefined ? null : JSON.stringify(completion.cursorAfter);
  const statements = [
    db.prepare(`UPDATE source_runs SET
      status = 'completed', completed_at = ?, cursor_after_json = ?,
      discovered_count = ?, retained_count = ?, excluded_count = ?
      WHERE id = ? AND status = 'running'`)
      .bind(
        completedAt,
        cursor,
        completion.discoveredCount,
        completion.retainedCount,
        completion.excludedCount,
        id,
      ),
  ];
  if (completion.cursorAfter !== undefined) {
    statements.push(db.prepare(`UPDATE sources SET cursor_json = ?, updated_at = ?
      WHERE id = (SELECT source_id FROM source_runs WHERE id = ?)`)
      .bind(cursor, completedAt, id));
  }
  await db.batch(statements);
}

export async function failSourceRun(
  db: D1Database,
  id: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await db.prepare(`UPDATE source_runs SET
    status = 'failed', completed_at = ?, error_code = ?, error_message = ?
    WHERE id = ? AND status = 'running'`)
    .bind(new Date().toISOString(), errorCode, errorMessage.slice(0, 500), id)
    .run();
}

export async function completeScanRun(db: D1Database, id: string): Promise<ScanRunCompletion> {
  const totals = await db.prepare(`SELECT
      COUNT(*) AS source_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_sources,
      SUM(CASE WHEN status != 'completed' THEN 1 ELSE 0 END) AS failed_sources,
      COALESCE(SUM(discovered_count), 0) AS discovered_count,
      COALESCE(SUM(retained_count), 0) AS retained_count,
      COALESCE(SUM(excluded_count), 0) AS excluded_count
    FROM source_runs WHERE scan_run_id = ?`)
    .bind(id)
    .first<{
      source_count: number;
      completed_sources: number;
      failed_sources: number;
      discovered_count: number;
      retained_count: number;
      excluded_count: number;
    }>();
  const sourceCount = Number(totals?.source_count ?? 0);
  const completedSources = Number(totals?.completed_sources ?? 0);
  const failedSourceCount = Number(totals?.failed_sources ?? 0);
  const discoveredCount = Number(totals?.discovered_count ?? 0);
  const retainedCount = Number(totals?.retained_count ?? 0);
  const excludedCount = Number(totals?.excluded_count ?? 0);
  const duplicateCount = Math.max(0, discoveredCount - retainedCount - excludedCount);
  const status = failedSourceCount === 0
    ? "completed"
    : completedSources > 0
      ? "partial"
      : "failed";
  const errorSummary = failedSourceCount > 0
    ? `${failedSourceCount} of ${sourceCount} Sources failed`
    : null;

  await db.prepare(`UPDATE scan_runs SET
      status = ?, completed_at = ?, discovered_count = ?, retained_count = ?,
      excluded_count = ?, duplicate_count = ?, error_summary = ?
    WHERE id = ? AND status = 'running'`)
    .bind(
      status,
      new Date().toISOString(),
      discoveredCount,
      retainedCount,
      excludedCount,
      duplicateCount,
      errorSummary,
      id,
    )
    .run();

  return {
    status,
    discoveredCount,
    retainedCount,
    excludedCount,
    duplicateCount,
    failedSourceCount,
  };
}

export async function completeEmptyScanRun(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE scan_runs
      SET status = 'completed', completed_at = ?
      WHERE id = ? AND status = 'running'`)
    .bind(new Date().toISOString(), id)
    .run();
}
