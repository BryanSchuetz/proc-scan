import type {
  SourceAdapter,
  SourceCandidate,
  SourceScanContext,
  SourceScanResult,
} from "./adapter";
import { SourceScanError } from "./adapter";
import { dgMarketSourceDefinition } from "./dg-market";

const RETRYABLE_BROWSER_ERRORS = new Set([
  "browser_challenge",
  "browser_navigation_failed",
  "browser_unavailable",
]);

export interface DgMarketFamilyAdapterOptions {
  dgMarket: SourceAdapter;
  mccDgMarket: SourceAdapter;
}

function distinct<T>(values: Array<T | undefined>): T[] {
  return [...new Set(values.filter((value): value is T => value !== undefined))];
}

function documentsFrom(...candidates: SourceCandidate[]) {
  return [...new Map(
    candidates.flatMap((candidate) => candidate.documents ?? []).map((document) => [document.url, document]),
  ).values()];
}

function channelSourceData(
  dgMarket: SourceCandidate | undefined,
  mccDgMarket: SourceCandidate | undefined,
): Record<string, unknown> {
  const primary = dgMarket?.sourceData ?? mccDgMarket?.sourceData ?? {};
  return {
    ...primary,
    clientCohort: dgMarket?.sourceData.clientCohort ?? mccDgMarket?.sourceData.clientCohort,
    channels: distinct([
      dgMarket ? "www2.dgmarket.com" : undefined,
      mccDgMarket ? "mcc.dgmarket.com" : undefined,
    ]),
    portalUrls: {
      ...(dgMarket ? { dgMarket: dgMarket.canonicalUrl } : {}),
      ...(mccDgMarket ? { mccDgMarket: mccDgMarket.canonicalUrl } : {}),
    },
    channelData: {
      ...(dgMarket ? { dgMarket: dgMarket.sourceData } : {}),
      ...(mccDgMarket ? { mccDgMarket: mccDgMarket.sourceData } : {}),
    },
  };
}

function asDgMarketCandidate(candidate: SourceCandidate): SourceCandidate {
  return {
    ...candidate,
    sourceId: dgMarketSourceDefinition.id,
    sourceData: channelSourceData(undefined, candidate),
  };
}

function mergeCandidates(
  dgMarket: SourceCandidate,
  mccDgMarket: SourceCandidate,
): SourceCandidate {
  return {
    ...mccDgMarket,
    sourceId: dgMarketSourceDefinition.id,
    sourceEventId: dgMarket.sourceEventId,
    sourceOpportunityId: dgMarket.sourceOpportunityId ?? mccDgMarket.sourceOpportunityId,
    canonicalUrl: mccDgMarket.canonicalUrl,
    originalEventType: dgMarket.originalEventType ?? mccDgMarket.originalEventType,
    eventType: dgMarket.eventType === "cancellation" || mccDgMarket.eventType === "cancellation"
      ? "cancellation"
      : dgMarket.eventType,
    publishedAt: dgMarket.publishedAt ?? mccDgMarket.publishedAt,
    dueDate: dgMarket.dueDate ?? mccDgMarket.dueDate,
    opportunityName: dgMarket.opportunityName,
    description: mccDgMarket.description ?? dgMarket.description,
    clientName: dgMarket.clientName ?? mccDgMarket.clientName,
    procuringEntityName: dgMarket.procuringEntityName ?? mccDgMarket.procuringEntityName,
    implementingEntityNames:
      dgMarket.implementingEntityNames ?? mccDgMarket.implementingEntityNames,
    funderNames: distinct([...(dgMarket.funderNames ?? []), ...(mccDgMarket.funderNames ?? [])]),
    value: dgMarket.value ?? mccDgMarket.value,
    placeOfPerformance: dgMarket.placeOfPerformance ?? mccDgMarket.placeOfPerformance,
    eligibility: dgMarket.eligibility ?? mccDgMarket.eligibility,
    sourceStatus: dgMarket.sourceStatus ?? mccDgMarket.sourceStatus,
    documents: documentsFrom(dgMarket, mccDgMarket),
    sourceData: channelSourceData(dgMarket, mccDgMarket),
  };
}

async function scanMccChannel(
  adapter: SourceAdapter,
  context: SourceScanContext,
): Promise<SourceScanResult> {
  try {
    return await adapter.scan(context);
  } catch (error) {
    if (
      !(error instanceof SourceScanError) ||
      !error.retryable ||
      !RETRYABLE_BROWSER_ERRORS.has(error.code) ||
      context.signal.aborted
    ) throw error;
    // The child adapter closes its failed Browser Run session in finally. Retrying
    // the full channel scan therefore starts with a fresh browser and clean page state.
    return adapter.scan(context);
  }
}

export function createDgMarketFamilyAdapter(options: DgMarketFamilyAdapterOptions): SourceAdapter {
  return {
    definition: dgMarketSourceDefinition,
    async scan(context): Promise<SourceScanResult> {
      const dgMarket = await options.dgMarket.scan(context);
      const mccDgMarket = await scanMccChannel(options.mccDgMarket, context);
      const byNoticeId = new Map<string, SourceCandidate>();
      const mccNoticeIds = new Set<string>();

      for (const candidate of dgMarket.candidates) {
        if (!candidate.sourceEventId) {
          throw new SourceScanError("invalid_record", "dgMarket returned a notice without an ID.", true);
        }
        byNoticeId.set(candidate.sourceEventId, candidate);
      }
      for (const candidate of mccDgMarket.candidates) {
        if (!candidate.sourceEventId) {
          throw new SourceScanError("invalid_record", "MCCDGMarket returned a notice without an ID.", true);
        }
        mccNoticeIds.add(candidate.sourceEventId);
        const existing = byNoticeId.get(candidate.sourceEventId);
        byNoticeId.set(
          candidate.sourceEventId,
          existing ? mergeCandidates(existing, candidate) : asDgMarketCandidate(candidate),
        );
      }

      return {
        candidates: [...byNoticeId.entries()]
          .map(([noticeId, candidate]) => mccNoticeIds.has(noticeId)
            ? candidate
            : {
                ...candidate,
                sourceData: channelSourceData(candidate, undefined),
              })
          .sort((a, b) =>
            (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "") ||
            (a.sourceEventId ?? "").localeCompare(b.sourceEventId ?? "")
          ),
        nextCursor: dgMarket.nextCursor,
      };
    },
  };
}
