import { describe, expect, it } from "vitest";
import listFixture from "./fixtures/fcdo-jaggaer-public-list.html?raw";
import detailFixture from "./fixtures/fcdo-jaggaer-public-detail.html?raw";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createFcdoJaggaerPublicAdapter } from "../src/sources/fcdo-jaggaer-public";
import { createRegisteredSourceAdapter } from "../src/sources";
import type { SourceConfigurations } from "../src/sources";

const baseUrl = "https://fcdo.bravosolution.co.uk";
const entryUrl = `${baseUrl}/esop/guest/go/public/opportunity/current`;
const listUrl = `${baseUrl}/esop/toolkit/opportunity/current/list.si?reset=true&_ncp=fixture`;
const now = new Date("2026-09-07T18:00:00.000Z");
const context = { signal: new AbortController().signal, now };
const html = (body: string, headers?: HeadersInit) => new Response(body, { headers: { "Content-Type": "text/html", ...headers } });

function detail(id: string): string {
  if (id === "57001") return detailFixture;
  if (id === "57002") return detailFixture
    .replaceAll("project_10001", "project_10002")
    .replaceAll("Climate advisory programme", "Global Development Delivery Framework call-down")
    .replace("31/10/2026", "30/11/2026");
  return detailFixture
    .replaceAll("project_10001", "project_9962")
    .replaceAll("Climate advisory programme", "HEROS market engagement")
    .replace("Technical assistance and capacity building for climate-resilient development.", "The FCDO will host an Early Market Engagement event.")
    .replace("Procurement Act – Open", "Other")
    .replace("31/10/2026", "31/12/2026")
    .replace("</ul>", "<li class='FormField'><div class='form_question_label'>Notes</div><div class='form_answer'>This is not a call to competition.</div></li></ul>");
}

describe("FCDO Jaggaer public Source adapter", () => {
  it("is registered for production scans", () => {
    expect(createRegisteredSourceAdapter("fcdo-jaggaer-public", {}, {} as SourceConfigurations).definition.id)
      .toBe("fcdo-jaggaer-public");
  });

  it("uses an ephemeral visitor session and retains only non-framework FCDO services", async () => {
    const requests: Array<{ url: string; cookie: string | null }> = [];
    const adapter = createFcdoJaggaerPublicAdapter({
      requestDelayMs: 0,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        requests.push({ url, cookie: new Headers(init?.headers).get("Cookie") });
        if (url === entryUrl) {
          const headers = new Headers({ Location: listUrl });
          headers.append("Set-Cookie", "VISITORID=fixture-visitor; Path=/; Secure");
          headers.append("Set-Cookie", "CLUSTER-NODE=fixture-node; Path=/; Secure");
          return new Response(null, { status: 302, headers });
        }
        if (url === listUrl) return html(listFixture, { "Set-Cookie": "JSESSIONID=fixture-session; Path=/esop/toolkit; Secure" });
        const id = /\/current\/(\d+)\/detail/.exec(url)?.[1];
        if (!id) throw new Error(`Unexpected URL: ${url}`);
        return html(detail(id));
      }) as typeof fetch,
    });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(context);
    expect(requests.map(({ url }) => url)).toEqual([
      entryUrl, listUrl,
      `${baseUrl}/esop/toolkit/opportunity/current/57001/detail.si`,
      `${baseUrl}/esop/toolkit/opportunity/current/57002/detail.si`,
      `${baseUrl}/esop/toolkit/opportunity/current/56912/detail.si`,
    ]);
    expect(requests[1].cookie).toContain("VISITORID=fixture-visitor");
    expect(requests[2].cookie).toContain("JSESSIONID=fixture-session");
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      sourceId: "fcdo-jaggaer-public",
      sourceEventId: "57001",
      sourceOpportunityId: "project_10001",
      opportunityName: "Climate advisory programme",
      description: "Technical assistance and capacity building for climate-resilient development.",
      clientName: "FCDO",
      procuringEntityName: "Foreign Commonwealth and Development Office",
      value: { amount: 300_000, currency: "GBP" },
      dueDate: "2026-10-31T12:00:00.000Z",
      sourceData: { coverage: "public-non-framework", valueBasis: "estimated-value-of-contract" },
    });
    expect(result.candidates[1]).toMatchObject({
      sourceEventId: "56912",
      sourceOpportunityId: "project_9962",
      opportunityName: "HEROS market engagement",
      sourceStatus: "early-market-engagement",
      dueDate: "2026-12-31T12:00:00.000Z",
      sourceData: {
        activityType: "early-market-engagement",
        notes: "This is not a call to competition.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-visitor");
    expect(JSON.stringify(result)).not.toContain("Framework");
  });

  it("fails closed when the visitor session or complete count is missing", async () => {
    const missingCookie = createFcdoJaggaerPublicAdapter({ requestDelayMs: 0, fetch: (async () =>
      new Response(null, { status: 302, headers: { Location: listUrl } })) as typeof fetch });
    await expect(missingCookie.scan(context)).rejects.toMatchObject({ code: "invalid_session" });

    const incomplete = createFcdoJaggaerPublicAdapter({ requestDelayMs: 0, fetch: (async (input: RequestInfo | URL) => {
      if (input.toString() === entryUrl) return new Response(null, {
        status: 302,
        headers: { Location: listUrl, "Set-Cookie": "VISITORID=fixture; Path=/" },
      });
      return html(listFixture.replace("of <span class=\"js-fullsize-cnt\">4", "of <span class=\"js-fullsize-cnt\">5"));
    }) as typeof fetch });
    await expect(incomplete.scan(context)).rejects.toMatchObject({ code: "invalid_pagination" });
  });
});
