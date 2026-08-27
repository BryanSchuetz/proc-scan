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
    const response = await SELF.fetch("http://localhost/api/events");
    expect(response.status).toBe(200);
    const body = await response.json<EventsResponse>();
    expect(body.pagination.total).toBe(6);
    expect(new Set(body.items.map((item) => item.addressabilityStatus))).toEqual(
      new Set(["addressable", "uncertain"]),
    );
    expect(body.items[0].discoveredAt >= body.items[1].discoveredAt).toBe(true);
    expect(body.facets.fixtureData).toBe(true);
    expect(body.facets.technicalAreas.map((area) => area.id)).toContain("digital");
  });

  it("supports the separate Addressable and Uncertain registry views", async () => {
    const addressableResponse = await SELF.fetch("http://localhost/api/events?status=addressable");
    const addressable = await addressableResponse.json<EventsResponse>();
    expect(addressable.pagination.total).toBe(4);
    expect(addressable.items.every((item) => item.addressabilityStatus === "addressable")).toBe(true);

    const uncertainResponse = await SELF.fetch("http://localhost/api/events?status=uncertain");
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
    expect((await SELF.fetch("http://localhost/api/events?sort=technicalAreas")).status).toBe(200);
    expect((await SELF.fetch("http://localhost/api/events?sort=drop_table")).status).toBe(400);
    expect((await SELF.fetch("http://localhost/api/events?unknown=value")).status).toBe(400);
    expect((await SELF.fetch("http://localhost/api/events", { method: "POST" })).status).toBe(405);
  });
});
