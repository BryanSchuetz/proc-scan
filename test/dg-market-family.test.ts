import { describe, expect, it, vi } from "vitest";
import type { SourceAdapter, SourceCandidate } from "../src/sources/adapter";
import { SourceScanError } from "../src/sources/adapter";
import { dgMarketSourceDefinition } from "../src/sources/dg-market";
import { createDgMarketFamilyAdapter } from "../src/sources/dg-market-family";
import { mccDgMarketSourceDefinition } from "../src/sources/mcc-dg-market";

const context = {
  signal: new AbortController().signal,
  now: new Date("2026-09-15T12:00:00.000Z"),
};

function candidate(overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    sourceId: "dg-market",
    sourceEventId: "200",
    sourceOpportunityId: "200",
    canonicalUrl: "https://www2.dgmarket.com/Notice/200",
    eventType: "tender",
    opportunityName: "Climate advisory services",
    clientName: "MCA Kenya",
    sourceData: { clientCohort: "mca" },
    ...overrides,
  };
}

function adapter(
  definition: SourceAdapter["definition"],
  scan: SourceAdapter["scan"],
): SourceAdapter {
  return { definition, scan };
}

describe("dgMarket family adapter", () => {
  it("deduplicates exact notice IDs and retains complementary channel data", async () => {
    const generic = candidate({
      publishedAt: "2026-09-11T10:30:00.000Z",
      dueDate: "2026-10-09T12:00:00.000Z",
      value: { amount: 499_999, currency: "USD" },
      documents: [{ id: "generic-200", url: "https://www2.dgmarket.com/Notice/200" }],
      sourceData: { clientCohort: "mca", rawEstimatedValue: "499,999 USD" },
    });
    const branded = candidate({
      sourceId: "mcc-dg-market",
      canonicalUrl: "https://mcc.dgmarket.com/tender/200",
      publishedAt: "2026-09-11T00:00:00.000Z",
      dueDate: "2026-10-09T00:00:00.000Z",
      description: "Full public notice description.",
      clientName: "Millennium Challenge Account Kenya",
      value: { amount: 700_000, currency: "USD" },
      documents: [{ id: "branded-200", url: "https://mcc.dgmarket.com/tender/200" }],
      sourceData: { clientCohort: "mca", publicationDateBasis: "publication-date" },
    });
    const family = createDgMarketFamilyAdapter({
      dgMarket: adapter(dgMarketSourceDefinition, async () => ({
        candidates: [generic],
        nextCursor: { value: context.now.toISOString() },
      })),
      mccDgMarket: adapter(mccDgMarketSourceDefinition, async () => ({
        candidates: [branded, candidate({
          sourceId: "mcc-dg-market",
          sourceEventId: "201",
          sourceOpportunityId: "201",
          canonicalUrl: "https://mcc.dgmarket.com/tender/201",
          opportunityName: "MCC-only notice",
        })],
      })),
    });

    const result = await family.scan(context);

    expect(result.candidates).toHaveLength(2);
    expect(result.nextCursor).toEqual({ value: context.now.toISOString() });
    expect(result.candidates.find(({ sourceEventId }) => sourceEventId === "200")).toMatchObject({
      sourceId: "dg-market",
      canonicalUrl: "https://mcc.dgmarket.com/tender/200",
      publishedAt: "2026-09-11T10:30:00.000Z",
      dueDate: "2026-10-09T12:00:00.000Z",
      description: "Full public notice description.",
      clientName: "MCA Kenya",
      value: { amount: 499_999, currency: "USD" },
      sourceData: {
        clientCohort: "mca",
        channels: ["www2.dgmarket.com", "mcc.dgmarket.com"],
        portalUrls: {
          dgMarket: "https://www2.dgmarket.com/Notice/200",
          mccDgMarket: "https://mcc.dgmarket.com/tender/200",
        },
      },
    });
    expect(result.candidates.find(({ sourceEventId }) => sourceEventId === "200")?.documents)
      .toHaveLength(2);
    expect(result.candidates.find(({ sourceEventId }) => sourceEventId === "201")).toMatchObject({
      sourceId: "dg-market",
      sourceData: { clientCohort: "mca", channels: ["mcc.dgmarket.com"] },
    });
  });

  it("retries one MCC browser failure with a fresh child scan", async () => {
    const mccScan = vi.fn()
      .mockRejectedValueOnce(new SourceScanError("browser_navigation_failed", "failed", true))
      .mockResolvedValueOnce({ candidates: [] });
    const family = createDgMarketFamilyAdapter({
      dgMarket: adapter(dgMarketSourceDefinition, async () => ({ candidates: [] })),
      mccDgMarket: adapter(mccDgMarketSourceDefinition, mccScan),
    });

    await expect(family.scan(context)).resolves.toMatchObject({ candidates: [] });
    expect(mccScan).toHaveBeenCalledTimes(2);
  });

  it("does not retry malformed MCC data", async () => {
    const mccScan = vi.fn()
      .mockRejectedValue(new SourceScanError("invalid_record", "failed", true));
    const family = createDgMarketFamilyAdapter({
      dgMarket: adapter(dgMarketSourceDefinition, async () => ({ candidates: [] })),
      mccDgMarket: adapter(mccDgMarketSourceDefinition, mccScan),
    });

    await expect(family.scan(context)).rejects.toMatchObject({ code: "invalid_record" });
    expect(mccScan).toHaveBeenCalledOnce();
  });
});
