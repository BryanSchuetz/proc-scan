import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import taxonomyRaw from "../tech-area-classification.yaml?raw";
import classificationRaw from "../config/technical-classification.yaml?raw";
import addressabilityRaw from "../config/addressability.yaml?raw";
import grantsGovRaw from "../config/grants-gov.yaml?raw";
import samGovRaw from "../config/sam-gov.yaml?raw";
import grantsAgencyDiscovery from "./fixtures/grants-gov-agencies.json";
import grantsOpportunityDetails from "./fixtures/grants-gov-details.json";
import grantsPage0 from "./fixtures/grants-gov-page-0.json";
import grantsPage1 from "./fixtures/grants-gov-page-1.json";
import page0 from "./fixtures/sam-gov-page-0.json";
import page1 from "./fixtures/sam-gov-page-1.json";
import {
  parseAddressabilityYaml,
  type AddressabilityConfig,
} from "../src/classification/addressability";
import {
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
} from "../src/classification/taxonomy";
import { claimScanRun, completeScanRun, startSourceRun } from "../src/db/scan-runs";
import { syncTechnicalAreas } from "../src/db/taxonomy";
import { runSourceAdapter } from "../src/pipeline/run-source";
import type { SourceAdapter, SourceCandidate } from "../src/sources/adapter";
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

const grantsSearchOnlyDetails: Record<string, unknown> = {
  "331415": {
    errorcode: 0,
    data: { id: 331415, docType: "forecast", forecast: {} },
  },
  "361650": {
    errorcode: 0,
    data: { id: 361650, docType: "synopsis", synopsis: {} },
  },
  "361701": {
    errorcode: 0,
    data: { id: 361701, docType: "synopsis", synopsis: {} },
  },
};

function grantsFixtureAdapter(details: Record<string, unknown> = grantsOpportunityDetails) {
  return createGrantsGovAdapter({
    organizations: grantsGov.organizations,
    pageSize: 2,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected Grants.gov request body");
      const body = JSON.parse(init.body) as {
        agencies?: string;
        opportunityId?: number;
        startRecordNum?: number;
      };
      if (body.opportunityId !== undefined) {
        return Response.json(details[String(body.opportunityId)]);
      }
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

async function processGrantsScan(
  scanRunId: string,
  cycleKey: string,
  now: Date,
  details?: Record<string, unknown>,
) {
  await claimScanRun(env.DB, {
    id: scanRunId,
    cycleKey,
    scheduledFor: now.toISOString(),
  });
  const sourceRunId = await startSourceRun(env.DB, scanRunId, "grants-gov");
  const result = await runSourceAdapter({
    db: env.DB,
    adapter: grantsFixtureAdapter(details),
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

async function processSingleCandidateScan(
  scanRunId: string,
  cycleKey: string,
  now: Date,
  candidate: SourceCandidate,
  addressabilityConfig: AddressabilityConfig = addressability,
) {
  await claimScanRun(env.DB, {
    id: scanRunId,
    cycleKey,
    scheduledFor: now.toISOString(),
  });
  const sourceRunId = await startSourceRun(env.DB, scanRunId, "grants-gov");
  const adapter: SourceAdapter = {
    definition: {
      id: "grants-gov",
      name: "Grants.gov",
      accessMode: "public",
      phase: 1,
      adapterVersion: "fixture-event-transitions",
    },
    async scan() {
      return { candidates: [candidate] };
    },
  };
  const result = await runSourceAdapter({
    db: env.DB,
    adapter,
    sourceRunId,
    scanRunId,
    signal: new AbortController().signal,
    now,
    taxonomy,
    technicalClassification,
    addressability: addressabilityConfig,
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
    'scan_grants_fixture_first', 'scan_grants_fixture_enriched',
    'scan_grants_fixture_repeat', 'scan_grants_fixture_description',
    'scan_grants_fixture_amount',
    'scan_grants_fixture_reclass_first', 'scan_grants_fixture_reclass_second',
    'scan_grants_fixture_cancel_tender', 'scan_grants_fixture_cancelled',
    'scan_sam_fixture_first', 'scan_sam_fixture_second'
  )`).run();
  await env.DB.prepare("UPDATE sources SET cursor_json = NULL WHERE id = 'grants-gov'").run();
  await env.DB.prepare("UPDATE sources SET cursor_json = NULL WHERE id = 'sam-gov'").run();
  await syncTechnicalAreas(env.DB, taxonomy, technicalClassification.schema_version);
});

describe("Source processing integration", () => {
  it("creates a linked SAM.gov Modification for a revised deadline", async () => {
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
      { source_event_id: "notice-a", event_type: "tender", addressability_status: "addressable" },
      { source_event_id: "notice-b", event_type: "modification", addressability_status: "addressable" },
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

  it("enriches Grants.gov tenders in place and creates Modifications only for amount changes", async () => {
    const first = await processGrantsScan(
      "scan_grants_fixture_first",
      "grants-fixture:first",
      new Date("2026-08-27T22:00:00.000Z"),
      grantsSearchOnlyDetails,
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
    const enriched = await processGrantsScan(
      "scan_grants_fixture_enriched",
      "grants-fixture:enriched",
      new Date("2026-08-28T10:00:00.000Z"),
    );
    expect(enriched).toMatchObject({
      discoveredCount: 3,
      retainedCount: 3,
      excludedCount: 0,
      duplicateCount: 0,
    });
    const enrichedRows = await env.DB.prepare(`SELECT event_type, description, value_amount
      FROM bidding_events WHERE source_id = 'grants-gov'`)
      .all<{ event_type: string; description: string | null; value_amount: number | null }>();
    expect(enrichedRows.results).toHaveLength(3);
    expect(enrichedRows.results.every(({ event_type }) => event_type === "tender")).toBe(true);
    expect(enrichedRows.results.every(({ description }) => description !== null)).toBe(true);

    const technicalAreas = await env.DB.prepare(`SELECT ta.id
      FROM bidding_event_technical_areas assignment
      JOIN bidding_events event ON event.id = assignment.bidding_event_id
      JOIN technical_areas ta ON ta.id = assignment.technical_area_id
      WHERE event.source_id = 'grants-gov' AND event.source_event_id = '361701'`)
      .all<{ id: string }>();
    expect(technicalAreas.results.map(({ id }) => id)).toContain("digital-strategy-and-advisory");

    const repeated = await processGrantsScan(
      "scan_grants_fixture_repeat",
      "grants-fixture:repeat",
      new Date("2026-08-28T22:00:00.000Z"),
    );
    expect(repeated).toMatchObject({
      discoveredCount: 3,
      retainedCount: 0,
      excludedCount: 0,
      duplicateCount: 3,
    });

    const descriptionUpdate = structuredClone(grantsOpportunityDetails);
    descriptionUpdate["361701"].data.synopsis.synopsisDesc =
      "<p>Expanded digital transformation and data governance advisory.</p>";
    const descriptionResult = await processGrantsScan(
      "scan_grants_fixture_description",
      "grants-fixture:description",
      new Date("2026-08-29T10:00:00.000Z"),
      descriptionUpdate,
    );
    expect(descriptionResult).toMatchObject({ retainedCount: 1, duplicateCount: 2 });
    const afterDescription = await env.DB.prepare(`SELECT event_type, description
      FROM bidding_events WHERE source_id = 'grants-gov' AND source_event_id = '361701'`)
      .first<{ event_type: string; description: string }>();
    expect(afterDescription).toEqual({
      event_type: "tender",
      description: "Expanded digital transformation and data governance advisory.",
    });

    const amountUpdate = structuredClone(descriptionUpdate);
    amountUpdate["361701"].data.synopsis.estimatedFunding = "3000000";
    const amountResult = await processGrantsScan(
      "scan_grants_fixture_amount",
      "grants-fixture:amount",
      new Date("2026-08-29T22:00:00.000Z"),
      amountUpdate,
    );
    expect(amountResult).toMatchObject({ retainedCount: 1, duplicateCount: 2 });
    const stored = await env.DB.prepare(`SELECT event_type, value_amount
      FROM bidding_events WHERE source_id = 'grants-gov' AND source_event_id = '361701'
      ORDER BY discovered_at`)
      .all<{ event_type: string; value_amount: number | null }>();
    expect(stored.results).toEqual([
      { event_type: "tender", value_amount: 2_000_000 },
      { event_type: "modification", value_amount: 3_000_000 },
    ]);

    const source = await env.DB.prepare("SELECT cursor_json FROM sources WHERE id = 'grants-gov'")
      .first<{ cursor_json: string }>();
    expect(JSON.parse(source?.cursor_json ?? "{}")).toEqual({
      value: "2026-08-29T22:00:00.000Z",
    });
  });

  it("reclassifies an unchanged event in place when the Addressability config advances", async () => {
    const candidate: SourceCandidate = {
      sourceId: "grants-gov",
      sourceEventId: "reclass-fixture",
      sourceOpportunityId: "reclass-fixture",
      canonicalUrl: "https://grants.gov/search-results-detail/reclass-fixture",
      eventType: "tender",
      publishedAt: "2026-08-30T10:00:00.000Z",
      opportunityName: "General program",
      description: "General program",
      value: { amount: 2_000_000, currency: "USD" },
      dueDate: "2026-10-01T17:00:00.000Z",
      sourceData: { federalOrganizationCode: "019" },
    };
    const first = await processSingleCandidateScan(
      "scan_grants_fixture_reclass_first",
      "grants-fixture:reclass-first",
      new Date("2026-08-30T10:00:00.000Z"),
      candidate,
    );
    expect(first).toMatchObject({ retainedCount: 1, duplicateCount: 0 });

    const revisedAddressability = {
      ...addressability,
      schema_version: addressability.schema_version + 1,
    };
    const second = await processSingleCandidateScan(
      "scan_grants_fixture_reclass_second",
      "grants-fixture:reclass-second",
      new Date("2026-08-30T22:00:00.000Z"),
      candidate,
      revisedAddressability,
    );
    expect(second).toMatchObject({ retainedCount: 1, duplicateCount: 0 });

    const events = await env.DB.prepare(`SELECT event_type, addressability_status,
      addressability_score, addressability_config_version
      FROM bidding_events WHERE source_id = 'grants-gov' AND source_event_id = 'reclass-fixture'`)
      .all<{
        event_type: string;
        addressability_status: string;
        addressability_score: number;
        addressability_config_version: number;
      }>();
    expect(events.results).toEqual([{
      event_type: "tender",
      addressability_status: "uncertain",
      addressability_score: 0,
      addressability_config_version: revisedAddressability.schema_version,
    }]);
  });

  it("retains an explicit Cancellation as a separate Bidding Event", async () => {
    const tender: SourceCandidate = {
      sourceId: "grants-gov",
      sourceEventId: "cancel-fixture",
      sourceOpportunityId: "cancel-fixture",
      canonicalUrl: "https://grants.gov/search-results-detail/cancel-fixture",
      eventType: "tender",
      publishedAt: "2026-08-30T10:00:00.000Z",
      opportunityName: "Cancellation fixture",
      value: { amount: 750_000, currency: "USD" },
      dueDate: "2026-10-01T17:00:00.000Z",
      sourceData: {},
    };
    await processSingleCandidateScan(
      "scan_grants_fixture_cancel_tender",
      "grants-fixture:cancel-tender",
      new Date("2026-08-30T10:00:00.000Z"),
      tender,
    );
    await processSingleCandidateScan(
      "scan_grants_fixture_cancelled",
      "grants-fixture:cancelled",
      new Date("2026-08-30T22:00:00.000Z"),
      {
        ...tender,
        eventType: "cancellation",
        publishedAt: "2026-08-30T22:00:00.000Z",
        sourceStatus: "cancelled",
      },
    );

    const events = await env.DB.prepare(`SELECT event_type
      FROM bidding_events WHERE source_id = 'grants-gov' AND source_event_id = 'cancel-fixture'
      ORDER BY discovered_at`)
      .all<{ event_type: string }>();
    expect(events.results.map(({ event_type }) => event_type)).toEqual(["tender", "cancellation"]);
  });
});
