import type { BiddingEventType, RetainedAddressabilityStatus } from "../domain/types";

export interface ApiTechnicalArea {
  id: string;
  name: string;
  parentId?: string;
}

export interface ApiBiddingEvent {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceOpportunityId?: string;
  sourceUrl: string;
  sourceEventType?: string;
  eventType: BiddingEventType;
  opportunityName: string;
  clientName?: string;
  placeOfPerformance?: string;
  countryCode?: string;
  valueAmount?: number;
  valueCurrency?: string;
  dueDate?: string;
  publishedAt?: string;
  discoveredAt: string;
  addressabilityStatus: RetainedAddressabilityStatus;
  technicalAreas: ApiTechnicalArea[];
}

export interface EventsFacets {
  clients: string[];
  sources: Array<{ id: string; name: string }>;
  technicalAreas: ApiTechnicalArea[];
  fixtureData: boolean;
}

export interface EventsResponse {
  items: ApiBiddingEvent[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
  };
  facets: EventsFacets;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
