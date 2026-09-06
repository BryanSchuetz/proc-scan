import { sha256Hex } from "../domain/identity";
import type { BiddingEventType } from "../domain/types";

export type DigestStatus = "pending" | "skipped_empty" | "sent" | "failed";

export interface DigestEvent {
  id: string;
  eventType: BiddingEventType;
  opportunityName: string;
  clientName?: string;
  placeOfPerformance?: string;
  valueAmount?: number;
  valueCurrency?: string;
  dueDate?: string;
  technicalAreaLabels: string[];
  sourceName: string;
  sourceUrl: string;
}

export interface DigestSourceRun {
  sourceName: string;
  status: string;
  errorMessage?: string;
}

export interface PreparedDigest {
  id: string;
  scanRunId: string;
  status: DigestStatus;
  scheduledFor: string;
  events: DigestEvent[];
  sourceRuns: DigestSourceRun[];
}

interface DigestEventRow {
  id: string;
  event_type: BiddingEventType;
  opportunity_name: string;
  client_name: string | null;
  place_of_performance: string | null;
  value_amount: number | null;
  value_currency: string | null;
  due_date: string | null;
  technical_area_labels: string;
  source_name: string;
  source_url: string;
}

function digestEvent(row: DigestEventRow): DigestEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    opportunityName: row.opportunity_name,
    clientName: row.client_name ?? undefined,
    placeOfPerformance: row.place_of_performance ?? undefined,
    valueAmount: row.value_amount ?? undefined,
    valueCurrency: row.value_currency ?? undefined,
    dueDate: row.due_date ?? undefined,
    technicalAreaLabels: row.technical_area_labels
      ? row.technical_area_labels.split("|").map((label) => label.trim()).filter(Boolean)
      : [],
    sourceName: row.source_name,
    sourceUrl: row.source_url,
  };
}

async function loadPreparedDigest(db: D1Database, digestId: string): Promise<PreparedDigest> {
  const digest = await db.prepare(`SELECT d.id, d.scan_run_id, d.status, r.scheduled_for
    FROM digests d
    JOIN scan_runs r ON r.id = d.scan_run_id
    WHERE d.id = ?`)
    .bind(digestId)
    .first<{ id: string; scan_run_id: string; status: DigestStatus; scheduled_for: string }>();
  if (!digest) throw new Error(`Digest ${digestId} was not found after preparation.`);

  const [eventRows, sourceRows] = await Promise.all([
    db.prepare(`SELECT e.id, e.event_type, e.opportunity_name, e.client_name,
        e.place_of_performance, e.value_amount, e.value_currency, e.due_date,
        e.technical_area_labels, s.display_name AS source_name, e.source_url
      FROM digest_items item
      JOIN bidding_events e ON e.id = item.bidding_event_id
      JOIN sources s ON s.id = e.source_id
      WHERE item.digest_id = ?
      ORDER BY COALESCE(e.client_name, ''), e.event_type, e.opportunity_name, e.id`)
      .bind(digestId)
      .all<DigestEventRow>(),
    db.prepare(`SELECT s.display_name AS source_name, sr.status, sr.error_message
      FROM source_runs sr
      JOIN sources s ON s.id = sr.source_id
      WHERE sr.scan_run_id = ?
      ORDER BY s.display_name`)
      .bind(digest.scan_run_id)
      .all<{ source_name: string; status: string; error_message: string | null }>(),
  ]);

  return {
    id: digest.id,
    scanRunId: digest.scan_run_id,
    status: digest.status,
    scheduledFor: digest.scheduled_for,
    events: eventRows.results.map(digestEvent),
    sourceRuns: sourceRows.results.map((row) => ({
      sourceName: row.source_name,
      status: row.status,
      errorMessage: row.error_message ?? undefined,
    })),
  };
}

export async function prepareDigest(db: D1Database, scanRunId: string): Promise<PreparedDigest> {
  const digestId = `digest_${scanRunId}`;
  const existing = await db.prepare("SELECT id FROM digests WHERE scan_run_id = ?")
    .bind(scanRunId)
    .first<{ id: string }>();
  if (existing) return loadPreparedDigest(db, existing.id);

  const rows = await db.prepare(`SELECT DISTINCT e.id, e.content_fingerprint
    FROM bidding_events e
    WHERE e.addressability_status = 'addressable'
      AND (
        e.scan_run_id = ?
        OR EXISTS (
          SELECT 1 FROM digest_items failed_item
          JOIN digests failed_digest ON failed_digest.id = failed_item.digest_id
          WHERE failed_item.bidding_event_id = e.id AND failed_digest.status = 'failed'
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM digest_items sent_item
        JOIN digests sent_digest ON sent_digest.id = sent_item.digest_id
        WHERE sent_item.bidding_event_id = e.id AND sent_digest.status = 'sent'
      )
    ORDER BY e.id`)
    .bind(scanRunId)
    .all<{ id: string; content_fingerprint: string }>();
  const fingerprint = await sha256Hex(
    rows.results.map((row) => `${row.id}:${row.content_fingerprint}`).join("\n"),
  );
  const now = new Date().toISOString();
  const status: DigestStatus = rows.results.length === 0 ? "skipped_empty" : "pending";
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO digests (
      id, scan_run_id, content_fingerprint, provider, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'campaign-monitor', ?, ?, ?)`)
      .bind(digestId, scanRunId, fingerprint, status, now, now),
    ...rows.results.map((row) =>
      db.prepare(`INSERT OR IGNORE INTO digest_items (digest_id, bidding_event_id)
        VALUES (?, ?)`)
        .bind(digestId, row.id)),
  ]);
  return loadPreparedDigest(db, digestId);
}

export async function recordDigestAttempt(db: D1Database, digestId: string): Promise<void> {
  await db.prepare(`UPDATE digests SET attempt_count = attempt_count + 1, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'failed')`)
    .bind(new Date().toISOString(), digestId)
    .run();
}

export async function recordDigestSent(
  db: D1Database,
  digestId: string,
  providerMessageId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE digests SET status = 'sent', provider_message_id = ?, sent_at = ?,
      error_code = NULL, updated_at = ?
    WHERE id = ?`)
    .bind(providerMessageId, now, now, digestId)
    .run();
}

export async function recordDigestFailed(
  db: D1Database,
  digestId: string,
  errorCode: string,
): Promise<void> {
  await db.prepare(`UPDATE digests SET status = 'failed', error_code = ?, updated_at = ?
    WHERE id = ? AND status != 'sent'`)
    .bind(errorCode.slice(0, 100), new Date().toISOString(), digestId)
    .run();
}
