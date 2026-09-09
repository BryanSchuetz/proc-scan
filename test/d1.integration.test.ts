import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import seedSql from "../fixtures/seed.sql?raw";
import taxonomyRaw from "../tech-area-classification.yaml?raw";
import type { EventsResponse } from "../src/api/types";
import { parseTaxonomyYaml } from "../src/classification/taxonomy";
import { syncTechnicalAreas } from "../src/db/taxonomy";

async function applySeed(): Promise<void> {
  const statements = seedSql
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await env.DB.prepare(statement).run();
}

beforeAll(async () => {
  await applySeed();
});

describe("D1 registry integration", () => {
  it("keeps a repeated fixture scan idempotent, including its FTS index", async () => {
    await applySeed();
    const events = await env.DB.prepare("SELECT COUNT(*) AS total FROM bidding_events").first<{ total: number }>();
    const indexed = await env.DB.prepare("SELECT COUNT(*) AS total FROM bidding_events_fts").first<{ total: number }>();
    const sourceRuns = await env.DB.prepare("SELECT COUNT(*) AS total FROM source_runs").first<{ total: number }>();
    expect(events?.total).toBe(6);
    expect(indexed?.total).toBe(6);
    expect(sourceRuns?.total).toBe(2);
  });

  it("synchronizes the complete Technical Area taxonomy into D1", async () => {
    await syncTechnicalAreas(env.DB, parseTaxonomyYaml(taxonomyRaw), 1);
    const areas = await env.DB.prepare("SELECT COUNT(*) AS total FROM technical_areas").first<{ total: number }>();
    expect(areas?.total).toBe(39);
  });

  it("returns both retained statuses newest-first by default", async () => {
    const response = await SELF.fetch("http://localhost/api/opportunities");
    expect(response.status).toBe(200);
    const body = await response.json<EventsResponse>();
    expect(body.pagination.total).toBe(6);
    expect(new Set(body.items.map((item) => item.addressabilityStatus))).toEqual(
      new Set(["addressable", "uncertain"]),
    );
    expect(body.items[0].discoveredAt >= body.items[1].discoveredAt).toBe(true);
    expect(body.facets.fixtureData).toBe(true);
    expect(body.facets.technicalAreas.map((area) => area.id)).toContain("digital");
    expect(body.latestScan).toEqual({
      completedAt: "2026-08-26T10:02:14.000Z",
      successfulSources: [
        { id: "grants-gov", name: "Grants.gov" },
        { id: "ted", name: "TED" },
      ],
      sourceCount: 2,
    });
  });

  it("reports successful Sources from a partial latest scan", async () => {
    await env.DB.prepare(`INSERT INTO scan_runs (
      id, cycle_key, scheduled_for, started_at, completed_at, status
    ) VALUES ('scan_summary_partial', '2099-01-01:AM', '2099-01-01T10:00:00.000Z',
      '2099-01-01T10:00:00.000Z', '2099-01-01T10:05:00.000Z', 'partial')`).run();
    await env.DB.prepare(`INSERT INTO source_runs (
      id, scan_run_id, source_id, started_at, completed_at, status
    ) VALUES
      ('source_summary_grants', 'scan_summary_partial', 'grants-gov',
        '2099-01-01T10:00:00.000Z', '2099-01-01T10:02:00.000Z', 'completed'),
      ('source_summary_ted', 'scan_summary_partial', 'ted',
        '2099-01-01T10:00:00.000Z', '2099-01-01T10:05:00.000Z', 'failed')`).run();

    try {
      const response = await SELF.fetch("http://localhost/api/opportunities");
      const body = await response.json<EventsResponse>();
      expect(body.latestScan).toEqual({
        completedAt: "2099-01-01T10:05:00.000Z",
        successfulSources: [{ id: "grants-gov", name: "Grants.gov" }],
        sourceCount: 2,
      });
    } finally {
      await env.DB.prepare("DELETE FROM source_runs WHERE scan_run_id = 'scan_summary_partial'").run();
      await env.DB.prepare("DELETE FROM scan_runs WHERE id = 'scan_summary_partial'").run();
    }
  });

  it("hides expired events without deleting their history", async () => {
    await env.DB.prepare(
      "UPDATE bidding_events SET due_date = '2000-01-01T00:00:00.000Z' " +
      "WHERE id = 'evt_fixture_health_tender'",
    ).run();
    try {
      const response = await SELF.fetch("http://localhost/api/opportunities");
      expect(response.status).toBe(200);
      const body = await response.json<EventsResponse>();

      expect(body.pagination.total).toBe(5);
      expect(body.items.map((item) => item.id)).not.toContain("evt_fixture_health_tender");
      const stored = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM bidding_events WHERE id = 'evt_fixture_health_tender'",
      ).first<{ total: number }>();
      expect(stored?.total).toBe(1);
    } finally {
      await env.DB.prepare(
        "UPDATE bidding_events SET due_date = '2026-09-22T16:00:00.000Z' " +
        "WHERE id = 'evt_fixture_health_tender'",
      ).run();
    }
  });

  it("hides disabled Source records and their facet values without deleting them", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = 'ted'").run();
    try {
      const response = await SELF.fetch("http://localhost/api/opportunities");
      expect(response.status).toBe(200);
      const body = await response.json<EventsResponse>();

      expect(body.pagination.total).toBe(3);
      expect(body.items.every((item) => item.sourceId === "grants-gov")).toBe(true);
      expect(body.facets.sources).toEqual([{ id: "grants-gov", name: "Grants.gov" }]);
      expect(body.facets.clients).not.toContain("European Cooperation Office");
      expect(body.facets.technicalAreas.map((area) => area.id)).not.toContain("agriculture-and-market-systems");
      expect(body.facets.technicalAreas.map((area) => area.id)).not.toContain("unclassified");

      const stored = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM bidding_events WHERE source_id = 'ted'",
      ).first<{ total: number }>();
      expect(stored?.total).toBe(3);
    } finally {
      await env.DB.prepare("UPDATE sources SET enabled = 1 WHERE id = 'ted'").run();
    }
  });

  it("supports the separate Addressable and Uncertain registry views", async () => {
    const addressableResponse = await SELF.fetch("http://localhost/api/opportunities?status=addressable");
    const addressable = await addressableResponse.json<EventsResponse>();
    expect(addressable.pagination.total).toBe(4);
    expect(addressable.items.every((item) => item.addressabilityStatus === "addressable")).toBe(true);

    const uncertainResponse = await SELF.fetch("http://localhost/api/opportunities?status=uncertain");
    const uncertain = await uncertainResponse.json<EventsResponse>();
    expect(uncertain.pagination.total).toBe(2);
    expect(uncertain.items.every((item) => item.addressabilityStatus === "uncertain")).toBe(true);
  });

  it("searches the FTS index and filters parent Technical Areas through descendants", async () => {
    const searchResponse = await SELF.fetch("http://localhost/api/events?search=health%20workforce");
    const search = await searchResponse.json<EventsResponse>();
    expect(search.items.map((item) => item.id)).toEqual(["evt_fixture_health_tender"]);

    const parentResponse = await SELF.fetch("http://localhost/api/events?technicalArea=digital");
    const parent = await parentResponse.json<EventsResponse>();
    expect(parent.pagination.total).toBe(2);
    expect(parent.items.every((item) => item.opportunityName.includes("Digital Public Infrastructure"))).toBe(true);

    const unclassifiedResponse = await SELF.fetch("http://localhost/api/events?technicalArea=unclassified");
    const unclassified = await unclassifiedResponse.json<EventsResponse>();
    expect(unclassified.items.map((item) => item.id)).toEqual(["evt_fixture_unclassified_tender"]);
  });

  it("uses allowlisted query fields and rejects writes", async () => {
    expect((await SELF.fetch("http://localhost/api/opportunities?sort=technicalAreas")).status).toBe(200);
    expect((await SELF.fetch("http://localhost/api/opportunities?sort=drop_table")).status).toBe(400);
    expect((await SELF.fetch("http://localhost/api/opportunities?unknown=value")).status).toBe(400);
    expect((await SELF.fetch("http://localhost/api/opportunities", { method: "POST" })).status).toBe(405);
  });

  it("retains the previous events endpoint as a read-only compatibility alias", async () => {
    const response = await SELF.fetch("http://localhost/api/events?status=uncertain");
    expect(response.status).toBe(200);
    const body = await response.json<EventsResponse>();
    expect(body.pagination.total).toBe(2);
  });
});
