import { describe, expect, it, vi } from "vitest";
import configRaw from "../config/dg-market.yaml?raw";
import mcaPage1 from "./fixtures/dg-market-mca-page-1.html?raw";
import mcaPage2 from "./fixtures/dg-market-mca-page-2.html?raw";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import {
  createDgMarketAdapter,
  parseDgMarketConfig,
} from "../src/sources/dg-market";

const now = new Date("2026-08-30T10:00:00.000Z");
const config = parseDgMarketConfig(configRaw);

function htmlResponse(body: string, session?: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html;charset=UTF-8",
      ...(session ? { "set-cookie": `JSESSIONID=${session}; Path=/; HttpOnly` } : {}),
    },
  });
}

describe("dgMarket Source adapter", () => {
  it("uses and closes one browser session without requiring a response cookie", async () => {
    const loaded: string[] = [];
    const close = vi.fn(async () => undefined);
    const adapter = createDgMarketAdapter({
      config,
      pageSize: 2,
      requestDelayMs: 0,
      browserSessionFactory: async () => ({
        async load(url) {
          loaded.push(url.toString());
          return htmlResponse(url.pathname.endsWith("/gotoPage/2") ? mcaPage2 : mcaPage1);
        },
        close,
      }),
    });

    const result = await adapter.scan({ signal: new AbortController().signal, now });

    expect(result.candidates).toHaveLength(3);
    expect(loaded).toHaveLength(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses session pagination and maps only MCC and MCA notices", async () => {
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
        return htmlResponse(mcaPage1, "mcc-session");
      }) as typeof fetch,
    });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan({ signal: new AbortController().signal, now });

    expect(requests).toHaveLength(2);
    const mcaRequest = requests[0];
    expect(mcaRequest.url.searchParams.get("fundingAgency")).toBe("1385098");
    expect(mcaRequest.url.searchParams.get("noticeCategory")).toBe("2");
    expect(mcaRequest.url.searchParams.get("startDate")).toBe("2026-06-01");
    expect(mcaRequest.url.searchParams.get("endDate")).toBe("2026-08-31");
    expect(requests[1].url.pathname).toBe("/NoticeList/gotoPage/2");
    expect(requests[1].headers.get("cookie")).toBe("JSESSIONID=mcc-session");
    expect(mcaRequest.url.searchParams.has("noticeContactCountry")).toBe(false);
    expect(mcaRequest.url.searchParams.has("buyerTypes")).toBe(false);

    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId).sort()).toEqual([
      "100", "101", "102",
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
      sourceData: {
        clientCohort: "mcc",
        rawEstimatedValue: "0 USD",
      },
    });
  });

  it("filters buyers outside the MCC and MCA client scope", async () => {
    const page = mcaPage1.replace("MCA-Sierra Leone", "Unrelated implementing agency");
    const adapter = createDgMarketAdapter({
      config,
      pageSize: 2,
      requestDelayMs: 0,
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        return url.pathname.endsWith("/gotoPage/2")
          ? htmlResponse(mcaPage2)
          : htmlResponse(page, "mcc-session");
      }) as typeof fetch,
    });

    const result = await adapter.scan({ signal: new AbortController().signal, now });
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId)).toEqual(["101", "102"]);
  });

  it("rejects a paginated search without a dgMarket session cookie", async () => {
    const adapter = createDgMarketAdapter({
      config,
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
