import { describe, expect, it } from "vitest";
import configRaw from "../config/eu-funding-tenders.yaml?raw";
import page1 from "./fixtures/eu-funding-tenders-page-1.json";
import page2 from "./fixtures/eu-funding-tenders-page-2.json";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import {
  createEuFundingTendersAdapter,
  parseEuFundingTendersConfig,
} from "../src/sources/eu-funding-tenders";

const now = new Date("2026-08-29T10:00:00.000Z");
const config = parseEuFundingTendersConfig(configRaw);

function scanContext() {
  return {
    signal: new AbortController().signal,
    now,
  };
}

async function jsonFormPart(body: FormData, name: string): Promise<unknown> {
  const part = body.get(name);
  if (part === null) throw new Error(`Missing ${name} form part`);
  return JSON.parse(typeof part === "string" ? part : await part.text());
}

function fixtureFetcher(requests: Array<{ url: URL; body: FormData }> = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!(init?.body instanceof FormData)) throw new Error("Expected a multipart request body");
    requests.push({ url, body: init.body });
    return Response.json(url.searchParams.get("pageNumber") === "2" ? page2 : page1);
  }) as typeof fetch;
}

describe("EU Funding & Tenders Source adapter", () => {
  it("paginates open tender calls and maps only approved lead authorities", async () => {
    const requests: Array<{ url: URL; body: FormData }> = [];
    const adapter = createEuFundingTendersAdapter({
      config,
      fetch: fixtureFetcher(requests),
      pageSize: 3,
    });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(scanContext());

    expect(requests).toHaveLength(2);
    expect(requests.map(({ url }) => url.searchParams.get("pageNumber"))).toEqual(["1", "2"]);
    expect(requests[0].url.searchParams.get("apiKey")).toBe("SEDIA");
    expect(requests[0].url.searchParams.get("text")).toBe("***");
    expect(requests[0].url.searchParams.get("pageSize")).toBe("3");
    await expect(jsonFormPart(requests[0].body, "query")).resolves.toEqual({
      bool: {
        must: [
          { terms: { type: ["0"] } },
          { terms: { status: ["31094501", "31094502"] } },
        ],
      },
    });
    await expect(jsonFormPart(requests[0].body, "sort")).resolves.toEqual({
      order: "DESC",
      field: "startDate",
    });
    await expect(jsonFormPart(requests[0].body, "languages")).resolves.toEqual(["en"]);
    await expect(jsonFormPart(requests[0].body, "displayFields")).resolves.toEqual(
      expect.arrayContaining([
        "cftLeadContractingAuthorityCode",
        "cftEstimatedTotalProcedureValue",
        "cftCorrigendaList",
      ]),
    );

    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId)).toEqual([
      "11111111-1111-4111-8111-111111111111-PIN",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "44444444-4444-4444-8444-444444444444-CN",
    ]);
    expect(result.candidates.map(({ opportunityName }) => opportunityName)).not.toContain("Laboratory supplies");
    expect(result.candidates.map(({ opportunityName }) => opportunityName)).not.toContain("Development research services");

    expect(result.candidates[0]).toMatchObject({
      sourceId: "eu-funding-tenders",
      sourceOpportunityId: "11111111-1111-4111-8111-111111111111",
      canonicalUrl: "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/tender-details/11111111-1111-4111-8111-111111111111-PIN",
      originalEventType: "prior-information-notice",
      eventType: "tender",
      publishedAt: "2026-08-20T00:00:00.000Z",
      discoveredAt: now.toISOString(),
      opportunityName: "Climate resilience advisory programme",
      description: "Policy advisory and capacity building for climate resilience.\nRegional implementation support.",
      clientName: "European Climate, Infrastructure and Environment Executive Agency (CINEA), CINEA - European Climate",
      value: { amount: 999_999, currency: "EUR" },
      sourceStatus: "forthcoming",
      sourceData: {
        callIdentifier: "CINEA/2026/OP/0042-PIN",
        clientFilter: "DG CINEA",
        noticeKind: "prior-information-notice",
        statusCode: "31094501",
        valueBasis: "estimated-total-procedure-value",
        publicationDateBasis: "eforms-publication-date",
        mainCpvCodes: ["79410000"],
      },
    });

    expect(result.candidates[1]).toMatchObject({
      sourceOpportunityId: "22222222-2222-4222-8222-222222222222",
      originalEventType: "CHANGE_CONTRACT_NOTICE",
      eventType: "modification",
      isFormalAmendment: true,
      publishedAt: "2026-08-22T00:00:00.000Z",
      opportunityName: "Supply of computers and equipment",
      value: { amount: 1_000_000, currency: "EUR" },
      dueDate: "2026-10-01T16:00:59.000Z",
      sourceData: {
        clientFilter: "DG GROW",
        deadlineBasis: "deadline-date",
        publicationDateBasis: "corrigendum-publication-date",
        portalReference: "22222222-2222-4222-8222-222222222222-CN",
      },
    });
    expect(result.candidates[2]).toMatchObject({
      clientName: "Commission européenne, INTPA - International Partnerships",
      description: "Technical assistance, training and implementation support for public digital services.",
      value: { amount: 3_000_000, currency: "EUR" },
      dueDate: "2026-10-15T14:00:59.000Z",
      sourceStatus: "open",
      sourceData: {
        clientFilter: "DG INTPA",
        deadlineBasis: "two-stage-deadline",
      },
    });
  });

  it("returns an empty full snapshot", async () => {
    const adapter = createEuFundingTendersAdapter({
      config,
      fetch: (async () => Response.json({
        totalResults: 0,
        pageNumber: 1,
        pageSize: 100,
        results: [],
      })) as typeof fetch,
    });

    await expect(adapter.scan(scanContext())).resolves.toEqual({
      candidates: [],
      nextCursor: { value: now.toISOString() },
    });
  });

  it("rejects malformed pagination and out-of-scope records", async () => {
    const emptyPageAdapter = createEuFundingTendersAdapter({
      config,
      pageSize: 3,
      fetch: (async () => Response.json({
        totalResults: 1,
        pageNumber: 1,
        pageSize: 3,
        results: [],
      })) as typeof fetch,
    });
    await expect(emptyPageAdapter.scan(scanContext())).rejects.toMatchObject({
      code: "invalid_pagination",
    });

    const result = structuredClone(page1.results[0]);
    result.metadata.type = ["1"];
    const outOfScopeAdapter = createEuFundingTendersAdapter({
      config,
      pageSize: 1,
      fetch: (async () => Response.json({
        totalResults: 1,
        pageNumber: 1,
        pageSize: 1,
        results: [result],
      })) as typeof fetch,
    });
    await expect(outOfScopeAdapter.scan(scanContext())).rejects.toMatchObject({
      code: "unexpected_scope",
    });
  });

  it("classifies public API failures without reflecting response content", async () => {
    const adapter = createEuFundingTendersAdapter({
      config,
      fetch: (async () => Response.json({ internal: "do-not-reflect" }, { status: 503 })) as typeof fetch,
    });

    const error = await adapter.scan(scanContext()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source_unavailable", retryable: true });
    expect(String(error)).not.toContain("do-not-reflect");
  });
});
