import { sha256Hex } from "./identity";
import type { NormalizedBiddingEvent, OcdsOrganizationReference, OcdsRelease } from "./types";

const PROVISIONAL_OCID_PREFIX = "ocds-000000";

function organizationId(role: string, name: string): string {
  return `${role}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

function organization(role: string, name: string): OcdsOrganizationReference {
  return { id: organizationId(role, name), name };
}

export function ocdsTagFor(event: Pick<NormalizedBiddingEvent, "eventType" | "isFormalAmendment">): OcdsRelease["tag"][number] {
  switch (event.eventType) {
    case "tender":
      return "tender";
    case "modification":
      return event.isFormalAmendment ? "tenderAmendment" : "tenderUpdate";
    case "cancellation":
      return "tenderCancellation";
  }
}

export async function buildOcdsRelease(
  event: NormalizedBiddingEvent,
  eventIdentity: string,
  contentFingerprint: string,
  ocidPrefix = PROVISIONAL_OCID_PREFIX,
): Promise<OcdsRelease> {
  const opportunityIdentity = event.sourceOpportunityId ?? eventIdentity;
  const ocidSuffix = (await sha256Hex(`${event.sourceId}\u0000${opportunityIdentity}`)).slice(0, 24);
  const buyer = event.clientName ? organization("buyer", event.clientName) : undefined;
  const parties: NonNullable<OcdsRelease["parties"]> = [];

  if (buyer) parties.push({ ...buyer, roles: ["buyer"] });
  for (const name of event.funderNames ?? []) {
    parties.push({ ...organization("funder", name), roles: ["funder"] });
  }
  if (event.procuringEntityName) {
    parties.push({ ...organization("procuring-entity", event.procuringEntityName), roles: ["procuringEntity"] });
  }
  for (const name of event.implementingEntityNames ?? []) {
    parties.push({ ...organization("implementer", name), roles: ["implementingEntity"] });
  }

  return {
    ocid: `${ocidPrefix}-${event.sourceId}-${ocidSuffix}`,
    id: `${event.sourceId}-${(await sha256Hex(`${eventIdentity}\u0000${contentFingerprint}`)).slice(0, 24)}`,
    date: event.publishedAt ?? event.discoveredAt,
    tag: [ocdsTagFor(event)],
    initiationType: "tender",
    buyer,
    parties: parties.length > 0 ? parties : undefined,
    tender: {
      id: event.sourceOpportunityId,
      title: event.opportunityName,
      description: event.description,
      status: event.eventType === "cancellation" ? "cancelled" : event.sourceStatus,
      value:
        event.value?.amount !== undefined && event.value.currency
          ? { amount: event.value.amount, currency: event.value.currency }
          : undefined,
      tenderPeriod: event.dueDate ? { endDate: event.dueDate } : undefined,
      documents: event.documents,
      items: event.placeOfPerformance
        ? [{ id: "1", deliveryLocation: event.placeOfPerformance }]
        : undefined,
    },
  };
}
