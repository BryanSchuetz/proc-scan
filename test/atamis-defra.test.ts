import { describe, expect, it } from "vitest";
import fixtureCsv from "./fixtures/atamis-defra.csv?raw";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createAtamisDefraAdapter } from "../src/sources/atamis-defra";

const now = new Date("2026-08-31T10:00:00.000Z");

function scanContext() {
  return {
    signal: new AbortController().signal,
    now,
  };
}

function csvResponse(csv = fixtureCsv): Response {
  return new Response(csv, {
    headers: { "Content-Type": "application/vnd.ms-excel; charset=UTF-8" },
  });
}

describe("DEFRA Atamis Source adapter", () => {
  it("maps the complete public catalogue snapshot and omits closed or stale rows", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = createAtamisDefraAdapter({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: input.toString(), init });
        return csvResponse();
      }) as typeof fetch,
    });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(scanContext());

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("/ProSpend__CS_DownloadCSV?");
    expect(new Headers(requests[0].init?.headers).get("Accept"))
      .toBe("text/csv, application/vnd.ms-excel");
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId)).toEqual([
      "C35105",
      "C35140",
      "C35150",
    ]);

    expect(result.candidates[0]).toMatchObject({
      sourceId: "atamis-defra",
      sourceOpportunityId: "C35105",
      canonicalUrl: "https://atamis-9529.my.salesforce-sites.com/?SearchType=Projects&searchStr=C35105&sortStr=Recently+Published",
      originalEventType: "Atamis opportunity",
      eventType: "tender",
      publishedAt: "2026-08-19T00:00:00.000Z",
      opportunityName: "Supply of field equipment",
      description: "Ground care equipment and materials",
      clientName: "DEFRA",
      dueDate: "2026-09-30T00:00:00.000Z",
      sourceStatus: "< 1 month",
      sourceData: {
        reference: "C35105",
        category: "Fleet - Unclassified",
        clientMappingBasis: "defra-atamis-catalogue",
        deadlineBasis: "response-deadline-date",
      },
    });
    expect(result.candidates[1]).toMatchObject({
      description: "Technical assistance, monitoring and \"specialist\" advisory services",
      sourceData: { opensOn: "28/08/2026" },
    });
    expect(result.candidates[2]).toMatchObject({
      opportunityName: "Deadline-day consultancy",
      dueDate: "2026-08-31T00:00:00.000Z",
    });
  });

  it("accepts a valid empty catalogue", async () => {
    const adapter = createAtamisDefraAdapter({
      fetch: (async () => csvResponse(`${fixtureCsv.split("\n")[0]}\n`)) as typeof fetch,
    });

    await expect(adapter.scan(scanContext())).resolves.toEqual({
      candidates: [],
      nextCursor: { value: now.toISOString() },
    });
  });

  it("fails on changed columns, duplicate references, and malformed active dates", async () => {
    const changedColumns = createAtamisDefraAdapter({
      fetch: (async () => csvResponse(fixtureCsv.replace("Time Remaining", "Status"))) as typeof fetch,
    });
    await expect(changedColumns.scan(scanContext())).rejects.toMatchObject({ code: "invalid_response" });

    const duplicate = createAtamisDefraAdapter({
      fetch: (async () => csvResponse(`${fixtureCsv}${fixtureCsv.split("\n")[1]}\n`)) as typeof fetch,
    });
    await expect(duplicate.scan(scanContext())).rejects.toMatchObject({ code: "invalid_response" });

    const malformedDate = createAtamisDefraAdapter({
      fetch: (async () => csvResponse(fixtureCsv.replace("30/09/2026", "September 2026"))) as typeof fetch,
    });
    await expect(malformedDate.scan(scanContext())).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("classifies HTTP and content-type failures without reflecting response content", async () => {
    const unavailable = createAtamisDefraAdapter({
      fetch: (async () => new Response("internal-do-not-reflect", { status: 503 })) as typeof fetch,
    });
    const error = await unavailable.scan(scanContext()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source_unavailable", retryable: true });
    expect(String(error)).not.toContain("internal-do-not-reflect");

    const nonCsv = createAtamisDefraAdapter({
      fetch: (async () => new Response("<html>login</html>", {
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch,
    });
    await expect(nonCsv.scan(scanContext())).rejects.toMatchObject({ code: "invalid_response" });
  });
});
