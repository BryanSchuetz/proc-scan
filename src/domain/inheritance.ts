import type {
  InheritableField,
  InheritedField,
  NormalizedBiddingEvent,
  TechnicalAreaAssignment,
} from "./types";

const inheritableFields: InheritableField[] = [
  "opportunityName",
  "description",
  "clientName",
  "funderNames",
  "procuringEntityName",
  "implementingEntityNames",
  "value",
  "dueDate",
  "placeOfPerformance",
  "eligibility",
  "documents",
];

function isMissing(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

export interface PriorBiddingEvent extends NormalizedBiddingEvent {
  id: string;
  technicalAreas?: TechnicalAreaAssignment[];
  technicalClassificationVersion?: number;
}

export function inheritMissingFields(
  current: NormalizedBiddingEvent,
  prior: PriorBiddingEvent,
): { event: NormalizedBiddingEvent; inheritedFields: InheritedField[] } {
  if (
    !current.sourceOpportunityId ||
    current.sourceId !== prior.sourceId ||
    current.sourceOpportunityId !== prior.sourceOpportunityId
  ) {
    return { event: current, inheritedFields: [] };
  }

  const event = { ...current };
  const inheritedFields: InheritedField[] = [];
  const mutable = event as unknown as Record<InheritableField, unknown>;
  const previous = prior as unknown as Record<InheritableField, unknown>;

  for (const field of inheritableFields) {
    if (isMissing(mutable[field]) && !isMissing(previous[field])) {
      mutable[field] = structuredClone(previous[field]);
      inheritedFields.push({ field, fromEventId: prior.id });
    }
  }

  return { event, inheritedFields };
}
