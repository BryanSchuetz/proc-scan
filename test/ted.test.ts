import { describe, expect, it } from "vitest";
import tedRaw from "../config/ted.yaml?raw";
import page0 from "./fixtures/ted-page-0.json";
import page1 from "./fixtures/ted-page-1.json";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createTedAdapter, parseTedConfig } from "../src/sources/ted";

const now = new Date("2026-08-28T10:00:00.000Z");
const config = parseTedConfig(tedRaw);

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

function fixtureFetcher(requests: Record<string, unknown>[] = []) {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = requestBody(init);
    requests.push(body);
    if (body.iterationNextToken === "ted-page-2") return Response.json(page1);
    if (body.iterationNextToken === "ted-finished") {
      return Response.json({
        totalNoticeCount: 5,
        timedOut: false,
        notices: [],
      });
    }
    return Response.json(page0);
  }) as typeof fetch;
}

describe("TED Source adapter", () => {
  it("iterates the active external-aid snapshot and maps pursuable notices", async () => {
    const requests: Record<string, unknown>[] = [];
    const adapter = createTedAdapter({
      config,
      fetch: fixtureFetcher(requests),
      pageSize: 2,
    });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(scanContext());

    expect(requests).toHaveLength(3);
    expect(requests.map(({ iterationNextToken }) => iterationNextToken)).toEqual([
      undefined,
      "ted-page-2",
      "ted-finished",
    ]);
    expect(requests[0]).toMatchObject({
      query: "(funding IN (external-aid-program)) AND (buyer-name IN (AGRI CLIMA ECHO CINEA GROW IDEA REA INTPA DEV ENEST MENA TRADE)) SORT BY publication-number DESC",
      limit: 2,
      scope: "ACTIVE",
      checkQuerySyntax: false,
      paginationMode: "ITERATION",
      onlyLatestVersions: false,
    });
    expect(requests[0].fields).toEqual(expect.arrayContaining([
      "notice-title",
      "description-proc",
      "estimated-value-proc",
      "estimated-value-cur-proc",
    ]));
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual([
      "planning-notice-01",
      "original-notice-01",
      "change-notice-01",
      "goods-notice-02",
    ]);
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).not.toContain("result-notice-01");

    expect(result.candidates[0]).toMatchObject({
      sourceId: "ted",
      sourceOpportunityId: "planning-notice",
      canonicalUrl: "https://ted.europa.eu/en/notice/-/detail/100001-2026",
      originalEventType: "pin-only",
      eventType: "tender",
      publishedAt: "2026-08-20T00:00:00.000Z",
      opportunityName: "Climate resilience programme",
      description: "Advance notice of climate policy advisory services.",
      clientName: "European Commission, INTPA",
      value: { amount: 750_000, currency: "EUR" },
      placeOfPerformance: { description: "MMR", countryCode: "MMR" },
      sourceStatus: "active",
      sourceData: {
        publicationNumber: "100001-2026",
        noticeVersionIdentifier: "planning-notice-01",
        funding: ["external-aid-program"],
        classificationCpv: ["79410000"],
        clientFilter: "DG INTPA",
        procedureEstimatedValue: 750_000,
        procedureEstimatedValueCurrency: "EUR",
        valueBasis: "estimated-procedure-value",
        xmlUrl: "https://ted.europa.eu/en/notice/100001-2026/xml",
      },
    });

    expect(result.candidates[1]).toMatchObject({
      sourceOpportunityId: "procedure-digital",
      eventType: "tender",
      clientName: "European Commission, IDEA - Inspire, Debate, Engage and Accelerate Action",
      opportunityName: "Digital government advisory",
      description: "Technical assistance for digital public services.\nDigital strategy support\nCapacity building and implementation support.",
      value: { amount: 3_000_000, currency: "EUR" },
      dueDate: "2026-10-08T12:30:59.000Z",
      sourceData: {
        classificationCpv: ["72000000"],
        clientFilter: "DG IDEA",
        deadlineBasis: "tender-deadline",
      },
    });
    expect(result.candidates[2]).toMatchObject({
      sourceOpportunityId: "procedure-digital",
      eventType: "modification",
      isFormalAmendment: true,
      dueDate: "2026-10-15T14:00:59.000Z",
      sourceData: {
        changeNoticeVersionIdentifier: "original-notice-01",
        changeDescription: ["The participation deadline was extended."],
        deadlineBasis: "request-deadline",
      },
    });
    expect(result.candidates[3]).toMatchObject({
      eventType: "tender",
      opportunityName: "Supply of computers and equipment",
      value: undefined,
      dueDate: "2026-10-20T16:00:59.000Z",
    });
  });

  it("filters buyers that do not identify an approved DG client", async () => {
    const notice = {
      ...page0.notices[1],
      "buyer-name": {
        eng: ["International Development Agency"],
      },
    };
    const adapter = createTedAdapter({
      config,
      fetch: (async () => Response.json({
        totalNoticeCount: 1,
        timedOut: false,
        notices: [notice],
      })) as typeof fetch,
    });

    await expect(adapter.scan(scanContext())).resolves.toEqual({
      candidates: [],
      nextCursor: { value: now.toISOString() },
    });
  });

  it("returns an empty full snapshot", async () => {
    const adapter = createTedAdapter({
      config,
      fetch: (async () => Response.json({
        totalNoticeCount: 0,
        timedOut: false,
        notices: [],
      })) as typeof fetch,
    });

    await expect(adapter.scan(scanContext())).resolves.toEqual({
      candidates: [],
      nextCursor: { value: now.toISOString() },
    });
  });

  it("rejects malformed or out-of-scope notices", async () => {
    for (const [notice, code] of [
      [{
        "notice-identifier": "missing-publication-number",
        "notice-version": 1,
        "publication-date": "2026-08-20Z",
        "notice-type": "cn-standard",
        "form-type": "competition",
        funding: ["external-aid-program"],
      }, "invalid_record"],
      [{
        ...page0.notices[2],
        funding: ["national-funds"],
      }, "unexpected_scope"],
    ] as const) {
      const adapter = createTedAdapter({
        config,
        fetch: (async () => Response.json({
          totalNoticeCount: 1,
          timedOut: false,
          notices: [notice],
        })) as typeof fetch,
      });
      await expect(adapter.scan(scanContext())).rejects.toMatchObject({ code });
    }
  });

  it("classifies public API failures without reflecting response content", async () => {
    const adapter = createTedAdapter({
      config,
      fetch: (async () => Response.json({ internal: "do-not-reflect" }, { status: 503 })) as typeof fetch,
    });

    const error = await adapter.scan(scanContext()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source_unavailable", retryable: true });
    expect(String(error)).not.toContain("do-not-reflect");
  });
});
