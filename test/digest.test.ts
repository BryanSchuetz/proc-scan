import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import seedSql from "../fixtures/seed.sql?raw";
import {
  prepareDigest,
  recordDigestAttempt,
  recordDigestFailed,
  recordDigestSent,
  type PreparedDigest,
} from "../src/db/digests";
import {
  CampaignMonitorError,
  sendCampaignMonitorDigest,
} from "../src/digest/campaign-monitor";
import { renderDigest } from "../src/digest/render";

async function applySeed(): Promise<void> {
  const statements = seedSql
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await env.DB.prepare(statement).run();
}

beforeAll(applySeed);

describe("digest preparation", () => {
  it("snapshots only newly inserted Addressable events and is idempotent", async () => {
    const first = await prepareDigest(env.DB, "scan_fixture_2026_08_26_am");
    const second = await prepareDigest(env.DB, "scan_fixture_2026_08_26_am");

    expect(first.status).toBe("pending");
    expect(first.events).toHaveLength(4);
    expect(first.events.map((event) => event.id)).not.toContain("evt_fixture_health_tender");
    expect(second).toEqual(first);

    const itemCount = await env.DB.prepare("SELECT COUNT(*) AS total FROM digest_items")
      .first<{ total: number }>();
    expect(itemCount?.total).toBe(4);
  });

  it("carries events from a failed email into the next digest", async () => {
    const prior = await prepareDigest(env.DB, "scan_fixture_2026_08_26_am");
    await recordDigestFailed(env.DB, prior.id, "campaign_monitor_unavailable");
    await env.DB.prepare(`INSERT INTO scan_runs (
      id, cycle_key, scheduled_for, started_at, completed_at, status
    ) VALUES ('scan_digest_retry', 'digest:retry', '2026-08-29T22:00:00.000Z',
      '2026-08-29T22:00:00.000Z', '2026-08-29T22:01:00.000Z', 'completed')`).run();

    const retry = await prepareDigest(env.DB, "scan_digest_retry");
    expect(retry.events.map((event) => event.id)).toEqual(
      prior.events.map((event) => event.id),
    );
    await recordDigestSent(env.DB, retry.id, "message-retry-1");
  });

  it("records attempts, failures, and provider delivery IDs", async () => {
    const digest = await prepareDigest(env.DB, "scan_fixture_2026_08_26_am");
    await recordDigestAttempt(env.DB, digest.id);
    await recordDigestFailed(env.DB, digest.id, "campaign_monitor_http_400");
    await recordDigestSent(env.DB, digest.id, "message-fixture-1");

    const stored = await env.DB.prepare(`SELECT status, attempt_count, provider_message_id, error_code
      FROM digests WHERE id = ?`)
      .bind(digest.id)
      .first<{
        status: string;
        attempt_count: number;
        provider_message_id: string;
        error_code: string | null;
      }>();
    expect(stored).toMatchObject({
      status: "sent",
      attempt_count: 1,
      provider_message_id: "message-fixture-1",
      error_code: null,
    });
  });

  it("records an empty scan without sending", async () => {
    await env.DB.prepare(`INSERT INTO scan_runs (
      id, cycle_key, scheduled_for, started_at, completed_at, status
    ) VALUES ('scan_digest_empty', 'digest:empty', '2026-08-30T10:00:00.000Z',
      '2026-08-30T10:00:00.000Z', '2026-08-30T10:01:00.000Z', 'completed')`).run();
    const digest = await prepareDigest(env.DB, "scan_digest_empty");
    expect(digest).toMatchObject({ status: "skipped_empty", events: [] });
  });
});

describe("digest rendering", () => {
  it("groups events, reports partial coverage, and escapes Source content", () => {
    const digest: PreparedDigest = {
      id: "digest-fixture",
      scanRunId: "scan-fixture",
      status: "pending",
      scheduledFor: "2026-09-05T10:00:00.000Z",
      sourceRuns: [
        { sourceName: "Grants.gov", status: "completed" },
        { sourceName: "SAM.gov", status: "failed" },
      ],
      events: [{
        id: "event-1",
        eventType: "tender",
        opportunityName: "Water & <Governance>",
        clientName: "Department of State",
        placeOfPerformance: "Kenya",
        valueAmount: 2_500_000,
        valueCurrency: "USD",
        dueDate: "2026-10-01T16:00:00.000Z",
        technicalAreaLabels: ["Water and Sanitation"],
        sourceName: "Grants.gov",
        sourceUrl: "https://example.test/opportunity?a=1&b=2",
      }],
    };

    const message = renderDigest(digest, "https://registry.example.test");
    expect(message.subject).toBe("1 new procurement opportunity | Sep 5, 2026");
    expect(message.html).toContain("Department of State");
    expect(message.html).toContain("Partial coverage:");
    expect(message.html).toContain("Water &amp; &lt;Governance&gt;");
    expect(message.html).not.toContain("Water & <Governance>");
    expect(message.text).toContain("Failed Sources: SAM.gov");
    expect(message.text).toContain("$2,500,000");
    expect(message.html).not.toContain("TENDERS · 1");
    expect(message.html).toContain("border-left:4px solid #9BCE36");

    const modification = renderDigest({
      ...digest,
      events: [{ ...digest.events[0], eventType: "modification" }],
    });
    expect(modification.html).not.toContain("MODIFICATIONS · 1");
    expect(modification.html).toContain("border-left:4px solid #F9CC73");
  });
});

describe("Campaign Monitor delivery", () => {
  const config = {
    apiKey: "fixture-api-key",
    clientId: "fixture-client",
    from: "DAI Procurement <procurement@dai.example>",
    recipient: "opportunities@dai.example",
  };
  const message = { subject: "Digest", html: "<p>Digest</p>", text: "Digest" };

  it("sends a Classic Transactional email and returns its message ID", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain("clientID=fixture-client");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Basic ${btoa("fixture-api-key:x")}`,
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        Subject: "Digest",
        To: ["opportunities@dai.example"],
        TrackOpens: false,
        TrackClicks: false,
        Group: "Procurement Opportunity Digest",
      });
      return Response.json(
        [{ Status: "Accepted", MessageID: "provider-message-1", Recipient: config.recipient }],
        { status: 202 },
      );
    });

    await expect(sendCampaignMonitorDigest(config, message, fetcher))
      .resolves.toBe("provider-message-1");
  });

  it("classifies rate limits as retryable without exposing response content", async () => {
    const error = await sendCampaignMonitorDigest(
      config,
      message,
      vi.fn<typeof fetch>(async () => new Response("secret provider response", { status: 429 })),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CampaignMonitorError);
    expect(error).toMatchObject({ code: "campaign_monitor_http_429", retryable: true });
    expect((error as Error).message).not.toContain("secret provider response");
  });
});
