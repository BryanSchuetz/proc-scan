import type { AddressabilityConfig } from "../classification/addressability";
import type { TaxonomyFile, TechnicalClassificationConfig } from "../classification/taxonomy";
import { findPriorBiddingEvent, persistRetainedBiddingEvent } from "../db/events";
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
    const prior = await findPriorBiddingEvent(
      context.db,
      event.sourceId,
      eventIdentity,
      event.sourceOpportunityId,
    );

    if (prior.event) {
      if (prior.exactIdentity && event.eventType === "tender") {
        event = { ...event, eventType: prior.event.eventType };
      } else if (!prior.exactIdentity && event.eventType === "tender") {
        event = { ...event, eventType: "modification" };
      }
    }

    const processingContext = {
      scanRunId: context.scanRunId,
      taxonomy: context.taxonomy,
      technicalClassification: context.technicalClassification,
      addressability: context.addressability,
      priorEvent: prior.event,
    };
    let processed = await processCandidate(event, processingContext);

    if (
      prior.exactIdentity &&
      prior.event?.eventType === "tender" &&
      event.eventType === "tender" &&
      (processed.status === "retained"
        ? processed.event.contentFingerprint
        : processed.contentFingerprint) !== prior.event.contentFingerprint
    ) {
      event = { ...event, eventType: "modification" };
      processed = await processCandidate(event, processingContext);
    }

    if (processed.status === "excluded") {
      excludedCount += 1;
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
