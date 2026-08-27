import type { NormalizedBiddingEvent } from "../src/domain/types";

export function biddingEvent(
  overrides: Partial<NormalizedBiddingEvent> = {},
): NormalizedBiddingEvent {
  return {
    sourceId: "example-source",
    sourceEventId: "event-1",
    sourceOpportunityId: "opportunity-1",
    canonicalUrl: "https://example.test/opportunities/1",
    eventType: "tender",
    publishedAt: "2026-08-25T12:00:00.000Z",
    discoveredAt: "2026-08-26T10:00:00.000Z",
    opportunityName: "Digital government advisory services",
    description: "A digital ecosystem assessment and government service design activity.",
    clientName: "Development Agency",
    value: { amount: 5_000_000, currency: "USD" },
    dueDate: "2026-10-01T17:00:00.000Z",
    placeOfPerformance: { description: "Kenya", countryCode: "KE" },
    sourceData: { fixture: true },
    ...overrides,
  };
}
