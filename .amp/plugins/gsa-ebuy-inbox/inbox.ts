import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TTL = 5 * 60_000;
const SENDER = "MFA-No-Reply+noreply@gsa.gov";
const SUBJECT = "GSA FAS ID one-time verification code";

// This is an orb-local, short-lived inbox, not an archive. No code is exposed
// through an agent tool. The browser runner consumes it directly through take().
export class GsaCodeInbox {
  private db: Database;
  private key: Buffer;
  readonly token: string;

  constructor(readonly directory: string, private now = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const keyPath = join(directory, "key");
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error("Invalid inbox key; setup requires repair.");
    const tokenPath = join(directory, "zapier-token");
    try {
      writeFileSync(tokenPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.token = readFileSync(tokenPath, "utf8");
    this.db = new Database(join(directory, "inbox.sqlite"), { create: true });
    chmodSync(join(directory, "inbox.sqlite"), 0o600);
    this.db.exec(`PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS attempt (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        id TEXT NOT NULL, started INTEGER NOT NULL, expires INTEGER NOT NULL,
        ciphertext TEXT, ambiguous INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipt (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), outcome TEXT, at INTEGER);`);
    const columns = this.db.query("PRAGMA table_info(receipt)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "reasons")) {
      this.db.exec("ALTER TABLE receipt ADD COLUMN reasons TEXT");
    }
    this.cleanup();
  }

  close() { this.db.close(); }

  cleanup() {
    this.db.query("DELETE FROM attempt WHERE expires <= ?").run(this.now());
    this.db.query("DELETE FROM deliveries WHERE expires <= ?").run(this.now());
  }

  begin() {
    return this.db.transaction(() => {
      this.cleanup();
      if (this.db.query("SELECT id FROM attempt").get()) throw new Error("A login attempt is already pending.");
      const id = randomUUID();
      this.db.query("INSERT INTO attempt(singleton, id, started, expires) VALUES (1, ?, ?, ?)")
        .run(id, this.now(), this.now() + TTL);
      return { attemptId: id, expiresAt: new Date(this.now() + TTL).toISOString() };
    }).immediate();
  }

  cancel(id: string) {
    this.db.query("DELETE FROM attempt WHERE id = ?").run(id);
  }

  status() {
    this.cleanup();
    const pending = this.db.query("SELECT expires, ciphertext IS NOT NULL AS ready, ambiguous FROM attempt")
      .get() as { expires: number; ready: number; ambiguous: number } | null;
    const last = this.db.query("SELECT outcome, at, reasons FROM receipt").get() as {
      outcome: string; at: number; reasons: string | null;
    } | null;
    return {
      pending: !!pending,
      codeReady: !!pending?.ready && !pending.ambiguous,
      ambiguous: !!pending?.ambiguous,
      expiresAt: pending ? new Date(pending.expires).toISOString() : null,
      lastDelivery: last ? {
        outcome: last.outcome, at: new Date(last.at).toISOString(),
        reasons: last.reasons ? JSON.parse(last.reasons) as string[] : [],
      } : null,
    };
  }

  receive(event: { id: string; body: Uint8Array; receivedAt: string }, authorization: string | undefined) {
    const supplied = Buffer.from(authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return;
    return this.db.transaction(() => {
      this.cleanup();
      // Reasons must be fixed labels, never field values or parser exceptions.
      const record = (outcome: string, reasons: string[] = []) => {
        this.db.query("INSERT OR REPLACE INTO receipt (singleton, outcome, at, reasons) VALUES (1, ?, ?, ?)")
          .run(outcome, this.now(), JSON.stringify(reasons));
      };
      if (event.body.length > 32_768) { record("rejected_payload", ["payload_too_large"]); return; }
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(new TextDecoder().decode(event.body));
      } catch { record("rejected_payload", ["invalid_json"]); return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        record("rejected_payload", ["expected_json_object"]); return;
      }
      const { sender, subject, body, message_id, sent_at } = value;
      const sentAt = typeof sent_at === "string" ? Date.parse(sent_at) : NaN;
      const receivedAt = Date.parse(event.receivedAt);
      const reasons: string[] = [];
      if (sender !== SENDER) reasons.push("sender_mismatch");
      if (subject !== SUBJECT) reasons.push("subject_mismatch");
      if (typeof body !== "string") reasons.push("body_not_string");
      if (typeof message_id !== "string") reasons.push("message_id_not_string");
      else if (message_id.length < 1 || message_id.length > 512) reasons.push("message_id_invalid_length");
      if (!Number.isFinite(sentAt)) reasons.push("sent_at_invalid");
      if (!Number.isFinite(receivedAt)) reasons.push("received_at_invalid");
      if (reasons.length) {
        record("rejected_payload", reasons); return;
      }
      const attempt = this.db.query("SELECT * FROM attempt").get() as {
        id: string; started: number; expires: number; ciphertext: string | null; ambiguous: number;
      } | null;
      // Allow five seconds of sender clock skew, but never accept mail queued
      // before this attempt or delivered after its deadline.
      if (!attempt) { record("no_matching_attempt", ["no_pending_attempt"]); return; }
      const timingReasons: string[] = [];
      if (sentAt < attempt.started - 5_000) timingReasons.push("sent_before_attempt");
      if (sentAt > receivedAt + 5_000) timingReasons.push("sent_after_receipt");
      if (receivedAt < attempt.started) timingReasons.push("received_before_attempt");
      if (receivedAt >= attempt.expires) timingReasons.push("received_after_deadline");
      if (this.now() - receivedAt >= TTL) timingReasons.push("delivery_too_old");
      if (timingReasons.length) {
        record("no_matching_attempt", timingReasons); return;
      }
      const eventKey = `event:${event.id}`;
      const messageKey = `message:${message_id}`;
      if (this.db.query("SELECT id FROM deliveries WHERE id IN (?, ?)").get(eventKey, messageKey)) return;
      // Anchor extraction to GSA's instruction, not unrelated phone numbers.
      const matches = [...(body as string).matchAll(/Please enter the following code for verification:\s*([0-9]{4,8})(?![0-9])/g)];
      if (matches.length !== 1) { record("rejected_code_format"); return; }
      this.db.query("INSERT INTO deliveries VALUES (?, ?), (?, ?)")
        .run(eventKey, this.now() + 2 * TTL, messageKey, this.now() + 2 * TTL);
      if (attempt.ciphertext || attempt.ambiguous) {
        this.db.query("UPDATE attempt SET ciphertext = NULL, ambiguous = 1").run();
        record("ambiguous_messages"); return;
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(Buffer.from(attempt.id));
      const ciphertext = Buffer.concat([cipher.update(matches[0][1], "utf8"), cipher.final()]);
      const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
      this.db.query("UPDATE attempt SET ciphertext = ?").run(encrypted);
      record("accepted");
    }).immediate();
  }

  // Called only by the browser runner, never returned to an agent/model.
  take(id: string): string | null {
    return this.db.transaction(() => {
      this.cleanup();
      const attempt = this.db.query("SELECT ciphertext, ambiguous FROM attempt WHERE id = ?")
        .get(id) as { ciphertext: string | null; ambiguous: number } | null;
      if (attempt?.ambiguous) throw new Error("Ambiguous verification emails; cancel and start a fresh login.");
      if (!attempt?.ciphertext) return null;
      const encrypted = Buffer.from(attempt.ciphertext, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, encrypted.subarray(0, 12));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      const code = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString("utf8");
      this.db.query("DELETE FROM attempt WHERE id = ?").run(id);
      return code;
    }).immediate();
  }
}
