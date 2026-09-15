import { describe, expect, it, vi } from "vitest";
import configRaw from "../config/mcc-dg-market.yaml?raw";
import detail200 from "./fixtures/mcc-dg-market-detail-200.html?raw";
import detail202 from "./fixtures/mcc-dg-market-detail-202.html?raw";
import list1 from "./fixtures/mcc-dg-market-list-1.html?raw";
import list2 from "./fixtures/mcc-dg-market-list-2.html?raw";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import type { BrowserPageSession } from "../src/sources/browser-page";
import {
  createMccDgMarketAdapter,
  parseMccDgMarketConfig,
} from "../src/sources/mcc-dg-market";

const config = parseMccDgMarketConfig(configRaw);
const html = (body: string) => new Response(body, {
  headers: { "content-type": "text/html;charset=UTF-8" },
});

describe("MCCDGMarket Source adapter", () => {
  it("uses one browser session for pagination and detail enrichment", async () => {
    const loaded: string[] = [];
    const close = vi.fn(async () => undefined);
    const session: BrowserPageSession = {
      async load(url) {
        loaded.push(url.toString());
        if (url.pathname === "/") return html(list1);
        if (url.searchParams.get("selPageNumber") === "2") return html(list2);
        if (url.pathname === "/tender/200") return html(detail200);
        if (url.pathname === "/tender/202") return html(detail202);
        throw new Error(`Unexpected fixture URL ${url}`);
      },
      close,
    };
    const adapter = createMccDgMarketAdapter({
      config,
      requestDelayMs: 0,
      browserSessionFactory: async () => session,
    });
    assertValidSourceAdapter(adapter);

    const now = new Date("2026-09-15T12:00:00.000Z");
    const result = await adapter.scan({ signal: new AbortController().signal, now });

    expect(loaded).toHaveLength(4);
    expect(loaded.some((url) => url.includes("/tender/201"))).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      sourceId: "mcc-dg-market",
      sourceEventId: "200",
      canonicalUrl: "https://mcc.dgmarket.com/tender/200",
      eventType: "tender",
      opportunityName: "Climate advisory services",
      description: "Technical assistance for climate policy and institutional strengthening.",
      clientName: "Millennium Challenge Account Kenya",
      funderNames: ["Millennium Challenge Corporation (MCC)"],
      publishedAt: "2026-09-10T00:00:00.000Z",
      dueDate: "2026-10-10T00:00:00.000Z",
      value: { amount: 499_999, currency: "USD" },
      placeOfPerformance: { description: "Kenya" },
      sourceData: { clientCohort: "mca", valueBasis: "estimated-value" },
    });
    expect(result.candidates[1]).toMatchObject({
      sourceEventId: "202",
      eventType: "cancellation",
      clientName: "Millennium Challenge Corporation (MCC)",
      value: { amount: 600_000, currency: "USD" },
      sourceData: { clientCohort: "mcc" },
    });
  });

  it("closes its browser session after malformed pagination", async () => {
    const close = vi.fn(async () => undefined);
    const adapter = createMccDgMarketAdapter({
      config,
      requestDelayMs: 0,
      browserSessionFactory: async () => ({
        load: async () => html(list1.replace("selPageNumber=2", "selPageNumber=3")),
        close,
      }),
    });

    await expect(adapter.scan({
      signal: new AbortController().signal,
      now: new Date("2026-09-15T12:00:00.000Z"),
    })).rejects.toMatchObject({ code: "invalid_pagination" });
    expect(close).toHaveBeenCalledOnce();
  });
});
