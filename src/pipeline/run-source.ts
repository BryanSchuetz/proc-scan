import type { AddressabilityConfig } from "../classification/addressability";
import type { TaxonomyFile, TechnicalClassificationConfig } from "../classification/taxonomy";
import {
  findPriorBiddingEvent,
  persistRetainedBiddingEvent,
  updateRetainedBiddingEvent,
} from "../db/events";
import { completeSourceRun } from "../db/scan-runs";
import { buildEventIdentity } from "../domain/identity";
import type { NormalizedBiddingEvent } from "../domain/types";
import type { SourceAdapter, SourceCursor } from "../sources/adapter";
import { assertValidSourceAdapter, SourceScanError } from "../sources/adapter";
import { processCandidate } from "./process-candidate";

export interface SourceProcessingContext {
  db: D1Database;
  adapter: SourceAdapter;
  sourceRunId: string;
  scanRunId: string;
  cursor?: SourceCursor;
  signal: AbortSignal;
  now: Date;
  taxonomy: TaxonomyFile;
  technicalClassification: TechnicalClassificationConfig;
  addressability: AddressabilityConfig;
}

export interface SourceProcessingResult {
  discoveredCount: number;
  retainedCount: number;
  excludedCount: number;
  duplicateCount: number;
  nextCursor?: SourceCursor;
}

function changedBetweenKnownValues(previous: unknown, current: unknown): boolean {
  return previous !== undefined && previous !== null && current !== undefined && current !== null &&
    previous !== current;
}

function trackedOpportunityChange(
  previous: NormalizedBiddingEvent,
  current: NormalizedBiddingEvent,
): boolean {
  return changedBetweenKnownValues(previous.dueDate, current.dueDate) ||
    changedBetweenKnownValues(previous.value?.amount, current.value?.amount);
}

function isNewerSourceEvent(current: NormalizedBiddingEvent, previous: NormalizedBiddingEvent): boolean {
  if (!current.publishedAt) return false;
  if (!previous.publishedAt) return true;
  return current.publishedAt > previous.publishedAt;
}

export async function runSourceAdapter(
  context: SourceProcessingContext,
): Promise<SourceProcessingResult> {
  assertValidSourceAdapter(context.adapter);
  const scan = await context.adapter.scan({
    cursor: context.cursor,
    signal: context.signal,
    now: context.now,
  });
  let retainedCount = 0;
  let excludedCount = 0;
  let duplicateCount = 0;

  for (const candidate of scan.candidates) {
    if (candidate.sourceId !== context.adapter.definition.id) {
      throw new SourceScanError(
        "invalid_candidate",
        `Source ${context.adapter.definition.id} returned a candidate owned by ${candidate.sourceId}.`,
        false,
      );
    }

    let event: NormalizedBiddingEvent = {
      ...candidate,
      discoveredAt: candidate.discoveredAt ?? context.now.toISOString(),
    };
    const eventIdentity = await buildEventIdentity(event);
    const priorMatch = await findPriorBiddingEvent(
      context.db,
      event.sourceId,
      eventIdentity,
      event.sourceOpportunityId,
    );
    const prior = priorMatch.exactEvent ?? priorMatch.opportunityEvent;
    let eventToUpdate: typeof prior;

    if (prior) {
      if (event.eventType === "cancellation") {
        if (prior.eventType === "cancellation") eventToUpdate = prior;
      } else if (prior.eventType === "cancellation") {
        event = { ...event, eventType: "cancellation" };
        eventToUpdate = prior;
      } else if (trackedOpportunityChange(prior, event)) {
        event = { ...event, eventType: "modification" };
      } else {
        event = { ...event, eventType: prior.eventType };
        if (priorMatch.exactEvent) {
          eventToUpdate = priorMatch.exactEvent;
        } else if (isNewerSourceEvent(event, prior)) {
          eventToUpdate = prior;
        } else {
          duplicateCount += 1;
          continue;
        }
      }
    }

    const processingContext = {
      scanRunId: context.scanRunId,
      taxonomy: context.taxonomy,
      technicalClassification: context.technicalClassification,
      addressability: context.addressability,
      priorEvent: prior,
    };
    const processed = await processCandidate(event, processingContext);

    if (processed.status === "excluded") {
      excludedCount += 1;
      continue;
    }
    if (eventToUpdate) {
      if (
        processed.event.contentFingerprint === eventToUpdate.contentFingerprint &&
        processed.event.addressability.configVersion === eventToUpdate.addressability.configVersion &&
        processed.event.technicalClassificationVersion === eventToUpdate.technicalClassificationVersion
      ) {
        duplicateCount += 1;
        continue;
      }
      await updateRetainedBiddingEvent(context.db, eventToUpdate.id, processed.event);
      retainedCount += 1;
      continue;
    }
    if (await persistRetainedBiddingEvent(context.db, processed.event)) {
      retainedCount += 1;
    } else {
      duplicateCount += 1;
    }
  }

  const result = {
    discoveredCount: scan.candidates.length,
    retainedCount,
    excludedCount,
    duplicateCount,
    nextCursor: scan.nextCursor,
  };
  await completeSourceRun(context.db, context.sourceRunId, {
    discoveredCount: result.discoveredCount,
    retainedCount: result.retainedCount,
    excludedCount: result.excludedCount,
    cursorAfter: result.nextCursor,
  });
  return result;
}
