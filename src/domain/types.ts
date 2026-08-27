export const biddingEventTypes = ["tender", "modification", "cancellation"] as const;
export type BiddingEventType = (typeof biddingEventTypes)[number];

export const addressabilityStatuses = ["addressable", "uncertain", "excluded"] as const;
export type AddressabilityStatus = (typeof addressabilityStatuses)[number];
export type RetainedAddressabilityStatus = Exclude<AddressabilityStatus, "excluded">;

export interface Money {
  amount?: number;
  currency?: string;
}

export interface PlaceOfPerformance {
  description?: string;
  countryCode?: string;
}

export interface SourceDocument {
  id: string;
  title?: string;
  url: string;
  documentType?: string;
}

export interface NormalizedBiddingEvent {
  sourceId: string;
  sourceEventId?: string;
  sourceOpportunityId?: string;
  canonicalUrl: string;
  originalEventType?: string;
  eventType: BiddingEventType;
  isFormalAmendment?: boolean;
  publishedAt?: string;
  discoveredAt: string;
  opportunityName: string;
  description?: string;
  clientName?: string;
  funderNames?: string[];
  procuringEntityName?: string;
  implementingEntityNames?: string[];
  value?: Money;
  dueDate?: string;
  placeOfPerformance?: PlaceOfPerformance;
  eligibility?: string;
  sourceStatus?: string;
  documents?: SourceDocument[];
  sourceData: Record<string, unknown>;
}

export interface TechnicalAreaAssignment {
  id: string;
  name: string;
  parentId?: string;
  score: number;
  evidence: string[];
}

export interface AddressabilityRuleMatch {
  ruleId: string;
  points: number;
}

export interface AddressabilityAssessment {
  status: AddressabilityStatus;
  score: number;
  matchedRules: AddressabilityRuleMatch[];
  exclusionRuleId?: string;
  configVersion: number;
}

export interface InheritedField {
  field: InheritableField;
  fromEventId: string;
}

export type InheritableField =
  | "opportunityName"
  | "description"
  | "clientName"
  | "funderNames"
  | "procuringEntityName"
  | "implementingEntityNames"
  | "value"
  | "dueDate"
  | "placeOfPerformance"
  | "eligibility"
  | "documents";

export interface RetainedBiddingEvent extends NormalizedBiddingEvent {
  id: string;
  eventIdentity: string;
  contentFingerprint: string;
  ocdsRelease: OcdsRelease;
  technicalAreas: TechnicalAreaAssignment[];
  technicalClassificationVersion: number;
  addressability: AddressabilityAssessment & {
    status: RetainedAddressabilityStatus;
  };
  inheritedFields: InheritedField[];
  scanRunId: string;
}

export interface OcdsOrganizationReference {
  id: string;
  name: string;
}

export interface OcdsRelease {
  ocid: string;
  id: string;
  date: string;
  tag: Array<"tender" | "tenderAmendment" | "tenderUpdate" | "tenderCancellation">;
  initiationType: "tender";
  buyer?: OcdsOrganizationReference;
  parties?: Array<OcdsOrganizationReference & { roles: string[] }>;
  tender: {
    id?: string;
    title: string;
    description?: string;
    status?: string;
    value?: { amount: number; currency: string };
    tenderPeriod?: { endDate: string };
    documents?: SourceDocument[];
    items?: Array<{
      id: string;
      deliveryLocation: PlaceOfPerformance;
    }>;
  };
}
