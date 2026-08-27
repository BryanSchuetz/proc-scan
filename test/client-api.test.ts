import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventsResponse } from "../src/api/types";
import { fetchBiddingEvents } from "../src/client/api";

const response: EventsResponse = {
  items: [],
  pagination: { page: 1, pageSize: 25, total: 128, pageCount: 6 },
  facets: {
    clients: ["U.S. Mission to Albania"],
    sources: [{ id: "grants-gov", name: "Grants.gov" }],
    technicalAreas: [{ id: "unclassified", name: "Unclassified" }],
    fixtureData: false,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("registry client API", () => {
  it("loads Uncertain opportunities from the privacy-filter-safe endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetcher);

    await expect(fetchBiddingEvents({
      page: 1,
      pageSize: 25,
      sort: "discoveredAt",
      direction: "desc",
      search: "",
      status: "uncertain",
      eventType: "",
      client: "",
      source: "",
      technicalArea: "",
    })).resolves.toEqual(response);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/opportunities?page=1&pageSize=25&sort=discoveredAt&direction=desc&status=uncertain",
    );
  });
});
