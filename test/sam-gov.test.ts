import { describe, expect, it } from "vitest";
import samGovRaw from "../config/sam-gov.yaml?raw";
import page0 from "./fixtures/sam-gov-page-0.json";
import page1 from "./fixtures/sam-gov-page-1.json";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createSamGovAdapter, parseSamGovConfig } from "../src/sources/sam-gov";

const now = new Date("2026-08-27T22:00:00.000Z");
const samGov = parseSamGovConfig(samGovRaw);

function scanContext(cursor?: { value?: string }) {
  return {
    cursor,
    signal: new AbortController().signal,
    now,
  };
}

describe("SAM.gov Source adapter", () => {
  it("paginates the v2 API by page index and maps pursuable notices", async () => {
    const requests: URL[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(url);
      if (url.searchParams.get("organizationCode") !== "524") {
        return Response.json({ totalRecords: 0, limit: 2, offset: 0, opportunitiesData: [] });
      }
      const page = url.searchParams.get("offset") === "0" ? page0 : page1;
      return Response.json(page);
    }) as typeof fetch;
    const adapter = createSamGovAdapter({
      apiKey: "fixture-key",
      organizations: samGov.organizations,
      fetch: fetcher,
      pageSize: 2,
    });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(scanContext());

    expect(requests).toHaveLength(5);
    expect(requests.map((request) => request.searchParams.get("organizationCode"))).toEqual([
      "524",
      "524",
      "077",
      "011",
      "019",
    ]);
    expect(requests.map((request) => request.searchParams.get("offset"))).toEqual([
      "0",
      "1",
      "0",
      "0",
      "0",
    ]);
    expect(requests[0].searchParams.get("limit")).toBe("2");
    expect(requests[0].searchParams.get("postedFrom")).toBe("08/25/2026");
    expect(requests[0].searchParams.get("postedTo")).toBe("08/27/2026");
    expect(requests[0].searchParams.getAll("ptype")).toEqual(["p", "r", "s", "o", "k", "i"]);
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual([
      "notice-a",
      "notice-b",
      "notice-climate",
    ]);
    expect(result.nextCursor).toEqual({ value: now.toISOString() });

    const solicitation = result.candidates[0];
    expect(solicitation).toMatchObject({
      sourceId: "sam-gov",
      sourceOpportunityId: "524.010:SOL-100",
      canonicalUrl: "https://sam.gov/opp/notice-a/view",
      originalEventType: "Solicitation",
      eventType: "tender",
      publishedAt: "2026-08-26T00:00:00.000Z",
      opportunityName: "Digital strategy advisory support",
      clientName: "DIGITAL SERVICES AGENCY",
      procuringEntityName: "BUYING OFFICE",
      dueDate: "2026-09-20T21:00:00.000Z",
      placeOfPerformance: {
        description: "Nairobi, KENYA",
        countryCode: "KEN",
      },
      eligibility: "Total Small Business Set-Aside (FAR 19.5)",
      sourceStatus: "active",
      sourceData: {
        federalOrganizationCode: "524",
      },
    });
    expect(solicitation.description).toBeUndefined();
    expect(solicitation.documents?.map((document) => document.id)).toEqual([
      "sam-notice",
      "additional-information",
      "attachment-1",
      "attachment-2",
    ]);
    expect(solicitation.documents?.[2].url).toContain("a-attachment.pdf");
    expect(JSON.stringify(solicitation.sourceData)).not.toContain("api_key");
    expect(JSON.stringify(solicitation.sourceData)).not.toContain("fixture-value");
  });

  it("uses the saved cursor date while retaining an inclusive overlap", async () => {
    const requests: URL[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      requests.push(new URL(input instanceof Request ? input.url : input.toString()));
      return Response.json({ totalRecords: 0, limit: 1000, offset: 0, opportunitiesData: [] });
    }) as typeof fetch;
    const adapter = createSamGovAdapter({
      apiKey: "fixture-key",
      organizations: samGov.organizations,
      fetch: fetcher,
    });

    const result = await adapter.scan(scanContext({ value: "2026-08-27T10:00:00.000Z" }));

    expect(result.candidates).toEqual([]);
    expect(requests[0].searchParams.get("postedFrom")).toBe("08/27/2026");
  });

  it("classifies quota failures without exposing the API key", async () => {
    const apiKey = "private-fixture-key";
    const adapter = createSamGovAdapter({
      apiKey,
      organizations: samGov.organizations,
      fetch: (async () => Response.json({ message: "Message throttled out" }, { status: 429 })) as typeof fetch,
    });

    const error = await adapter.scan(scanContext()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "rate_limited",
      retryable: false,
    });
    expect(String(error)).not.toContain(apiKey);
  });

  it("fails safely when a record lacks stable required fields", async () => {
    const adapter = createSamGovAdapter({
      apiKey: "fixture-key",
      organizations: samGov.organizations,
      fetch: (async () => Response.json({
        totalRecords: 1,
        limit: 1000,
        offset: 0,
        opportunitiesData: [{ title: "Missing notice ID", type: "Solicitation" }],
      })) as typeof fetch,
    });

    await expect(adapter.scan(scanContext())).rejects.toMatchObject({
      code: "invalid_record",
    });
  });

  it("rejects a record explicitly owned by a different organization", async () => {
    const adapter = createSamGovAdapter({
      apiKey: "fixture-key",
      organizations: [{ code: "524", name: "Millennium Challenge Corporation" }],
      fetch: (async () => Response.json({
        totalRecords: 1,
        limit: 1000,
        offset: 0,
        opportunitiesData: [{
          noticeId: "wrong-organization",
          title: "Wrong organization",
          type: "Solicitation",
          fullParentPathCode: "077.100.1001",
        }],
      })) as typeof fetch,
    });

    await expect(adapter.scan(scanContext())).rejects.toMatchObject({
      code: "unexpected_organization",
    });
  });
});
