import { describe, expect, it } from "vitest";
import simapRaw from "../config/simap.yaml?raw";
import fixture from "./fixtures/simap.json";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createSimapAdapter, parseSimapConfig } from "../src/sources/simap";

const config = parseSimapConfig(simapRaw);
const now = new Date("2026-09-14T12:00:00.000Z");

function scanContext(cursor?: { value?: string }) {
  return { cursor, signal: new AbortController().signal, now };
}

function fixtureFetcher(requests: URL[] = []) {
  const pageIndexes = { sdc: 0, seco: 0 };
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString());
    requests.push(url);
    if (url.pathname.endsWith("/project-search")) {
      const organization = url.searchParams.get("search")?.toLowerCase() as "sdc" | "seco";
      const page = pageIndexes[organization]++;
      return Response.json(fixture.search[organization][page]);
    }
    const publicationId = url.pathname.split("/").at(-1) as keyof typeof fixture.details;
    return Response.json(fixture.details[publicationId]);
  }) as typeof fetch;
}

describe("SIMAP Source adapter", () => {
  it("paginates public SDC/SECO service tenders and normalizes multilingual details", async () => {
    const requests: URL[] = [];
    const adapter = createSimapAdapter({ config, fetch: fixtureFetcher(requests) });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(scanContext({ value: "2026-09-14T06:00:00.000Z" }));

    const searches = requests.filter((url) => url.pathname.endsWith("/project-search"));
    expect(searches).toHaveLength(3);
    expect(searches[0].searchParams.get("newestPublicationFrom")).toBe("2026-09-12");
    expect(searches[0].searchParams.get("projectSubTypes")).toBe("service");
    expect(searches[0].searchParams.get("newestPubTypes")).toBe("tender");
    expect(searches[2].searchParams.get("lastItem")).toBe("20260703|39933");
    expect(requests.some((url) => url.pathname.includes("0a3d8810"))).toBe(false);
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      sourceId: "simap",
      sourceEventId: "e747ebb9-729c-4899-8a96-cc051c507ceb",
      sourceOpportunityId: "b920f3fc-4621-4cb8-9ef8-facf82419c32",
      canonicalUrl: "https://www.simap.ch/en/project-detail/b920f3fc-4621-4cb8-9ef8-facf82419c32",
      originalEventType: "tender",
      eventType: "tender",
      publishedAt: "2026-07-03T00:00:00.000Z",
      opportunityName: "Inclusive economic development programme",
      description: "Technical assistance for inclusive markets & private-sector development.",
      clientName: "Swiss-SDC/SECO",
      procuringEntityName: "Swiss Agency for Development and Cooperation SDC",
      dueDate: "2026-10-24T21:30:00.000Z",
      placeOfPerformance: { description: "Global" },
      sourceStatus: "open",
      sourceData: {
        projectNumber: "39933",
        publicationNumber: "39933-01",
        procurementOfficeId: "4c12deb8-9db7-45e5-8fb0-0974a800c0a6",
        projectSubType: "service",
        cpvCode: "75211200",
        corrected: false
      },
    });
    expect(result.candidates[1]).toMatchObject({
      eventType: "modification",
      isFormalAmendment: true,
      opportunityName: "Beratung für nachhaltigen Handel",
      placeOfPerformance: { description: "Belgrade", countryCode: "RS" },
      sourceData: { corrected: true },
    });
  });

  it("uses a one-year initial window and rejects malformed cursors", async () => {
    const requests: URL[] = [];
    await createSimapAdapter({ config, fetch: fixtureFetcher(requests) }).scan(scanContext());
    expect(requests[0].searchParams.get("newestPublicationFrom")).toBe("2025-09-14");

    await expect(
      createSimapAdapter({ config, fetch: fixtureFetcher() }).scan(scanContext({ value: "not-a-date" })),
    ).rejects.toMatchObject({ code: "invalid_cursor", retryable: false });
  });

  it("classifies public API failures without reflecting response content", async () => {
    const adapter = createSimapAdapter({
      config,
      fetch: (async () => Response.json({ internal: "do-not-reflect" }, { status: 503 })) as typeof fetch,
    });
    const error = await adapter.scan(scanContext()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source_unavailable", retryable: true });
    expect(String(error)).not.toContain("do-not-reflect");
  });
});
