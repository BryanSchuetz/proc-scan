import { describe, expect, it } from "vitest";
import detailsFixture from "./fixtures/eib-details.json";
import listPage0 from "./fixtures/eib-list-page-0.json";
import listPage1 from "./fixtures/eib-list-page-1.json";
import tedFixture from "./fixtures/eib-ted.json";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createEibAdapter } from "../src/sources/eib";

const now = new Date("2026-08-31T10:00:00.000Z");
const details = detailsFixture as Record<string, unknown>;

function scanContext() {
  return {
    signal: new AbortController().signal,
    now,
  };
}

function fixtureFetcher(requests: Array<{ url: URL; init?: RequestInit }> = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    requests.push({ url, init });
    if (url.hostname === "api.ted.europa.eu") {
      const query = String(requestBody(init).query);
      const notices = tedFixture.notices.filter((notice) =>
        query.includes(notice["publication-number"])
      );
      return Response.json({ ...tedFixture, notices, totalNoticeCount: notices.length });
    }
    if (url.pathname.includes("/app/list/")) {
      return Response.json(url.searchParams.get("pageNumber") === "1" ? listPage1 : listPage0);
    }
    const id = url.pathname.split("/").at(-1) ?? "";
    return Response.json(details[id]);
  }) as typeof fetch;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("EIB Procurement Source adapter", () => {
  it("paginates open TA Operations and enriches active records from TED", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const adapter = createEibAdapter({ fetch: fixtureFetcher(requests), pageSize: 2 });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(scanContext());

    expect(requests).toHaveLength(5);
    const listRequests = requests.filter(({ url }) => url.pathname.includes("/app/list/"));
    expect(listRequests.map(({ url }) => url.searchParams.get("pageNumber"))).toEqual(["0", "1"]);
    expect(listRequests[0].url.searchParams.get("procurementStatus")).toBe("onGoing");
    expect(listRequests[0].url.searchParams.get("_g_procurementInformations_type"))
      .toBe("call-technical-assistance");
    expect(new Headers(listRequests[0].init?.headers).get("User-Agent"))
      .toBe("proc-scan/1.0 (+https://github.com/BryanSchuetz/proc-scan)");
    expect(requests.map(({ url }) => url.pathname)).not.toEqual(expect.arrayContaining([
      expect.stringContaining("eib-expired"),
      expect.stringContaining("eib-no-deadline"),
    ]));

    const tedRequest = requests.find(({ url }) => url.hostname === "api.ted.europa.eu");
    expect(requestBody(tedRequest?.init)).toMatchObject({
      query: "(publication-number = 111111-2026 OR publication-number = 464153-2026)",
      limit: 2,
      scope: "ALL",
      paginationMode: "PAGE_NUMBER",
      page: 1,
      onlyLatestVersions: true,
    });
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId)).toEqual([
      "eib-active-high",
      "eib-active-low",
    ]);
    expect(result.candidates[0]).toMatchObject({
      sourceId: "eib",
      sourceEventId: "eib-active-high",
      sourceOpportunityId: "AA-012824-001",
      canonicalUrl: "https://www.eib.org/en/about/procurement/calls-technical-assistance/all/aa-012824001",
      originalEventType: "TA operations",
      eventType: "tender",
      publishedAt: "2026-07-06T00:00:00.000Z",
      opportunityName: "Preparatory studies for vaccines production capacity increase project in Egypt",
      description: "Technical assistance for vaccine manufacturing feasibility and market analysis.",
      clientName: "EIB",
      procuringEntityName: "European Investment Bank",
      value: { amount: 750_000, currency: "EUR" },
      dueDate: "2026-09-24T10:00:00.000Z",
      placeOfPerformance: { description: "EGY", countryCode: "EGY" },
      sourceStatus: "on-going",
      sourceData: {
        eibReference: "AA-012824-001",
        tedPublicationNumber: "464153-2026",
        tedValuePublicationNumber: "464153-2026",
        valueBasis: "estimated-procedure-value",
        deadlineBasis: "ted-tender-deadline",
        classificationCpv: ["71356200"],
      },
    });
    expect(result.candidates[1]).toMatchObject({
      sourceOpportunityId: "AA-013468-001",
      opportunityName: "Critical raw materials heatmap",
      description: "Conseil technique et analyse des chaînes d’approvisionnement.",
      value: { amount: 400_000, currency: "EUR" },
      dueDate: "2026-09-09T16:59:59.000Z",
      sourceData: {
        valueBasis: "sum-estimated-lot-values",
      },
    });
  });

  it("returns an empty active snapshot without requesting detail or TED", async () => {
    const requests: string[] = [];
    const adapter = createEibAdapter({
      fetch: (async (input: RequestInfo | URL) => {
        requests.push(input.toString());
        return Response.json({
          valid: true,
          pageNumber: 0,
          itemPerPage: 100,
          resultItems: 0,
          totalItems: 0,
          data: [],
        });
      }) as typeof fetch,
    });

    await expect(adapter.scan(scanContext())).resolves.toEqual({
      candidates: [],
      nextCursor: { value: now.toISOString() },
    });
    expect(requests).toHaveLength(1);
  });

  it("uses TED's exact deadline when an EIB closing date is today", async () => {
    const beforeDeadline = createEibAdapter({ fetch: fixtureFetcher(), pageSize: 2 });
    const before = await beforeDeadline.scan({
      ...scanContext(),
      now: new Date("2026-09-24T09:00:00.000Z"),
    });
    expect(before.candidates.map(({ sourceEventId }) => sourceEventId)).toEqual(["eib-active-high"]);

    const afterDeadline = createEibAdapter({ fetch: fixtureFetcher(), pageSize: 2 });
    const after = await afterDeadline.scan({
      ...scanContext(),
      now: new Date("2026-09-24T11:00:00.000Z"),
    });
    expect(after.candidates).toEqual([]);
  });

  it("rejects scope drift and inconsistent pagination", async () => {
    const outOfScope = {
      ...listPage0,
      data: [{ ...listPage0.data[0], subType: "procurements-call-supplies" }],
      resultItems: 1,
      totalItems: 1,
    };
    const scopeAdapter = createEibAdapter({
      fetch: (async () => Response.json(outOfScope)) as typeof fetch,
      pageSize: 2,
    });
    await expect(scopeAdapter.scan(scanContext())).rejects.toMatchObject({ code: "unexpected_scope" });

    const badPagination = { ...listPage0, resultItems: 1 };
    const paginationAdapter = createEibAdapter({
      fetch: (async () => Response.json(badPagination)) as typeof fetch,
      pageSize: 2,
    });
    await expect(paginationAdapter.scan(scanContext())).rejects.toMatchObject({ code: "invalid_pagination" });
  });

  it("classifies EIB and TED failures without reflecting response content", async () => {
    const unavailable = createEibAdapter({
      fetch: (async () => Response.json({ internal: "do-not-reflect" }, { status: 503 })) as typeof fetch,
    });
    const error = await unavailable.scan(scanContext()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source_unavailable", retryable: true });
    expect(String(error)).not.toContain("do-not-reflect");

    const requests: string[] = [];
    const tedUnavailable = createEibAdapter({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input.toString());
        requests.push(url.hostname);
        if (url.hostname === "api.ted.europa.eu") {
          return Response.json({ internal: "do-not-reflect" }, { status: 503 });
        }
        return fixtureFetcher()(input, init);
      }) as typeof fetch,
      pageSize: 2,
    });
    await expect(tedUnavailable.scan(scanContext())).rejects.toMatchObject({
      code: "source_unavailable",
      retryable: true,
    });
    expect(requests).toContain("api.ted.europa.eu");
  });
});
