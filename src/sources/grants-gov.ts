import { parse } from "yaml";
import { z } from "zod";
import type {
  SourceAdapter,
  SourceCandidate,
  SourceDefinition,
  SourceScanContext,
  SourceScanResult,
} from "./adapter";
import { SourceScanError } from "./adapter";

const SEARCH_ENDPOINT = "https://api.grants.gov/v1/api/search2";
const DETAIL_ENDPOINT = "https://api.grants.gov/v1/api/fetchOpportunity";
const DEFAULT_PAGE_SIZE = 1000;
const DETAIL_CONCURRENCY = 8;
const PURSUABLE_STATUSES = "forecasted|posted";

function integerSchema(minimum: number) {
  return z.union([z.number(), z.string()]).transform((value, context) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum) {
      context.addIssue({ code: "custom", message: `Expected an integer of at least ${minimum}` });
      return z.NEVER;
    }
    return parsed;
  });
}

const optionalText = z.string().nullish();
const agencyOptionBaseSchema = z.object({
  label: z.string().trim().min(1),
  value: z.string().trim().min(1),
  count: integerSchema(0),
}).passthrough();
const agencyOptionSchema = agencyOptionBaseSchema.extend({
  subAgencyOptions: z.array(agencyOptionBaseSchema).optional().default([]),
});
const opportunitySchema = z.object({
  id: z.union([z.string(), z.number()]).transform((value, context) => {
    const id = String(value).trim();
    if (!/^\d+$/.test(id)) {
      context.addIssue({ code: "custom", message: "Expected a numeric opportunity ID" });
      return z.NEVER;
    }
    return id;
  }),
  number: z.string().trim().min(1),
  title: z.string().trim().min(1),
  agencyCode: z.string().trim().min(1),
  agencyName: optionalText,
  agency: optionalText,
  openDate: optionalText,
  closeDate: optionalText,
  oppStatus: z.string().trim().min(1),
  docType: optionalText,
  alnist: z.array(z.union([z.string(), z.number()])).nullish(),
  cfdaList: z.array(z.union([z.string(), z.number()])).nullish(),
}).passthrough().transform((value, context) => {
  const agencyName = value.agencyName?.trim() || value.agency?.trim();
  if (!agencyName) {
    context.addIssue({ code: "custom", message: "Expected an agency name" });
    return z.NEVER;
  }
  return {
    ...value,
    agencyName,
    alnist: value.alnist ?? value.cfdaList,
  };
});
const responseEnvelopeSchema = z.object({
  errorcode: integerSchema(0),
  msg: optionalText,
  data: z.unknown().optional(),
});
const optionalAmount = z.union([z.string(), z.number()]).nullish().transform((value) => {
  if (value === null || value === undefined || String(value).trim() === "") return undefined;
  const amount = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
});
const detailSectionSchema = z.object({
  synopsisDesc: optionalText,
  forecastDesc: optionalText,
  applicantEligibilityDesc: optionalText,
  estimatedFunding: optionalAmount,
  awardCeiling: optionalAmount,
  awardFloor: optionalAmount,
}).passthrough();
const detailDataSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  docType: optionalText,
  synopsis: detailSectionSchema.nullish(),
  forecast: detailSectionSchema.nullish(),
}).passthrough();
const searchDataSchema = z.object({
  hitCount: integerSchema(0),
  startRecord: integerSchema(0),
  oppHits: z.array(z.unknown()),
  agencies: z.array(agencyOptionSchema).optional().default([]),
});
const grantsGovConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  organizations: z.array(z.object({
    code: z.string().regex(/^\d{3}$/),
    name: z.string().trim().min(1),
    agency_code: z.string().trim().min(1).nullable(),
    agency_names: z.array(z.string().trim().min(1)).min(1),
  })).min(1),
});

type GrantsGovOpportunity = z.infer<typeof opportunitySchema>;
type GrantsGovOpportunityDetail = z.infer<typeof detailDataSchema>;
type GrantsGovOrganization = z.infer<typeof grantsGovConfigSchema>["organizations"][number];
export type GrantsGovConfig = z.infer<typeof grantsGovConfigSchema>;

export const grantsGovSourceDefinition: SourceDefinition = {
  id: "grants-gov",
  name: "Grants.gov",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface GrantsGovAdapterOptions {
  organizations: GrantsGovConfig["organizations"];
  fetch?: typeof fetch;
  pageSize?: number;
}

export function parseGrantsGovConfig(raw: string): GrantsGovConfig {
  const config = grantsGovConfigSchema.parse(parse(raw));
  const federalCodes = new Set<string>();
  const agencyCodes = new Set<string>();
  for (const organization of config.organizations) {
    if (federalCodes.has(organization.code)) {
      throw new Error(`Duplicate Grants.gov federal organization code: ${organization.code}`);
    }
    federalCodes.add(organization.code);
    if (organization.agency_code) {
      if (agencyCodes.has(organization.agency_code)) {
        throw new Error(`Duplicate Grants.gov agency code: ${organization.agency_code}`);
      }
      agencyCodes.add(organization.agency_code);
    }
  }
  return config;
}

export function validateGrantsGovScope(
  config: GrantsGovConfig,
  approvedOrganizations: ReadonlyArray<{ code: string }>,
): void {
  const configured = config.organizations.map(({ code }) => code).sort();
  const approved = approvedOrganizations.map(({ code }) => code).sort();
  if (configured.length !== approved.length || configured.some((code, index) => code !== approved[index])) {
    throw new Error("Grants.gov federal organization codes must match the approved SAM.gov scope");
  }
}

function normalizedSourceDate(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) return undefined;
  const [, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) return undefined;
  return date.toISOString();
}

function sourceErrorForStatus(status: number): SourceScanError {
  if (status === 429) {
    return new SourceScanError(
      "rate_limited",
      "Grants.gov rejected the scan because its request limit was reached.",
      false,
    );
  }
  if (status === 400) {
    return new SourceScanError(
      "request_rejected",
      "Grants.gov rejected the opportunity search parameters.",
      false,
    );
  }
  if (status === 401 || status === 403) {
    return new SourceScanError(
      "access_denied",
      "Grants.gov denied access to its public opportunity search.",
      false,
    );
  }
  return new SourceScanError(
    "source_unavailable",
    `Grants.gov opportunity search failed with HTTP ${status}.`,
    status >= 500,
  );
}

function plainTextFromHtml(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    ldquo: "“",
    lt: "<",
    mdash: "—",
    ndash: "–",
    nbsp: " ",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
  };
  const decoded = text
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith("#")) {
        const hexadecimal = code.startsWith("#x") || code.startsWith("#X");
        const point = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        return Number.isInteger(point) && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : entity;
      }
      return entities[code.toLocaleLowerCase()] ?? entity;
    });
  const normalized = decoded
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return normalized || undefined;
}

async function search(
  fetcher: typeof fetch,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetcher(SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof SourceScanError) throw error;
    throw new SourceScanError(
      "source_unavailable",
      "Grants.gov opportunity search failed before a response was received.",
      true,
    );
  }
  if (!response.ok) throw sourceErrorForStatus(response.status);

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new SourceScanError(
      "invalid_response",
      "Grants.gov returned an invalid JSON response.",
      true,
    );
  }
  const envelope = responseEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new SourceScanError(
      "invalid_response",
      "Grants.gov returned an unexpected opportunity search response.",
      true,
    );
  }
  if (envelope.data.errorcode !== 0) {
    throw new SourceScanError(
      "request_failed",
      "Grants.gov reported that the opportunity search failed.",
      false,
    );
  }
  const data = searchDataSchema.safeParse(envelope.data.data);
  if (!data.success) {
    throw new SourceScanError(
      "invalid_response",
      "Grants.gov returned unexpected opportunity search data.",
      true,
    );
  }
  return data.data;
}

async function fetchOpportunityDetail(
  fetcher: typeof fetch,
  opportunityId: string,
  signal: AbortSignal,
): Promise<GrantsGovOpportunityDetail> {
  let response: Response;
  try {
    response = await fetcher(DETAIL_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ opportunityId: Number(opportunityId) }),
      signal,
    });
  } catch (error) {
    if (error instanceof SourceScanError) throw error;
    throw new SourceScanError(
      "source_unavailable",
      "Grants.gov opportunity detail request failed before a response was received.",
      true,
    );
  }
  if (!response.ok) throw sourceErrorForStatus(response.status);

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new SourceScanError(
      "invalid_response",
      "Grants.gov returned invalid JSON for an opportunity detail.",
      true,
    );
  }
  const envelope = responseEnvelopeSchema.safeParse(raw);
  if (!envelope.success || envelope.data.errorcode !== 0) {
    throw new SourceScanError(
      "invalid_response",
      "Grants.gov returned an unexpected opportunity detail response.",
      true,
    );
  }
  const detail = detailDataSchema.safeParse(envelope.data.data);
  if (!detail.success || detail.data.id !== opportunityId) {
    throw new SourceScanError(
      "invalid_response",
      "Grants.gov returned an opportunity detail with an unexpected identifier.",
      true,
    );
  }
  return detail.data;
}

function approvedAgencyCodes(
  organizations: GrantsGovConfig["organizations"],
  agencyOptions: z.infer<typeof agencyOptionSchema>[],
): Map<string, GrantsGovOrganization> {
  const organizationByConfiguredCode = new Map(
    organizations.flatMap((organization) =>
      organization.agency_code ? [[organization.agency_code, organization] as const] : []),
  );
  const organizationByName = new Map(
    organizations.flatMap((organization) =>
      organization.agency_names.map((name) => [name.trim().toLocaleLowerCase(), organization] as const)),
  );
  const result = new Map<string, GrantsGovOrganization>();
  for (const option of agencyOptions) {
    const organization = organizationByConfiguredCode.get(option.value) ??
      organizationByName.get(option.label.trim().toLocaleLowerCase());
    if (!organization) continue;
    result.set(option.value, organization);
    for (const child of option.subAgencyOptions) result.set(child.value, organization);
  }
  return result;
}

function candidateFromOpportunity(
  opportunity: GrantsGovOpportunity,
  organization: GrantsGovOrganization,
  discoveredAt: string,
  detail: GrantsGovOpportunityDetail,
): SourceCandidate {
  const canonicalUrl = `https://www.grants.gov/search-results-detail/${encodeURIComponent(opportunity.id)}`;
  const alnList = [...new Set((opportunity.alnist ?? []).map(String).map((value) => value.trim()).filter(Boolean))]
    .sort();
  const docType = opportunity.docType?.trim() || undefined;
  const detailSection = detail.synopsis ?? detail.forecast;
  const description = plainTextFromHtml(detailSection?.synopsisDesc ?? detailSection?.forecastDesc);
  const eligibility = plainTextFromHtml(detailSection?.applicantEligibilityDesc);
  const valueAmount = detailSection?.estimatedFunding ?? detailSection?.awardCeiling;
  const valueBasis = detailSection?.estimatedFunding !== undefined
    ? "estimated-total-funding"
    : detailSection?.awardCeiling !== undefined
      ? "award-ceiling"
      : undefined;

  return {
    sourceId: grantsGovSourceDefinition.id,
    sourceEventId: opportunity.id,
    sourceOpportunityId: opportunity.number,
    canonicalUrl,
    originalEventType: docType ?? opportunity.oppStatus,
    eventType: "tender",
    publishedAt: normalizedSourceDate(opportunity.openDate),
    discoveredAt,
    opportunityName: plainTextFromHtml(opportunity.title) ?? opportunity.title,
    description,
    clientName: opportunity.agencyName,
    value: valueAmount === undefined ? undefined : { amount: valueAmount, currency: "USD" },
    dueDate: normalizedSourceDate(opportunity.closeDate),
    eligibility,
    sourceStatus: opportunity.oppStatus,
    documents: [{
      id: "grants-gov-opportunity",
      title: "Grants.gov opportunity",
      url: canonicalUrl,
      documentType: docType ?? "opportunity",
    }],
    sourceData: {
      opportunityId: opportunity.id,
      opportunityNumber: opportunity.number,
      federalOrganizationCode: organization.code,
      federalOrganizationName: organization.name,
      agencyCode: opportunity.agencyCode,
      agencyName: opportunity.agencyName,
      opportunityStatus: opportunity.oppStatus,
      documentType: docType,
      assistanceListingNumbers: alnList,
      estimatedFunding: detailSection?.estimatedFunding,
      awardCeiling: detailSection?.awardCeiling,
      awardFloor: detailSection?.awardFloor,
      valueBasis,
    },
  };
}

export function createGrantsGovAdapter(options: GrantsGovAdapterOptions): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
    throw new Error(`Grants.gov pageSize must be between 1 and ${DEFAULT_PAGE_SIZE}`);
  }
  if (options.organizations.length === 0) {
    throw new Error("Grants.gov requires at least one organization");
  }

  return {
    definition: grantsGovSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      const discovery = await search(fetcher, {
        rows: 1,
        startRecordNum: 0,
        oppStatuses: PURSUABLE_STATUSES,
      }, context.signal);
      const agencies = approvedAgencyCodes(options.organizations, discovery.agencies);
      if (agencies.size === 0) {
        return { candidates: [], nextCursor: { value: context.now.toISOString() } };
      }

      const opportunities = new Map<string, {
        opportunity: GrantsGovOpportunity;
        organization: GrantsGovOrganization;
      }>();
      let startRecordNum = 0;
      while (true) {
        const page = await search(fetcher, {
          rows: pageSize,
          startRecordNum,
          agencies: [...agencies.keys()].sort().join("|"),
          oppStatuses: PURSUABLE_STATUSES,
          sortBy: "openDate|desc",
        }, context.signal);
        if (page.startRecord !== startRecordNum) {
          throw new SourceScanError(
            "invalid_pagination",
            `Grants.gov returned start record ${page.startRecord} while ${startRecordNum} was requested.`,
            true,
          );
        }

        for (const [index, rawOpportunity] of page.oppHits.entries()) {
          const parsed = opportunitySchema.safeParse(rawOpportunity);
          if (!parsed.success) {
            throw new SourceScanError(
              "invalid_record",
              `Grants.gov returned an invalid opportunity at record ${startRecordNum + index}.`,
              true,
            );
          }
          const organization = agencies.get(parsed.data.agencyCode);
          if (!organization) {
            throw new SourceScanError(
              "unexpected_organization",
              `Grants.gov returned agency ${parsed.data.agencyCode} outside the approved scope.`,
              true,
            );
          }
          opportunities.set(parsed.data.id, { opportunity: parsed.data, organization });
        }

        const loadedThrough = startRecordNum + page.oppHits.length;
        if (loadedThrough >= page.hitCount) break;
        if (page.oppHits.length === 0) {
          throw new SourceScanError(
            "invalid_pagination",
            "Grants.gov returned an empty page before the opportunity search was complete.",
            true,
          );
        }
        startRecordNum = loadedThrough;
      }

      const discoveredAt = context.now.toISOString();
      const detailedOpportunities: Array<{
        opportunity: GrantsGovOpportunity;
        organization: GrantsGovOrganization;
        detail: GrantsGovOpportunityDetail;
      }> = [];
      const records = [...opportunities.values()];
      for (let index = 0; index < records.length; index += DETAIL_CONCURRENCY) {
        const batch = records.slice(index, index + DETAIL_CONCURRENCY);
        detailedOpportunities.push(...await Promise.all(batch.map(async ({ opportunity, organization }) => ({
          opportunity,
          organization,
          detail: await fetchOpportunityDetail(fetcher, opportunity.id, context.signal),
        }))));
      }
      const candidates = detailedOpportunities
        .map(({ opportunity, organization, detail }) =>
          candidateFromOpportunity(opportunity, organization, discoveredAt, detail))
        .sort((a, b) =>
          (a.publishedAt ?? a.discoveredAt ?? discoveredAt).localeCompare(
            b.publishedAt ?? b.discoveredAt ?? discoveredAt,
          ) ||
          (a.sourceEventId ?? "").localeCompare(b.sourceEventId ?? ""),
        );

      return {
        candidates,
        nextCursor: { value: context.now.toISOString() },
      };
    },
  };
}
