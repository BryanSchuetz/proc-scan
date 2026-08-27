import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import taxonomyRaw from "../tech-area-classification.yaml?raw";
import classificationRaw from "../config/technical-classification.yaml?raw";
import addressabilityRaw from "../config/addressability.yaml?raw";
import grantsGovRaw from "../config/grants-gov.yaml?raw";
import samGovRaw from "../config/sam-gov.yaml?raw";
import grantsAgencyDiscovery from "./fixtures/grants-gov-agencies.json";
import grantsPage0 from "./fixtures/grants-gov-page-0.json";
import grantsPage1 from "./fixtures/grants-gov-page-1.json";
import page0 from "./fixtures/sam-gov-page-0.json";
import page1 from "./fixtures/sam-gov-page-1.json";
import { parseAddressabilityYaml } from "../src/classification/addressability";
import {
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
} from "../src/classification/taxonomy";
import { claimScanRun, completeScanRun, startSourceRun } from "../src/db/scan-runs";
import { syncTechnicalAreas } from "../src/db/taxonomy";
import { runSourceAdapter } from "../src/pipeline/run-source";
import { createGrantsGovAdapter, parseGrantsGovConfig } from "../src/sources/grants-gov";
import { createSamGovAdapter, parseSamGovConfig } from "../src/sources/sam-gov";

const taxonomy = parseTaxonomyYaml(taxonomyRaw);
const technicalClassification = parseTechnicalClassificationYaml(classificationRaw);
const addressability = parseAddressabilityYaml(addressabilityRaw);
const grantsGov = parseGrantsGovConfig(grantsGovRaw);
const samGov = parseSamGovConfig(samGovRaw);

function fixtureAdapter() {
  return createSamGovAdapter({
    apiKey: "fixture-key",
    organizations: samGov.organizations,
    pageSize: 2,
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.searchParams.get("organizationCode") !== "524") {
        return Response.json({ totalRecords: 0, limit: 2, offset: 0, opportunitiesData: [] });
      }
      return Response.json(url.searchParams.get("offset") === "0" ? page0 : page1);
    }) as typeof fetch,
  });
}

function grantsFixtureAdapter() {
  return createGrantsGovAdapter({
    organizations: grantsGov.organizations,
    pageSize: 2,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected Grants.gov request body");
      const body = JSON.parse(init.body) as { agencies?: string; startRecordNum?: number };
      if (!body.agencies) return Response.json(grantsAgencyDiscovery);
      return Response.json(body.startRecordNum === 0 ? grantsPage0 : grantsPage1);
    }) as typeof fetch,
  });
}

async function processScan(scanRunId: string, cycleKey: string, now: Date) {
  await claimScanRun(env.DB, {
    id: scanRunId,
    cycleKey,
    scheduledFor: now.toISOString(),
  });
  const sourceRunId = await startSourceRun(env.DB, scanRunId, "sam-gov");
  const result = await runSourceAdapter({
    db: env.DB,
    adapter: fixtureAdapter(),
    sourceRunId,
    scanRunId,
    signal: new AbortController().signal,
    now,
    taxonomy,
    technicalClassification,
    addressability,
  });
  await completeScanRun(env.DB, scanRunId);
  return result;
}

async function processGrantsScan(scanRunId: string, cycleKey: string, now: Date) {
  await claimScanRun(env.DB, {
    id: scanRunId,
    cycleKey,
    scheduledFor: now.toISOString(),
  });
  const sourceRunId = await startSourceRun(env.DB, scanRunId, "grants-gov");
  const result = await runSourceAdapter({
    db: env.DB,
    adapter: grantsFixtureAdapter(),
    sourceRunId,
    scanRunId,
    signal: new AbortController().signal,
    now,
    taxonomy,
    technicalClassification,
    addressability,
  });
  await completeScanRun(env.DB, scanRunId);
  return result;
}

beforeAll(async () => {
  await env.DB.prepare("DELETE FROM bidding_events WHERE source_id = 'grants-gov'").run();
  await env.DB.prepare("DELETE FROM bidding_events WHERE source_id = 'sam-gov'").run();
  await env.DB.prepare("DELETE FROM source_runs WHERE source_id = 'grants-gov'").run();
  await env.DB.prepare("DELETE FROM source_runs WHERE source_id = 'sam-gov'").run();
  await env.DB.prepare(`DELETE FROM scan_runs WHERE id IN (
    'scan_grants_fixture_first', 'scan_grants_fixture_second',
    'scan_sam_fixture_first', 'scan_sam_fixture_second'
  )`).run();
  await env.DB.prepare("UPDATE sources SET cursor_json = NULL WHERE id = 'grants-gov'").run();
  await env.DB.prepare("UPDATE sources SET cursor_json = NULL WHERE id = 'sam-gov'").run();
  await syncTechnicalAreas(env.DB, taxonomy, technicalClassification.schema_version);
});

describe("Source processing integration", () => {
  it("persists SAM.gov tenders and linked modifications idempotently", async () => {
    const first = await processScan(
      "scan_sam_fixture_first",
      "sam-fixture:first",
      new Date("2026-08-27T22:00:00.000Z"),
    );
    expect(first).toMatchObject({
      discoveredCount: 3,
      retainedCount: 3,
      excludedCount: 0,
      duplicateCount: 0,
    });

    const rows = await env.DB.prepare(`SELECT source_event_id, event_type, addressability_status
      FROM bidding_events WHERE source_id = 'sam-gov' ORDER BY published_at, source_event_id`)
      .all<{
        source_event_id: string;
        event_type: string;
        addressability_status: string;
      }>();
    expect(rows.results).toEqual([
      { source_event_id: "notice-a", event_type: "tender", addressability_status: "uncertain" },
      { source_event_id: "notice-b", event_type: "modification", addressability_status: "uncertain" },
      { source_event_id: "notice-climate", event_type: "tender", addressability_status: "uncertain" },
    ]);

    const second = await processScan(
      "scan_sam_fixture_second",
      "sam-fixture:second",
      new Date("2026-08-28T10:00:00.000Z"),
    );
    expect(second).toMatchObject({
      discoveredCount: 3,
      retainedCount: 0,
      excludedCount: 0,
      duplicateCount: 3,
    });
    const stored = await env.DB.prepare("SELECT COUNT(*) AS total FROM bidding_events WHERE source_id = 'sam-gov'")
      .first<{ total: number }>();
    expect(stored?.total).toBe(3);

    const source = await env.DB.prepare("SELECT cursor_json FROM sources WHERE id = 'sam-gov'")
      .first<{ cursor_json: string }>();
    expect(JSON.parse(source?.cursor_json ?? "{}")).toEqual({
      value: "2026-08-28T10:00:00.000Z",
    });
  });

  it("persists Grants.gov opportunities idempotently", async () => {
    const first = await processGrantsScan(
      "scan_grants_fixture_first",
      "grants-fixture:first",
      new Date("2026-08-27T22:00:00.000Z"),
    );
    expect(first).toMatchObject({
      discoveredCount: 3,
      retainedCount: 3,
      excludedCount: 0,
      duplicateCount: 0,
    });

    const rows = await env.DB.prepare(`SELECT source_event_id, event_type, addressability_status
      FROM bidding_events WHERE source_id = 'grants-gov' ORDER BY published_at, source_event_id`)
      .all<{
        source_event_id: string;
        event_type: string;
        addressability_status: string;
      }>();
    expect(rows.results).toEqual([
      { source_event_id: "331415", event_type: "tender", addressability_status: "uncertain" },
      { source_event_id: "361650", event_type: "tender", addressability_status: "uncertain" },
      { source_event_id: "361701", event_type: "tender", addressability_status: "uncertain" },
    ]);

    const second = await processGrantsScan(
      "scan_grants_fixture_second",
      "grants-fixture:second",
      new Date("2026-08-28T10:00:00.000Z"),
    );
    expect(second).toMatchObject({
      discoveredCount: 3,
      retainedCount: 0,
      excludedCount: 0,
      duplicateCount: 3,
    });
    const stored = await env.DB.prepare("SELECT COUNT(*) AS total FROM bidding_events WHERE source_id = 'grants-gov'")
      .first<{ total: number }>();
    expect(stored?.total).toBe(3);

    const source = await env.DB.prepare("SELECT cursor_json FROM sources WHERE id = 'grants-gov'")
      .first<{ cursor_json: string }>();
    expect(JSON.parse(source?.cursor_json ?? "{}")).toEqual({
      value: "2026-08-28T10:00:00.000Z",
    });
  });
});
