import { parse } from "yaml";
import { z } from "zod";
import type {
  SourceAdapter,
  SourceCandidate,
  SourceDefinition,
  SourceScanContext,
} from "./adapter";
import { SourceScanError } from "./adapter";

const API_BASE = "https://www.simap.ch/api";
const PUBLIC_PAGE_BASE = "https://www.simap.ch/en/project-detail";
const USER_AGENT = "proc-scan/1.0 (+https://github.com/BryanSchuetz/proc-scan)";
const MAX_PAGES_PER_ORGANIZATION = 100;
const DETAIL_BATCH_SIZE = 5;

const translationSchema = z.record(z.string(), z.string().nullable());
const projectSchema = z.object({
  id: z.string().uuid(),
  title: translationSchema,
  projectNumber: z.string().trim().min(1),
  projectSubType: z.literal("service"),
  publicationId: z.string().uuid(),
  publicationDate: z.string().date(),
  publicationNumber: z.string().trim().min(1),
  pubType: z.string().trim().min(1),
  corrected: z.boolean(),
  procOfficeName: translationSchema,
}).passthrough();
const searchResponseSchema = z.object({
  projects: z.array(z.unknown()),
  pagination: z.object({
    lastItem: z.string(),
    itemsPerPage: z.number().int().positive(),
  }).passthrough(),
}).passthrough();
const detailSchema = z.object({
  id: z.string().uuid(),
  type: z.string().trim().min(1),
  base: z.object({
    id: z.string().uuid(),
    title: translationSchema,
    projectId: z.string().uuid(),
    projectNumber: z.string().trim().min(1),
    publicationNumber: z.string().trim().min(1),
    publicationDate: z.string().date(),
    procOfficeId: z.string().uuid(),
    corrected: z.boolean().optional(),
  }).passthrough(),
  "project-info": z.object({
    procOfficeAddress: z.object({
      name: translationSchema,
      countryId: z.string().nullable().optional(),
      city: translationSchema.nullish(),
    }).passthrough(),
  }).passthrough(),
  procurement: z.object({
    orderDescription: translationSchema,
    processType: z.string().trim().min(1),
    orderType: z.literal("service"),
    cpvCode: z.object({ code: z.string().trim().min(1) }).passthrough().nullable().optional(),
    orderAddressDescription: translationSchema.nullish(),
    orderAddress: z.object({
      countryId: z.string().nullable().optional(),
      city: translationSchema.nullish(),
    }).passthrough().nullable().optional(),
  }).passthrough(),
  dates: z.object({
    offerDeadline: z.string().datetime({ offset: true }).nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();
const simapConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  client: z.literal("Swiss-SDC/SECO"),
  project_subtype: z.literal("service"),
  publication_type: z.literal("tender"),
  initial_lookback_days: z.number().int().positive().max(730),
  cursor_lookback_days: z.number().int().positive().max(30),
  organizations: z.array(z.object({
    id: z.enum(["sdc", "seco"]),
    search: z.string().trim().min(3),
    office_name_terms: z.array(z.string().trim().min(3)).min(1),
  })).length(2),
});

type Project = z.infer<typeof projectSchema>;
type Detail = z.infer<typeof detailSchema>;
type SimapOrganization = z.infer<typeof simapConfigSchema>["organizations"][number];
export type SimapConfig = z.infer<typeof simapConfigSchema>;

export const simapSourceDefinition: SourceDefinition = {
  id: "simap",
  name: "SIMAP",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface SimapAdapterOptions {
  config: SimapConfig;
  fetch?: typeof fetch;
}

export function parseSimapConfig(raw: string): SimapConfig {
  const config = simapConfigSchema.parse(parse(raw));
  if (new Set(config.organizations.map(({ id }) => id)).size !== config.organizations.length) {
    throw new Error("Duplicate SIMAP organization ID");
  }
  return config;
}

function sourceErrorForStatus(status: number): SourceScanError {
  if (status === 429) {
    return new SourceScanError("rate_limited", "SIMAP rejected the scan because its request limit was reached.", true);
  }
  if (status === 400) {
    return new SourceScanError("request_rejected", "SIMAP rejected the configured publication search.", false);
  }
  if (status === 401 || status === 403) {
    return new SourceScanError("access_denied", "SIMAP denied access to its public publication API.", false);
  }
  return new SourceScanError(
    "source_unavailable",
    `SIMAP publication request failed with HTTP ${status}.`,
    status >= 500,
  );
}

async function requestJson(fetcher: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal,
    });
  } catch {
    throw new SourceScanError(
      "source_unavailable",
      "SIMAP publication request failed before a response was received.",
      true,
    );
  }
  if (!response.ok) throw sourceErrorForStatus(response.status);
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new SourceScanError("invalid_response", "SIMAP returned a non-JSON publication response.", true);
  }
  try {
    return await response.json();
  } catch {
    throw new SourceScanError("invalid_response", "SIMAP returned invalid publication JSON.", true);
  }
}

function searchStart(context: SourceScanContext, config: SimapConfig): string {
  const cursor = context.cursor?.value ? new Date(context.cursor.value) : undefined;
  if (cursor && Number.isNaN(cursor.getTime())) {
    throw new SourceScanError("invalid_cursor", "SIMAP received an invalid scan cursor.", false);
  }
  const start = cursor ?? context.now;
  const days = cursor ? config.cursor_lookback_days : config.initial_lookback_days;
  return new Date(start.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function searchUrl(
  organization: SimapOrganization,
  config: SimapConfig,
  from: string,
  lastItem?: string,
): string {
  const url = new URL(`${API_BASE}/publications/v2/project/project-search`);
  url.searchParams.set("search", organization.search);
  url.searchParams.set("lang", "en");
  url.searchParams.set("projectSubTypes", config.project_subtype);
  url.searchParams.set("newestPubTypes", config.publication_type);
  url.searchParams.set("newestPublicationFrom", from);
  if (lastItem) url.searchParams.set("lastItem", lastItem);
  return url.toString();
}

function translated(value: z.infer<typeof translationSchema> | null | undefined): string | undefined {
  for (const language of ["en", "de", "fr", "it"]) {
    const text = value?.[language]?.trim();
    if (text) return text;
  }
  return Object.values(value ?? {}).find((text) => text?.trim())?.trim();
}

function plainText(value: string | undefined): string | undefined {
  const text = value
    ?.replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

function isOrganizationProject(project: Project, organization: SimapOrganization): boolean {
  const officeNames = Object.values(project.procOfficeName).filter((name): name is string => Boolean(name));
  return organization.office_name_terms.some((term) =>
    officeNames.some((name) => name.toLowerCase().includes(term.toLowerCase()))
  );
}

async function listProjects(
  fetcher: typeof fetch,
  organization: SimapOrganization,
  config: SimapConfig,
  from: string,
  signal: AbortSignal,
): Promise<Project[]> {
  const projects: Project[] = [];
  const seenLastItems = new Set<string>();
  let lastItem: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_ORGANIZATION; page += 1) {
    const raw = await requestJson(fetcher, searchUrl(organization, config, from, lastItem), signal);
    const response = searchResponseSchema.safeParse(raw);
    if (!response.success) {
      throw new SourceScanError("invalid_response", "SIMAP returned an unexpected publication-search response.", true);
    }
    if (response.data.projects.length > response.data.pagination.itemsPerPage) {
      throw new SourceScanError("invalid_pagination", "SIMAP returned inconsistent publication pagination metadata.", true);
    }
    for (const rawProject of response.data.projects) {
      const project = projectSchema.safeParse(rawProject);
      if (!project.success) {
        throw new SourceScanError("invalid_response", "SIMAP returned an unexpected publication-search record.", true);
      }
      if (isOrganizationProject(project.data, organization)) projects.push(project.data);
    }
    const next = response.data.pagination.lastItem;
    if (!next || response.data.projects.length < response.data.pagination.itemsPerPage) return projects;
    if (seenLastItems.has(next)) {
      throw new SourceScanError("invalid_pagination", "SIMAP repeated a rolling-pagination cursor.", true);
    }
    seenLastItems.add(next);
    lastItem = next;
  }
  throw new SourceScanError("invalid_pagination", "SIMAP publication search exceeded its pagination safety limit.", true);
}

function eventType(detail: Detail): SourceCandidate["eventType"] | undefined {
  if (detail.type === "tender") return detail.base.corrected ? "modification" : "tender";
  if (detail.type === "correction") return "modification";
  if (detail.type === "revocation" || detail.type === "abandonment") return "cancellation";
  return undefined;
}

function place(detail: Detail) {
  const address = detail.procurement.orderAddress;
  const description = plainText(translated(detail.procurement.orderAddressDescription))
    ?? translated(address?.city);
  const countryCode = address?.countryId ?? detail["project-info"].procOfficeAddress.countryId ?? undefined;
  return description || countryCode ? { description, countryCode } : undefined;
}

function normalize(project: Project, detail: Detail, config: SimapConfig): SourceCandidate | undefined {
  if (
    detail.id !== project.publicationId ||
    detail.base.projectId !== project.id ||
    detail.base.projectNumber !== project.projectNumber ||
    detail.base.publicationNumber !== project.publicationNumber
  ) {
    throw new SourceScanError("invalid_response", "SIMAP publication detail did not match its search record.", true);
  }
  const mappedType = eventType(detail);
  if (!mappedType) return undefined;
  const dueDate = detail.dates?.offerDeadline
    ? new Date(detail.dates.offerDeadline).toISOString()
    : undefined;
  const officeName = translated(detail["project-info"].procOfficeAddress.name)
    ?? translated(project.procOfficeName);
  const opportunityName = translated(detail.base.title) ?? translated(project.title);
  if (!opportunityName) {
    throw new SourceScanError("invalid_response", "SIMAP returned a publication without a title.", true);
  }
  return {
    sourceId: simapSourceDefinition.id,
    sourceEventId: detail.id,
    sourceOpportunityId: detail.base.projectId,
    canonicalUrl: `${PUBLIC_PAGE_BASE}/${detail.base.projectId}`,
    originalEventType: detail.type,
    eventType: mappedType,
    isFormalAmendment: mappedType !== "tender",
    publishedAt: `${detail.base.publicationDate}T00:00:00.000Z`,
    opportunityName,
    description: plainText(translated(detail.procurement.orderDescription)),
    clientName: config.client,
    procuringEntityName: officeName,
    dueDate,
    placeOfPerformance: place(detail),
    sourceStatus: detail.procurement.processType,
    sourceData: {
      projectNumber: detail.base.projectNumber,
      publicationNumber: detail.base.publicationNumber,
      procurementOfficeId: detail.base.procOfficeId,
      projectSubType: project.projectSubType,
      cpvCode: detail.procurement.cpvCode?.code,
      corrected: detail.base.corrected ?? project.corrected,
    },
  };
}

export function createSimapAdapter(options: SimapAdapterOptions): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  return {
    definition: simapSourceDefinition,
    async scan(context) {
      const from = searchStart(context, options.config);
      const listed = (await Promise.all(options.config.organizations.map((organization) =>
        listProjects(fetcher, organization, options.config, from, context.signal)
      ))).flat();
      const unique = [...new Map(listed.map((project) => [project.publicationId, project])).values()];
      const candidates: SourceCandidate[] = [];
      for (let index = 0; index < unique.length; index += DETAIL_BATCH_SIZE) {
        const batch = unique.slice(index, index + DETAIL_BATCH_SIZE);
        const details = await Promise.all(batch.map(async (project) => {
          const raw = await requestJson(
            fetcher,
            `${API_BASE}/publications/v1/project/${project.id}/publication-details/${project.publicationId}`,
            context.signal,
          );
          const detail = detailSchema.safeParse(raw);
          if (!detail.success) {
            throw new SourceScanError("invalid_response", "SIMAP returned an unexpected publication-detail response.", true);
          }
          return normalize(project, detail.data, options.config);
        }));
        candidates.push(...details.filter((candidate): candidate is SourceCandidate => Boolean(candidate)));
      }
      return { candidates, nextCursor: { value: context.now.toISOString() } };
    },
  };
}
