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

export interface ApiScanSummary {
  completedAt: string;
  successfulSources: Array<{ id: string; name: string }>;
  sourceCount: number;
}

export interface EventsResponse {
  items: ApiBiddingEvent[];
  latestScan?: ApiScanSummary;
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

export interface UploadSummary {
  id: string;
  filename: string;
  sourceId: string;
  sourceName: string;
  createdAt: string;
  rowCount: number;
  status: "queued" | "processing" | "processed";
  retainedCount: number;
  excludedCount: number;
  duplicateCount: number;
}

export interface UploadsResponse {
  sources: Array<{ id: string; name: string; enabled: number }>;
  uploads: UploadSummary[];
}
