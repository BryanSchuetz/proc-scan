import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import taxonomyRaw from "../../tech-area-classification.yaml?raw";
import classificationRaw from "../../config/technical-classification.yaml?raw";
import {
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
} from "../classification/taxonomy";
import { claimScanRun, completeEmptyScanRun, countEnabledSources, failScanRun } from "../db/scan-runs";
import { syncTechnicalAreas } from "../db/taxonomy";
import type { AppEnv } from "./index";

const TIME_ZONE = "America/New_York";
const taxonomy = parseTaxonomyYaml(taxonomyRaw);
const taxonomyVersion = parseTechnicalClassificationYaml(classificationRaw).schema_version;

export interface ScanWorkflowParams {
  requestedAt?: string;
}

export interface LocalScanCycle {
  cycleKey: string;
  scheduledFor: string;
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

export class ScanWorkflow extends WorkflowEntrypoint<AppEnv, ScanWorkflowParams> {
  async run(event: WorkflowEvent<ScanWorkflowParams>, step: WorkflowStep) {
    const instant = event.payload?.requestedAt
      ? new Date(event.payload.requestedAt)
      : new Date(event.schedule?.scheduledTime ?? event.timestamp.getTime());
    if (Number.isNaN(instant.getTime())) throw new NonRetryableError("Invalid requestedAt timestamp");

    const cycle = await step.do("resolve New York scan cycle", async () =>
      localScanCycleForInstant(instant),
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

    const enabledSources = await step.do("inspect enabled sources", async () =>
      countEnabledSources(this.env.DB),
    );
    if (enabledSources > 0) {
      await step.do("mark unsupported foundation scan", async () =>
        failScanRun(this.env.DB, id, "source_adapters_not_registered"),
      );
      throw new NonRetryableError("Enabled Sources require registered adapters");
    }

    await step.do("complete empty foundation scan", async () =>
      completeEmptyScanRun(this.env.DB, id),
    );
    return { status: "completed", scanRunId: id, sourceCount: 0 };
  }
}
