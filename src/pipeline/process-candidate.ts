import { assessAddressability } from "../classification/addressability";
import type { AddressabilityConfig } from "../classification/addressability";
import {
  classifyTechnicalAreas,
  keepMostSpecificTechnicalAreas,
} from "../classification/taxonomy";
import type { TaxonomyFile, TechnicalClassificationConfig } from "../classification/taxonomy";
import { buildBiddingEventId, buildEventIdentity, buildMaterialFingerprint } from "../domain/identity";
import { inheritMissingFields } from "../domain/inheritance";
import type { PriorBiddingEvent } from "../domain/inheritance";
import { buildOcdsRelease } from "../domain/ocds";
import type {
  AddressabilityAssessment,
  NormalizedBiddingEvent,
  RetainedBiddingEvent,
} from "../domain/types";

export interface CandidateProcessingContext {
  scanRunId: string;
  taxonomy: TaxonomyFile;
  technicalClassification: TechnicalClassificationConfig;
  addressability: AddressabilityConfig;
  priorEvent?: PriorBiddingEvent;
  ocidPrefix?: string;
}

export type CandidateProcessingResult =
  | {
      status: "excluded";
      eventIdentity: string;
      contentFingerprint: string;
      assessment: AddressabilityAssessment;
    }
  | {
      status: "retained";
      event: RetainedBiddingEvent;
    };

function technicalClassificationText(event: NormalizedBiddingEvent): string {
  return [
    event.opportunityName,
    event.description,
    event.eligibility,
    event.originalEventType,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
}

export async function processCandidate(
  candidate: NormalizedBiddingEvent,
  context: CandidateProcessingContext,
): Promise<CandidateProcessingResult> {
  const inherited = context.priorEvent
    ? inheritMissingFields(candidate, context.priorEvent)
    : { event: candidate, inheritedFields: [] };
  const event = inherited.event;
  const classifiedTechnicalAreas = classifyTechnicalAreas(
    technicalClassificationText(event),
    context.taxonomy,
    context.technicalClassification,
  );
  const canInheritDerivedValues = Boolean(
    context.priorEvent?.sourceOpportunityId &&
    candidate.sourceId === context.priorEvent.sourceId &&
    candidate.sourceOpportunityId === context.priorEvent.sourceOpportunityId &&
    context.priorEvent.technicalClassificationVersion ===
      context.technicalClassification.schema_version,
  );
  const technicalAreas = keepMostSpecificTechnicalAreas(
    [
      ...classifiedTechnicalAreas,
      ...(canInheritDerivedValues ? context.priorEvent?.technicalAreas ?? [] : []),
    ],
    context.taxonomy,
  );
  const assessment = assessAddressability(event, context.addressability);
  const eventIdentity = await buildEventIdentity(event);
  const contentFingerprint = await buildMaterialFingerprint(event);

  if (assessment.status === "excluded") {
    return { status: "excluded", eventIdentity, contentFingerprint, assessment };
  }

  const id = await buildBiddingEventId(event.sourceId, eventIdentity, contentFingerprint);
  const ocdsRelease = await buildOcdsRelease(
    event,
    eventIdentity,
    contentFingerprint,
    context.ocidPrefix,
  );

  return {
    status: "retained",
    event: {
      ...event,
      id,
      eventIdentity,
      contentFingerprint,
      ocdsRelease,
      technicalAreas,
      technicalClassificationVersion: context.technicalClassification.schema_version,
      addressability: {
        ...assessment,
        status: assessment.status,
      },
      inheritedFields: inherited.inheritedFields,
      scanRunId: context.scanRunId,
    },
  };
}
