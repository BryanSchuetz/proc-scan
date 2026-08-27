import { describe, expect, it } from "vitest";
import grantsGovRaw from "../config/grants-gov.yaml?raw";
import agencyDiscovery from "./fixtures/grants-gov-agencies.json";
import opportunityDetails from "./fixtures/grants-gov-details.json";
import page0 from "./fixtures/grants-gov-page-0.json";
import page1 from "./fixtures/grants-gov-page-1.json";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createGrantsGovAdapter, parseGrantsGovConfig } from "../src/sources/grants-gov";

const now = new Date("2026-08-27T22:00:00.000Z");
const grantsGov = parseGrantsGovConfig(grantsGovRaw);

function scanContext() {
  return {
    signal: new AbortController().signal,
    now,
  };
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("Grants.gov Source adapter", () => {
  it("discovers approved agency codes, paginates, and maps open opportunities", async () => {
    const requests: Record<string, unknown>[] = [];
    const detailRequests: number[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init);
      if (typeof body.opportunityId === "number") {
        detailRequests.push(body.opportunityId);
        return Response.json(opportunityDetails[String(body.opportunityId) as keyof typeof opportunityDetails]);
      }
      requests.push(body);
      if (!body.agencies) return Response.json(agencyDiscovery);
      return Response.json(body.startRecordNum === 0 ? page0 : page1);
    }) as typeof fetch;
    const adapter = createGrantsGovAdapter({
      organizations: grantsGov.organizations,
      fetch: fetcher,
      pageSize: 2,
    });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(scanContext());

    expect(requests).toEqual([
      {
        rows: 1,
        startRecordNum: 0,
        oppStatuses: "forecasted|posted",
      },
      {
        rows: 2,
        startRecordNum: 0,
        agencies: "DOS|DOS-DRL|DOS-INL|MCC",
        oppStatuses: "forecasted|posted",
        sortBy: "openDate|desc",
      },
      {
        rows: 2,
        startRecordNum: 2,
        agencies: "DOS|DOS-DRL|DOS-INL|MCC",
        oppStatuses: "forecasted|posted",
        sortBy: "openDate|desc",
      },
    ]);
    expect(detailRequests.sort((a, b) => a - b)).toEqual([331415, 361650, 361701]);
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual([
      "331415",
      "361650",
      "361701",
    ]);
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates[1]).toMatchObject({
      clientName: "Bureau of International Narcotics-Law Enforcement",
      sourceData: { assistanceListingNumbers: ["19.703", "19.704"] },
    });

    const opportunity = result.candidates[2];
    expect(opportunity).toMatchObject({
      sourceId: "grants-gov",
      sourceEventId: "361701",
      sourceOpportunityId: "DOS-DRL-FY26-01",
      canonicalUrl: "https://www.grants.gov/search-results-detail/361701",
      originalEventType: "synopsis",
      eventType: "tender",
      publishedAt: "2026-08-26T00:00:00.000Z",
      opportunityName: "Digital rights and civic technology program",
      description: "The activity includes a digital ecosystem assessment & digital transformation advisory.",
      clientName: "Bureau of Democracy Human Rights and Labor",
      value: { amount: 2_000_000, currency: "USD" },
      dueDate: "2026-09-30T00:00:00.000Z",
      eligibility: "Nonprofit and for-profit organizations are eligible.",
      sourceStatus: "posted",
      sourceData: {
        federalOrganizationCode: "019",
        agencyCode: "DOS-DRL",
        assistanceListingNumbers: ["19.345"],
        estimatedFunding: 2_000_000,
        awardCeiling: 1_000_000,
        awardFloor: 250_000,
        valueBasis: "estimated-total-funding",
      },
    });
    expect(opportunity.documents).toEqual([{
      id: "grants-gov-opportunity",
      title: "Grants.gov opportunity",
      url: "https://www.grants.gov/search-results-detail/361701",
      documentType: "synopsis",
    }]);
  });

  it("returns an empty scan when none of the approved organizations is advertised", async () => {
    const requests: Record<string, unknown>[] = [];
    const adapter = createGrantsGovAdapter({
      organizations: grantsGov.organizations,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(requestBody(init));
        return Response.json({
          errorcode: 0,
          data: {
            hitCount: 1,
            startRecord: 0,
            oppHits: [],
            agencies: [{ label: "Health and Human Services", value: "HHS", count: 1 }],
          },
        });
      }) as typeof fetch,
    });

    const result = await adapter.scan(scanContext());

    expect(result.candidates).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("rejects an opportunity outside the approved agency hierarchy", async () => {
    const adapter = createGrantsGovAdapter({
      organizations: grantsGov.organizations,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = requestBody(init);
        if (!body.agencies) return Response.json(agencyDiscovery);
        return Response.json({
          errorcode: 0,
          data: {
            hitCount: 1,
            startRecord: 0,
            oppHits: [{
              id: "999999",
              number: "HHS-OUT-OF-SCOPE",
              title: "Out of scope",
              agencyCode: "HHS",
              agencyName: "Health and Human Services",
              oppStatus: "posted",
            }],
          },
        });
      }) as typeof fetch,
    });

    await expect(adapter.scan(scanContext())).rejects.toMatchObject({
      code: "unexpected_organization",
    });
  });

  it("fails safely when an opportunity lacks required stable fields", async () => {
    const adapter = createGrantsGovAdapter({
      organizations: grantsGov.organizations,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = requestBody(init);
        if (!body.agencies) return Response.json(agencyDiscovery);
        return Response.json({
          errorcode: 0,
          data: {
            hitCount: 1,
            startRecord: 0,
            oppHits: [{ id: "361701", agencyCode: "DOS-DRL" }],
          },
        });
      }) as typeof fetch,
    });

    await expect(adapter.scan(scanContext())).rejects.toMatchObject({
      code: "invalid_record",
    });
  });

  it("classifies HTTP failures without reflecting response content", async () => {
    const adapter = createGrantsGovAdapter({
      organizations: grantsGov.organizations,
      fetch: (async () => Response.json({ internal: "do-not-reflect" }, { status: 503 })) as typeof fetch,
    });

    const error = await adapter.scan(scanContext()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source_unavailable", retryable: true });
    expect(String(error)).not.toContain("do-not-reflect");
  });
});
