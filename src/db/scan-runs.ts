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

export async function claimScanRun(db: D1Database, claim: ScanRunClaim): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO scan_runs (
      id, cycle_key, scheduled_for, started_at, status
    ) VALUES (?, ?, ?, ?, 'running')`)
    .bind(claim.id, claim.cycleKey, claim.scheduledFor, new Date().toISOString())
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function countEnabledSources(db: D1Database): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) AS total FROM sources WHERE enabled = 1")
    .first<{ total: number }>();
  return Number(result?.total ?? 0);
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
  await db.prepare(`UPDATE source_runs SET
    status = 'completed', completed_at = ?, cursor_after_json = ?,
    discovered_count = ?, retained_count = ?, excluded_count = ?
    WHERE id = ? AND status = 'running'`)
    .bind(
      new Date().toISOString(),
      completion.cursorAfter === undefined ? null : JSON.stringify(completion.cursorAfter),
      completion.discoveredCount,
      completion.retainedCount,
      completion.excludedCount,
      id,
    )
    .run();
}

export async function completeEmptyScanRun(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE scan_runs
      SET status = 'completed', completed_at = ?
      WHERE id = ? AND status = 'running'`)
    .bind(new Date().toISOString(), id)
    .run();
}

export async function failScanRun(db: D1Database, id: string, errorCode: string): Promise<void> {
  await db
    .prepare(`UPDATE scan_runs
      SET status = 'failed', completed_at = ?, error_summary = ?
      WHERE id = ? AND status = 'running'`)
    .bind(new Date().toISOString(), errorCode, id)
    .run();
}
