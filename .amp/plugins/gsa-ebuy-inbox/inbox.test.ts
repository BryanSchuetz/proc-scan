import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GsaCodeInbox } from "./inbox";

const directories: string[] = [];
const inboxes: GsaCodeInbox[] = [];
afterEach(() => {
  for (const inbox of inboxes.splice(0)) inbox.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function fixture() {
  let now = Date.parse("2026-11-09T10:00:00Z");
  const directory = mkdtempSync(join(tmpdir(), "gsa-inbox-test-"));
  directories.push(directory);
  const inbox = new GsaCodeInbox(directory, () => now);
  inboxes.push(inbox);
  const payload = {
    sender: "MFA-No-Reply+noreply@gsa.gov", subject: "GSA FAS ID one-time verification code",
    body: "EXTERNAL banner\nPlease enter the following code for verification:\n572049\nHelp desk 1-877-472-3777",
    message_id: "<fixture-one@gsa.gov>", sent_at: new Date(now).toISOString(),
  };
  function deliver(overrides = {}, id = "event-one", auth = `Bearer ${inbox.token}`) {
    inbox.receive({ id, body: Buffer.from(JSON.stringify({ ...payload, ...overrides })), receivedAt: new Date(now).toISOString() }, auth);
  }
  return { inbox, directory, payload, deliver, advance: (ms: number) => { now += ms; } };
}

test("extracts the anchored code, encrypts at rest, deduplicates, and consumes only once", () => {
  const { inbox, directory, deliver } = fixture();
  const { attemptId } = inbox.begin();
  deliver(); deliver(); deliver({}, "zapier-retry");
  expect(inbox.status().codeReady).toBe(true);
  expect(JSON.stringify(inbox.status())).not.toContain("572049");
  expect(readFileSync(join(directory, "inbox.sqlite")).includes(Buffer.from("572049"))).toBe(false);
  expect(inbox.take("wrong-attempt")).toBeNull();
  expect(inbox.take(attemptId)).toBe("572049");
  expect(inbox.take(attemptId)).toBeNull();
  deliver();
  expect(inbox.status().pending).toBe(false);
  const next = inbox.begin();
  deliver({}, "another-retry");
  expect(inbox.take(next.attemptId)).toBeNull();
});

test("rejects unauthenticated, malformed, wrong-source, stale, and unrequested messages", () => {
  const { inbox, deliver, advance } = fixture();
  deliver();
  expect(inbox.status().lastDelivery?.outcome).toBe("no_matching_attempt");
  const { attemptId } = inbox.begin();
  deliver({}, "bad-auth", "Bearer wrong");
  deliver({ sender: "attacker@example.com" });
  deliver({ subject: "Reset your password" });
  deliver({ sent_at: "2026-11-09T09:59:00Z" });
  expect(inbox.status().lastDelivery?.reasons).toEqual(["sent_before_attempt"]);
  deliver({ sent_at: "2026-11-09T10:01:00Z" });
  expect(inbox.status().lastDelivery?.reasons).toEqual(["sent_after_receipt"]);
  deliver({ body: "Help desk 1-877-472-3777" });
  deliver({ body: "Please enter the following code for verification: 123456789" });
  expect(inbox.take(attemptId)).toBeNull();
  advance(300_000);
  deliver();
  expect(inbox.status().pending).toBe(false);
});

test("serializes attempts and fails closed on distinct verification messages", () => {
  const { inbox, deliver } = fixture();
  const { attemptId } = inbox.begin();
  expect(() => inbox.begin()).toThrow("already pending");
  deliver();
  deliver({ message_id: "<second@gsa.gov>" }, "second-event");
  expect(inbox.status().ambiguous).toBe(true);
  expect(inbox.status().codeReady).toBe(false);
  expect(() => inbox.take(attemptId)).toThrow("Ambiguous");
  inbox.cancel(attemptId);
  expect(inbox.status().pending).toBe(false);
});

test("reports only fixed validation reasons, never rejected field values", () => {
  const { inbox, deliver } = fixture();
  deliver({
    sender: "private-sender@example.com", subject: "private-subject",
    body: { secret: "private-body" }, message_id: 386182264, sent_at: "private-date",
  });
  expect(inbox.status().lastDelivery).toMatchObject({
    outcome: "rejected_payload",
    reasons: ["sender_mismatch", "subject_mismatch", "body_not_string", "message_id_not_string", "sent_at_invalid"],
  });
  const status = JSON.stringify(inbox.status());
  for (const secret of ["private-sender", "private-subject", "private-body", "386182264", "private-date"]) {
    expect(status).not.toContain(secret);
  }
  deliver({ message_id: "" });
  expect(inbox.status().lastDelivery?.reasons).toEqual(["message_id_invalid_length"]);
  deliver();
  expect(inbox.status().lastDelivery).toMatchObject({ outcome: "no_matching_attempt", reasons: ["no_pending_attempt"] });
});

test("survives restart but does not release a code at or after its deadline", () => {
  const { inbox, directory, deliver, advance } = fixture();
  const { attemptId } = inbox.begin();
  deliver();
  const reopened = new GsaCodeInbox(directory, () => Date.parse("2026-11-09T10:00:00Z"));
  inboxes.push(reopened);
  expect(reopened.status().codeReady).toBe(true);
  advance(299_999);
  expect(inbox.status().codeReady).toBe(true);
  advance(1);
  expect(inbox.take(attemptId)).toBeNull();
});
