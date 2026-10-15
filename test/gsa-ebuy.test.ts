import { describe, expect, it } from "vitest";
import fixture from "./fixtures/gsa-ebuy.json";
import { createGsaEbuyAdapter } from "../src/sources/gsa-ebuy";

const token = `fixture.${btoa(JSON.stringify({ exp: 4102444800 }))}.signature`;
const context = { signal: new AbortController().signal, now: new Date("2026-10-15T17:00:00Z") };

function adapter(data = structuredClone(fixture), contractNumber = "GS-TEST") {
  return createGsaEbuyAdapter({
    session: async () => ({ token, contractNumber }),
    fetch: (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.includes("/activerfqs/")) return Response.json({
        ...data.snapshot, response: { [contractNumber]: data.snapshot.response["GS-TEST"] },
      });
      const id = path.split("/").at(-2)! as keyof typeof data.details;
      return Response.json(data.details[id]);
    }) as typeof fetch,
  });
}

describe("GSA eBuy", () => {
  it("enriches the full snapshot, keeps approved Clients, and preserves explicit amendments and RFIs", async () => {
    const result = await adapter().scan(context);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      sourceId: "gsa-ebuy", sourceOpportunityId: "RFQ1000001",
      sourceEventId: "RFQ1000001:amendment:3", eventType: "modification",
      isFormalAmendment: true, clientName: "MCC", dueDate: "2026-10-19T14:00:00.000Z",
      publishedAt: "2026-09-24T10:00:00.000Z",
      description: "Policy & governance advisory services. See attached scope; compact value $50 million is not this contract's estimate.",
    });
    expect(result.candidates[1]).toMatchObject({
      sourceEventId: "RFI1000002", eventType: "tender", originalEventType: "RFI", clientName: "DOS",
      sourceStatus: "Open — Request for Information",
      description: "Market research for technical assistance.",
    });
    for (const candidate of result.candidates) {
      expect(candidate.value).toBeUndefined();
      expect(candidate.canonicalUrl).toMatch(/^https:\/\/www.ebuy.gsa.gov\/ebuy\/seller\/prepare-quote\//);
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("must-not-persist");
    expect(serialized).not.toContain("fixture@mcc.gov");
    expect(await adapter().scan({ ...context, cursor: { value: "2026-10-15T16:00:00Z" } }))
      .toEqual(result);
  });

  it("transcribes confirmed framework contracts into titles and metadata without guessing from number prefixes", async () => {
    for (const [contractNumber, frameworkName] of [
      ["GS-00F-063DA", "GSA PSS MAS"],
      ["47QRCA25DU699", "GSA OASIS+"],
      ["GS-00F-999AA", undefined],
      ["47QRCA25DU700", undefined],
    ] as const) {
      const result = await adapter(undefined, contractNumber).scan(context);
      const candidate = result.candidates[0];
      expect(candidate.opportunityName).toBe(frameworkName
        ? `${frameworkName} — Social policy advisory services` : "Social policy advisory services");
      expect(candidate.sourceData.contractNumber).toBe(contractNumber);
      expect(candidate.sourceData.frameworkName).toBe(frameworkName);
      expect(candidate.sourceEventId).toBe("RFQ1000001:amendment:3");
      expect(new URL(candidate.canonicalUrl).searchParams.get("contractNumber")).toBe(contractNumber);
    }
  });

  it("uses exact official domains for generic agency 95, never domain suffix tricks or MCA", async () => {
    for (const [domain, client] of [["dfc.gov", "DFC"], ["ustda.gov", "USTDA"], ["mcc.gov.evil.test", undefined]] as const) {
      const data = structuredClone(fixture);
      data.snapshot.response["GS-TEST"][0].userEmail = `fixture@${domain}`;
      data.details.RFQ1000001.response.rfqProps.userEmail = `fixture@${domain}`;
      const result = await adapter(data).scan(context);
      expect(result.candidates.find((c) => c.sourceOpportunityId === "RFQ1000001")?.clientName).toBe(client);
    }
    const data = structuredClone(fixture);
    data.details.RFQ1000001.response.rfqProps.userBureau = "Millennium Challenge Account Nepal";
    expect((await adapter(data).scan(context)).candidates.map((c) => c.clientName)).toEqual(["DOS"]);
  });

  it("preserves explicit cancellations but does not infer them from a missing request", async () => {
    const data = structuredClone(fixture);
    data.snapshot.response["GS-TEST"][0].rfqCancelled = true;
    data.details.RFQ1000001.response.rfqInfo.rfqOpen = false;
    expect((await adapter(data).scan(context)).candidates[0]).toMatchObject({
      sourceEventId: "RFQ1000001:cancelled", eventType: "cancellation",
    });
    data.snapshot.response["GS-TEST"] = [];
    expect((await adapter(data).scan(context)).candidates).toEqual([]);
  });

  it("fails on malformed snapshots or mismatched detail IDs rather than reporting an empty scan", async () => {
    const data = structuredClone(fixture);
    data.details.RFQ1000001.response.rfqInfo.rfqId = "RFQ9999999";
    await expect(adapter(data).scan(context)).rejects.toMatchObject({ code: "invalid_record" });
    const missingContract = createGsaEbuyAdapter({
      session: async () => ({ token, contractNumber: "GS-TEST" }),
      fetch: (async () => Response.json({ header: { status: 0 }, response: {} })) as typeof fetch,
    });
    await expect(missingContract.scan(context)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("requires manual reauthentication for expiry, forbidden responses, redirects, or login HTML without leaking credentials", async () => {
    for (const response of [
      new Response(null, { status: 403 }),
      new Response(null, { status: 302, headers: { location: "https://mfalogin.fas.gsa.gov" } }),
      new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    ]) {
      const source = createGsaEbuyAdapter({
        session: async () => ({ token, contractNumber: "GS-TEST" }),
        fetch: (async () => response) as typeof fetch,
      });
      await expect(source.scan(context)).rejects.toMatchObject({ code: "reauthentication_required", retryable: false });
    }
    const source = createGsaEbuyAdapter({
      session: async () => ({ token: `x.${btoa('{"exp":1}')}.x`, contractNumber: "GS-TEST" }),
    });
    await expect(source.scan(context)).rejects.toMatchObject({ code: "reauthentication_required" });
  });
});
