import { describe, expect, it } from "vitest";
import searchHtml from "./fixtures/ecepp-search.html?raw";
import detailHtml from "./fixtures/ecepp-detail.html?raw";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createEceppAdapter } from "../src/sources/ecepp";
import { createRegisteredSourceAdapter } from "../src/sources";
import type { SourceConfigurations } from "../src/sources";

const now = new Date("2026-09-07T18:00:00.000Z");
const context = { signal: new AbortController().signal, now };
const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } });

describe("ECEPP Source adapter", () => {
  it("is registered for production scans", () => {
    expect(createRegisteredSourceAdapter("ecepp", {}, {} as SourceConfigurations).definition.id)
      .toBe("ecepp");
  });

  it("enriches only consultancy/advisory notices with a future closing date", async () => {
    const requested: string[] = [];
    const adapter = createEceppAdapter({ fetch: (async (input: RequestInfo | URL) => {
      const url = input.toString();
      requested.push(url);
      if (url.endsWith("noticeSearchResults.html")) return html(searchHtml);
      if (url.includes("44318531")) return html(detailHtml);
      return html(detailHtml
        .replaceAll("44318332", "50000001")
        .replace("Works Supervision", "Digital advisory services")
        .replace("Consultancy services for supervision of the Podgorica Bypass works.", "Advisory support for a digital programme.")
        .replace("Consultancy</td>", "Services</td>")
        .replace("Invitation For Prequalification", "Ebrd Contract Notice Addendum"));
    }) as typeof fetch });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(context);
    expect(requested).toHaveLength(2);
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceId: "ecepp", sourceEventId: "44318531", sourceOpportunityId: "44318332",
      eventType: "tender", publishedAt: "2026-09-02T05:47:00.000Z",
      opportunityName: "Works Supervision", clientName: "EBRD",
      procuringEntityName: "Monteput doo", dueDate: "2026-10-18T09:00:00.000Z",
      placeOfPerformance: { description: "Montenegro" },
      sourceData: {
        procurementType: "Consultancy",
        businessSector: "Infra Europe",
        projectValue: { amount: 200_000, currency: "EUR" },
      },
    });
    expect(result.candidates[0].value).toBeUndefined();
    expect(requested.some((url) => url.includes("50000002"))).toBe(false);
  });

  it("does not enrich an otherwise open notice after its closing date", async () => {
    const requested: string[] = [];
    const adapter = createEceppAdapter({ fetch: (async (input: RequestInfo | URL) => {
      const url = input.toString();
      requested.push(url);
      return html(searchHtml.replace("18/10/2026 10:00 UK Time", "01/09/2026 10:00 UK Time"));
    }) as typeof fetch });

    const result = await adapter.scan(context);
    expect(result.candidates).toEqual([]);
    expect(requested).toHaveLength(1);
  });

  it("fails safely on access denial and structural drift", async () => {
    const denied = createEceppAdapter({ fetch: (async () => new Response("secret", { status: 403 })) as typeof fetch });
    const error = await denied.scan(context).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "access_denied", retryable: false });
    expect(String(error)).not.toContain("secret");

    const drifted = createEceppAdapter({ fetch: (async () => html("<h2>Notices</h2>")) as typeof fetch });
    await expect(drifted.scan(context)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
