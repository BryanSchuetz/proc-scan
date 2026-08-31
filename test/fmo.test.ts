import { describe, expect, it } from "vitest";
import fixtureHtml from "./fixtures/fmo-open-tenders.html?raw";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createFmoAdapter } from "../src/sources/fmo";

const now = new Date("2026-08-31T10:00:00.000Z");

function scanContext() {
  return {
    signal: new AbortController().signal,
    now,
  };
}

function htmlResponse(html = fixtureHtml): Response {
  return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
}

describe("FMO Source adapter", () => {
  it("maps the complete Open Tenders page using stable reference numbers", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = createFmoAdapter({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: input.toString(), init });
        return htmlResponse();
      }) as typeof fetch,
    });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(scanContext());

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://www.fmo.nl/open-tenders");
    expect(new Headers(requests[0].init?.headers).get("Accept")).toBe("text/html");
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId)).toEqual([
      "2025-SA-Nasira+ OS-005",
      "NDCE-XX-1",
      "FMO-TA-003",
    ]);

    expect(result.candidates[0]).toMatchObject({
      sourceId: "fmo",
      sourceOpportunityId: "2025-SA-Nasira+ OS-005",
      canonicalUrl: "https://www.fmo.nl/open-tenders",
      originalEventType: "Open tender procedure",
      eventType: "tender",
      publishedAt: "2025-11-14T00:00:00.000Z",
      opportunityName: "Nasira+ Onboarding Services",
      description: "The appointed contractor will advise beneficiaries on portfolio selection and reporting. The maximum budget available for the Contract is 3,000,000 EUR, ex VAT.",
      clientName: "FMO",
      procuringEntityName: "FMO",
      value: { amount: 3_000_000, currency: "EUR" },
      dueDate: "2026-02-06T16:00:00.000Z",
      sourceStatus: "listed-open",
      sourceData: {
        referenceNumber: "2025-SA-Nasira+ OS-005",
        originalLanguage: "English",
        valueBasis: "maximum-budget",
        publicationDateBasis: "publication-date",
        deadlineBasis: "submission-deadline",
      },
    });
    expect(result.candidates[1]).toMatchObject({
      opportunityName: "Framework Contract for Technical Assistance Services under the Nasira+ Programme",
      description: expect.stringContaining("digital transformation, institutional strengthening"),
      value: { amount: 6_300_000, currency: "EUR" },
      dueDate: "2026-08-13T15:00:00.000Z",
      sourceData: {
        pageHeading: "Nasira+ Technical Assistance Services Framework Contract",
        rawMaximumBudget: "EUR 6,300,000",
      },
    });
    expect(result.candidates[2]).toMatchObject({
      opportunityName: "Market advisory support",
      value: undefined,
      dueDate: "2026-09-30T10:00:00.000Z",
    });
  });

  it("accepts a valid empty Open Tenders page", async () => {
    const adapter = createFmoAdapter({
      fetch: (async () => htmlResponse(`
        <html><body><h1 class="page__title">Open Tenders</h1></body></html>
      `)) as typeof fetch,
    });

    await expect(adapter.scan(scanContext())).resolves.toEqual({
      candidates: [],
      nextCursor: { value: now.toISOString() },
    });
  });

  it("fails on structural drift and malformed tender dates", async () => {
    const wrongPage = createFmoAdapter({
      fetch: (async () => htmlResponse("<h1 class='page__title'>Procurement</h1>")) as typeof fetch,
    });
    await expect(wrongPage.scan(scanContext())).rejects.toMatchObject({ code: "invalid_response" });

    const malformed = fixtureHtml.replace("6 July 2026", "July sometime");
    const malformedDate = createFmoAdapter({
      fetch: (async () => htmlResponse(malformed)) as typeof fetch,
    });
    await expect(malformedDate.scan(scanContext())).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("classifies HTTP and content-type failures without reflecting response content", async () => {
    const unavailable = createFmoAdapter({
      fetch: (async () => new Response("internal-do-not-reflect", { status: 503 })) as typeof fetch,
    });
    const error = await unavailable.scan(scanContext()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source_unavailable", retryable: true });
    expect(String(error)).not.toContain("internal-do-not-reflect");

    const nonHtml = createFmoAdapter({
      fetch: (async () => Response.json({ records: [] })) as typeof fetch,
    });
    await expect(nonHtml.scan(scanContext())).rejects.toMatchObject({ code: "invalid_response" });
  });
});
