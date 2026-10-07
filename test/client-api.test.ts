import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventsResponse } from "../src/api/types";
import { fetchBiddingEvents, setMarkingStatus } from "../src/client/api";

const response: EventsResponse = {
  items: [],
  latestScan: {
    completedAt: "2026-09-09T10:02:00.000Z",
    successfulSources: [{ id: "grants-gov", name: "Grants.gov" }],
    sourceCount: 1,
  },
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
  it("saves the requested marking status to the admin endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "uncertain" }));
    vi.stubGlobal("fetch", fetcher);
    await setMarkingStatus("event/with spaces", "uncertain");
    expect(fetcher).toHaveBeenCalledWith("/api/admin/opportunities/event%2Fwith%20spaces/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ status: "uncertain" }),
    });
  });

  it("surfaces a failed save instead of reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "Administrator access is required." } }, { status: 403 })));
    await expect(setMarkingStatus("event-1", "addressable")).rejects.toThrow("Administrator access is required.");
  });

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
