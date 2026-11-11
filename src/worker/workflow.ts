import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import taxonomyRaw from "../../tech-area-classification.yaml?raw";
import classificationRaw from "../../config/technical-classification.yaml?raw";
import addressabilityRaw from "../../config/addressability.yaml?raw";
import dgMarketRaw from "../../config/dg-market.yaml?raw";
import grantsGovRaw from "../../config/grants-gov.yaml?raw";
import mccDgMarketRaw from "../../config/mcc-dg-market.yaml?raw";
import samGovRaw from "../../config/sam-gov.yaml?raw";
import simapRaw from "../../config/simap.yaml?raw";
import tedRaw from "../../config/ted.yaml?raw";
import { parseAddressabilityYaml } from "../classification/addressability";
import {
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
} from "../classification/taxonomy";
import {
  claimScanRun,
  completeEmptyScanRun,
  completeScanRun,
  completeSourceRun,
  failSourceRun,
  listEnabledSources,
  startSourceRun,
} from "../db/scan-runs";
import {
  prepareDigest,
  recordDigestAttempt,
  recordDigestFailed,
  recordDigestSent,
} from "../db/digests";
import { syncTechnicalAreas } from "../db/taxonomy";
import {
  CampaignMonitorError,
  sendCampaignMonitorDigest,
  type CampaignMonitorConfig,
} from "../digest/campaign-monitor";
import { renderDigest } from "../digest/render";
import { runSourceAdapter } from "../pipeline/run-source";
import { runQueuedUploads } from "../pipeline/run-uploads";
import { claimUploadsForScan } from "../db/uploads";
import { SourceScanError } from "../sources/adapter";
import { createRegisteredSourceAdapter } from "../sources";
import { parseDgMarketConfig } from "../sources/dg-market";
import { parseGrantsGovConfig, validateGrantsGovScope } from "../sources/grants-gov";
import { parseMccDgMarketConfig } from "../sources/mcc-dg-market";
import { parseSamGovConfig } from "../sources/sam-gov";
import { parseSimapConfig } from "../sources/simap";
import { parseTedConfig } from "../sources/ted";
import type { AppEnv } from "./index";

const TIME_ZONE = "Europe/London";
const taxonomy = parseTaxonomyYaml(taxonomyRaw);
const technicalClassification = parseTechnicalClassificationYaml(classificationRaw);
const taxonomyVersion = technicalClassification.schema_version;
const addressability = parseAddressabilityYaml(addressabilityRaw);
const dgMarket = parseDgMarketConfig(dgMarketRaw);
const samGov = parseSamGovConfig(samGovRaw);
const grantsGov = parseGrantsGovConfig(grantsGovRaw);
const mccDgMarket = parseMccDgMarketConfig(mccDgMarketRaw);
const ted = parseTedConfig(tedRaw);
const simap = parseSimapConfig(simapRaw);
validateGrantsGovScope(grantsGov, samGov.organizations);

export interface ScanWorkflowParams {
  requestedAt?: string;
  includeDiscoveredFrom?: string;
  includeDiscoveredBefore?: string;
}

export interface LocalScanCycle {
  cycleKey: string;
  scheduledFor: string;
}

export interface ScanTiming {
  cycleInstant: Date;
  scanInstant: Date;
}

export function scanCycleForEvent(
  timing: ScanTiming,
  scheduledTime: number | string | undefined,
): LocalScanCycle | undefined {
  if (scheduledTime !== undefined) return localScanCycleForInstant(timing.cycleInstant);
  return {
    cycleKey: `manual:${timing.scanInstant.toISOString()}`,
    scheduledFor: timing.cycleInstant.toISOString(),
  };
}

export function scanTimingForEvent(
  params: ScanWorkflowParams,
  scheduledTime: number | string | undefined,
  triggeredAt: Date,
): ScanTiming {
  const requestedAt = params.requestedAt ? new Date(params.requestedAt) : undefined;
  const scheduledAt = scheduledTime === undefined ? undefined : new Date(scheduledTime);
  const cycleInstant = requestedAt ?? scheduledAt ?? triggeredAt;
  const scanInstant = scheduledAt ?? triggeredAt;
  if (Number.isNaN(cycleInstant.getTime()) || Number.isNaN(scanInstant.getTime())) {
    throw new NonRetryableError("Invalid scan timestamp");
  }
  if (requestedAt && requestedAt.getTime() > scanInstant.getTime()) {
    throw new NonRetryableError("requestedAt cannot be in the future");
  }
  return { cycleInstant, scanInstant };
}

export function localScanCycleForInstant(instant: Date): LocalScanCycle | undefined {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  if (minute !== 0 || (hour !== 6 && hour !== 18)) return undefined;

  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return {
    cycleKey: `${date}:${hour === 6 ? "AM" : "PM"}`,
    scheduledFor: instant.toISOString(),
  };
}

function scanRunId(cycleKey: string): string {
  return `scan_${cycleKey.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function digestInclusionWindow(params: ScanWorkflowParams) {
  const from = params.includeDiscoveredFrom;
  const before = params.includeDiscoveredBefore;
  if (from === undefined && before === undefined) return undefined;
  if (
    !from || !before ||
    Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(before)) ||
    new Date(from).getTime() >= new Date(before).getTime()
  ) {
    throw new NonRetryableError("A valid digest discovery window requires ordered from and before timestamps");
  }
  return { from, before };
}

interface SourceFailure {
  code: string;
  message: string;
}

const RETRYABLE_SOURCE_FAILURE_PREFIX = "retryable_source_failure:";

function safeSourceFailure(error: unknown): SourceFailure {
  if (error instanceof SourceScanError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && error.message.startsWith(RETRYABLE_SOURCE_FAILURE_PREFIX)) {
    try {
      const failure = JSON.parse(error.message.slice(RETRYABLE_SOURCE_FAILURE_PREFIX.length));
      if (typeof failure.code === "string" && typeof failure.message === "string") return failure;
    } catch {
      // Fall through to the generic failure without reflecting malformed error content.
    }
  }
  return {
    code: "unexpected_source_failure",
    message: "The Source scan failed unexpectedly.",
  };
}

function campaignMonitorConfig(env: AppEnv): CampaignMonitorConfig | undefined {
  const values = [env.CAMP_MONTR_KEY, env.DIGEST_FROM, env.DIGEST_RECIPIENT];
  if (values.every((value) => !value?.trim())) return undefined;
  if (values.some((value) => !value?.trim())) {
    throw new NonRetryableError(
      "Digest delivery requires CAMP_MONTR_KEY, DIGEST_FROM, and DIGEST_RECIPIENT.",
    );
  }
  return {
    apiKey: env.CAMP_MONTR_KEY!,
    clientId: env.CAMP_MONTR_CLIENT_ID?.trim() || undefined,
    from: env.DIGEST_FROM!,
    replyTo: env.DIGEST_REPLY_TO?.trim() || undefined,
    recipient: env.DIGEST_RECIPIENT!,
  };
}

export class ScanWorkflow extends WorkflowEntrypoint<AppEnv, ScanWorkflowParams> {
  async run(event: WorkflowEvent<ScanWorkflowParams>, step: WorkflowStep) {
    const { cycleInstant, scanInstant } = scanTimingForEvent(
      event.payload ?? {},
      event.schedule?.scheduledTime,
      event.timestamp,
    );
    const inclusionWindow = digestInclusionWindow(event.payload ?? {});

    const cycle = await step.do("resolve scan cycle", async () =>
      scanCycleForEvent({ cycleInstant, scanInstant }, event.schedule?.scheduledTime),
    );
    if (!cycle) return { status: "skipped", reason: "not_a_local_scan_time" };

    const id = scanRunId(cycle.cycleKey);
    const claimed = await step.do("claim idempotent scan run", async () =>
      claimScanRun(this.env.DB, { id, ...cycle }),
    );
    if (!claimed) return { status: "skipped", reason: "cycle_already_claimed", scanRunId: id };

    await step.do("synchronize Technical Area taxonomy", async () =>
      syncTechnicalAreas(this.env.DB, taxonomy, taxonomyVersion),
    );

    const enabledSources = await step.do("load enabled Sources", async () =>
      listEnabledSources(this.env.DB),
    );
    const uploadSourceIds = await step.do("claim queued uploads", async () =>
      claimUploadsForScan(this.env.DB, id, scanInstant.toISOString()),
    );
    const sources = [...enabledSources, ...uploadSourceIds
      .filter((sourceId) => !enabledSources.some((source) => source.id === sourceId))
      .map((sourceId) => ({ id: sourceId, cursor: undefined }))];
    if (sources.length === 0) {
      await step.do("complete empty scan", async () => completeEmptyScanRun(this.env.DB, id));
      return { status: "completed", scanRunId: id, sourceCount: 0 };
    }

    for (const source of sources) {
      const sourceRunId = await step.do(`start ${source.id} Source run`, async () =>
        startSourceRun(this.env.DB, id, source.id, source.cursor),
      );
      let failure: SourceFailure | undefined;

      try {
        const uploadCounts = await step.do(`process ${source.id} uploads`, async () =>
          runQueuedUploads({
            db: this.env.DB, sourceId: source.id, sourceRunId, scanRunId: id,
            now: scanInstant, taxonomy, technicalClassification, addressability,
          }),
        );
        if (!enabledSources.some((enabled) => enabled.id === source.id)) {
          await step.do(`complete ${source.id} uploads-only run`, async () =>
            completeSourceRun(this.env.DB, sourceRunId, uploadCounts),
          );
          continue;
        }
        const adapter = createRegisteredSourceAdapter(source.id, this.env, {
          dgMarket,
          grantsGov,
          mccDgMarket,
          samGov,
          simap,
          ted,
        });
        const outcome = await step.do(`scan and process ${source.id}`, async () => {
          try {
            return {
              ok: true as const,
              result: await runSourceAdapter({
                db: this.env.DB,
                adapter,
                sourceRunId,
                scanRunId: id,
                cursor: source.cursor,
                signal: AbortSignal.timeout(4 * 60 * 1000),
                now: scanInstant,
                taxonomy,
                technicalClassification,
                addressability,
                initialCounts: uploadCounts,
              }),
            };
          } catch (error) {
            if (error instanceof SourceScanError) {
              if (!error.retryable) {
                return { ok: false as const, failure: safeSourceFailure(error) };
              }
              throw new Error(
                `${RETRYABLE_SOURCE_FAILURE_PREFIX}${JSON.stringify(safeSourceFailure(error))}`,
              );
            }
            throw error;
          }
        });
        if (!outcome.ok) failure = outcome.failure;
      } catch (error) {
        failure = safeSourceFailure(error);
      }

      if (failure) {
        await step.do(`record ${source.id} failure`, async () =>
          failSourceRun(this.env.DB, sourceRunId, failure.code, failure.message),
        );
      }
    }

    const completion = await step.do("complete scan run", async () =>
      completeScanRun(this.env.DB, id),
    );
    const deliveryConfig = campaignMonitorConfig(this.env);
    if (!deliveryConfig) {
      return {
        ...completion,
        scanRunId: id,
        sourceCount: sources.length,
        digestStatus: "not_configured",
      };
    }

    const digest = await step.do("prepare digest", async () =>
      prepareDigest(this.env.DB, id, inclusionWindow),
    );
    if (digest.status === "skipped_empty" || digest.status === "sent") {
      return {
        ...completion,
        scanRunId: id,
        sourceCount: sources.length,
        digestStatus: digest.status,
      };
    }

    await step.do("record digest attempt", async () =>
      recordDigestAttempt(this.env.DB, digest.id),
    );
    let providerMessageId: string;
    try {
      providerMessageId = await step.do("send digest", {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
        timeout: "1 minute",
      }, async () => {
        try {
          return await sendCampaignMonitorDigest(
            deliveryConfig,
            renderDigest(digest, this.env.REGISTRY_URL),
          );
        } catch (error) {
          if (error instanceof CampaignMonitorError && !error.retryable) {
            throw new NonRetryableError(error.code);
          }
          throw error;
        }
      });
    } catch (error) {
      const errorCode = error instanceof CampaignMonitorError
        ? error.code
        : error instanceof Error
          ? error.message
          : "digest_delivery_failed";
      await step.do("record digest failure", async () =>
        recordDigestFailed(this.env.DB, digest.id, errorCode),
      );
      return {
        ...completion,
        scanRunId: id,
        sourceCount: sources.length,
        digestStatus: "failed",
      };
    }

    await step.do("record digest delivery", async () =>
      recordDigestSent(this.env.DB, digest.id, providerMessageId),
    );
    return {
      ...completion,
      scanRunId: id,
      sourceCount: sources.length,
      digestStatus: "sent",
    };
  }
}
