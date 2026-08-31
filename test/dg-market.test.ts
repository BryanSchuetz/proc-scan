import { describe, expect, it } from "vitest";
import configRaw from "../config/dg-market.yaml?raw";
import euGovernmentPage from "./fixtures/dg-market-eu-government-page.html?raw";
import mcaPage1 from "./fixtures/dg-market-mca-page-1.html?raw";
import mcaPage2 from "./fixtures/dg-market-mca-page-2.html?raw";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import {
  createDgMarketAdapter,
  parseDgMarketConfig,
} from "../src/sources/dg-market";

const now = new Date("2026-08-30T10:00:00.000Z");
const productionConfig = parseDgMarketConfig(configRaw);
const config = {
  ...productionConfig,
  eu_member_states: {
    ...productionConfig.eu_member_states,
    countries: [{ code: "de", name: "Germany" }],
  },
};

function htmlResponse(body: string, session?: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html;charset=UTF-8",
      ...(session ? { "set-cookie": `JSESSIONID=${session}; Path=/; HttpOnly` } : {}),
    },
  });
}

describe("dgMarket Source adapter", () => {
  it("uses session pagination and maps MCA and EU government-buyer notices", async () => {
    const requests: Array<{ url: URL; headers: Headers }> = [];
    const adapter = createDgMarketAdapter({
      config,
      pageSize: 2,
      requestDelayMs: 0,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const headers = new Headers(init?.headers);
        requests.push({ url, headers });
        if (url.pathname.endsWith("/gotoPage/2")) return htmlResponse(mcaPage2);
        if (url.searchParams.has("fundingAgency")) return htmlResponse(mcaPage1, "mca-session");
        return htmlResponse(euGovernmentPage, "eu-session");
      }) as typeof fetch,
    });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan({ signal: new AbortController().signal, now });

    expect(requests).toHaveLength(3);
    const mcaRequest = requests[0];
    expect(mcaRequest.url.searchParams.get("fundingAgency")).toBe("1385098");
    expect(mcaRequest.url.searchParams.get("noticeCategory")).toBe("2");
    expect(mcaRequest.url.searchParams.get("startDate")).toBe("2026-06-01");
    expect(mcaRequest.url.searchParams.get("endDate")).toBe("2026-08-31");
    expect(requests[1].url.pathname).toBe("/NoticeList/gotoPage/2");
    expect(requests[1].headers.get("cookie")).toBe("JSESSIONID=mca-session");
    const euRequest = requests[2].url;
    expect(euRequest.searchParams.get("noticeContactCountry")).toBe("de");
    expect(euRequest.searchParams.get("buyerTypes")).toBe("GOVERNMENT");
    expect(euRequest.searchParams.has("country")).toBe(false);

    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId).sort()).toEqual([
      "100", "101", "102", "200", "201",
    ]);
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId)).not.toContain("103");

    expect(result.candidates.find(({ sourceEventId }) => sourceEventId === "100")).toMatchObject({
      sourceId: "dg-market",
      sourceOpportunityId: "100",
      canonicalUrl: "https://www2.dgmarket.com/Notice/100",
      opportunityName: "Technical assistance for power-sector reform",
      clientName: "MCA-Sierra Leone",
      funderNames: ["Millennium Challenge Corporation (MCC)"],
      publishedAt: "2026-08-28T10:30:00.000Z",
      dueDate: "2026-09-30T12:00:00.000Z",
      value: { amount: 499_999, currency: "USD" },
      placeOfPerformance: { description: "Sierra Leone" },
      sourceData: {
        clientCohort: "mca",
        rawEstimatedValue: "499,999 USD",
        descriptionAvailability: "subscription-required",
      },
    });
    expect(result.candidates.find(({ sourceEventId }) => sourceEventId === "102")).toMatchObject({
      value: undefined,
      sourceData: { rawEstimatedValue: "0 USD" },
    });
    expect(result.candidates.find(({ sourceEventId }) => sourceEventId === "200")).toMatchObject({
      clientName: "Federal Ministry for Economic Cooperation and Development",
      value: { amount: 999_999, currency: "EUR" },
      placeOfPerformance: { description: "Kenya" },
      sourceData: {
        clientCohort: "eu-member-state-government",
        buyerContactCountryCode: "de",
        buyerContactCountryName: "Germany",
        buyerType: "GOVERNMENT",
      },
    });
  });

  it("rejects a paginated search without a dgMarket session cookie", async () => {
    const adapter = createDgMarketAdapter({
      config: { ...config, eu_member_states: { ...config.eu_member_states, countries: [] } },
      pageSize: 2,
      requestDelayMs: 0,
      fetch: (async () => htmlResponse(mcaPage1)) as typeof fetch,
    });

    await expect(adapter.scan({ signal: new AbortController().signal, now })).rejects.toMatchObject({
      code: "invalid_session",
    });
  });

  it("classifies HTML access failures without reflecting response content", async () => {
    const adapter = createDgMarketAdapter({
      config,
      pageSize: 2,
      requestDelayMs: 0,
      fetch: (async () => new Response("private detail", {
        status: 503,
        headers: { "content-type": "text/html" },
      })) as typeof fetch,
    });

    const error = await adapter.scan({ signal: new AbortController().signal, now }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "source_unavailable", retryable: true });
    expect(String(error)).not.toContain("private detail");
  });
});
