import { z } from "zod";
import { parse } from "yaml";
import type {
  SourceAdapter,
  SourceCandidate,
  SourceDefinition,
  SourceScanContext,
  SourceScanResult,
} from "./adapter";
import { SourceScanError } from "./adapter";
import type { SourceDocument } from "../domain/types";

const SEARCH_ENDPOINT = "https://api.sam.gov/opportunities/v2/search";
const DEFAULT_PAGE_SIZE = 1000;
const MAX_LOOKBACK_DAYS = 2;
const PURSUABLE_NOTICE_CODES = ["p", "r", "s", "o", "k", "i"];
const PURSUABLE_NOTICE_TYPES = new Set([
  "pre solicitation",
  "presolicitation",
  "sources sought",
  "special notice",
  "solicitation",
  "combined synopsis/solicitation",
  "intent to bundle requirements (dod-funded)",
]);

const optionalText = z.string().nullish();
const namedCodeSchema = z
  .object({
    code: optionalText,
    name: optionalText,
  })
  .nullish();
const placeSchema = z
  .object({
    streetAddress: optionalText,
    streetAddress2: optionalText,
    city: namedCodeSchema,
    state: namedCodeSchema,
    zip: optionalText,
    country: namedCodeSchema,
  })
  .passthrough()
  .nullish();
const opportunitySchema = z
  .object({
    noticeId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    solicitationNumber: optionalText,
    fullParentPathName: optionalText,
    fullParentPathCode: optionalText,
    department: optionalText,
    subTier: optionalText,
    office: optionalText,
    postedDate: optionalText,
    type: z.string().trim().min(1),
    baseType: optionalText,
    archiveType: optionalText,
    archiveDate: optionalText,
    typeOfSetAside: optionalText,
    typeOfSetAsideDescription: optionalText,
    responseDeadLine: optionalText,
    naicsCode: optionalText,
    naicsCodes: z.unknown().optional(),
    classificationCode: optionalText,
    active: optionalText,
    description: optionalText,
    organizationType: optionalText,
    placeOfPerformance: placeSchema,
    additionalInfoLink: optionalText,
    resourceLinks: z.array(z.string()).nullish(),
  })
  .passthrough();
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
const responseSchema = z.object({
  totalRecords: integerSchema(0),
  limit: integerSchema(1),
  offset: integerSchema(0),
  opportunitiesData: z.array(z.unknown()),
});
const samGovConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  organizations: z.array(z.object({
    code: z.string().regex(/^\d{3}$/),
    name: z.string().trim().min(1),
  })).min(1),
});

type SamOpportunity = z.infer<typeof opportunitySchema>;
export type SamGovConfig = z.infer<typeof samGovConfigSchema>;

export const samGovSourceDefinition: SourceDefinition = {
  id: "sam-gov",
  name: "SAM.gov",
  accessMode: "api-key",
  phase: 2,
  adapterVersion: "1.0.0",
};

export interface SamGovAdapterOptions {
  apiKey: string;
  organizations: SamGovConfig["organizations"];
  fetch?: typeof fetch;
  pageSize?: number;
}

export function parseSamGovConfig(raw: string): SamGovConfig {
  const config = samGovConfigSchema.parse(parse(raw));
  const codes = new Set<string>();
  for (const organization of config.organizations) {
    if (codes.has(organization.code)) {
      throw new Error(`Duplicate SAM.gov organization code: ${organization.code}`);
    }
    codes.add(organization.code);
  }
  return config;
}

function presentText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text && text.toLocaleLowerCase() !== "null" ? text : undefined;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function apiDate(date: Date): string {
  const [year, month, day] = utcDate(date).split("-");
  return `${month}/${day}/${year}`;
}

function scanStart(context: SourceScanContext): Date {
  const oldest = new Date(context.now);
  oldest.setUTCDate(oldest.getUTCDate() - MAX_LOOKBACK_DAYS);

  const cursorValue = context.cursor?.value ?? context.cursor?.lookbackStartedAt;
  if (!cursorValue) return oldest;
  const cursor = new Date(cursorValue);
  if (Number.isNaN(cursor.getTime()) || cursor > context.now) return oldest;
  return cursor > oldest ? cursor : oldest;
}

function normalizedSourceDate(value: string | null | undefined): string | undefined {
  const text = presentText(value);
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00.000Z`;
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text.replace(" ", "T")}Z`;
  const date = new Date(explicitZone);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function hierarchyParts(value: string | null | undefined): string[] {
  return presentText(value)?.split(".").map((part) => part.trim()).filter(Boolean) ?? [];
}

function sourceOpportunityId(opportunity: SamOpportunity): string {
  const solicitationNumber = presentText(opportunity.solicitationNumber);
  if (!solicitationNumber) return opportunity.noticeId;
  const organizationScope = hierarchyParts(opportunity.fullParentPathCode).slice(0, 2).join(".");
  return organizationScope ? `${organizationScope}:${solicitationNumber}` : solicitationNumber;
}

function placeOfPerformance(opportunity: SamOpportunity): SourceCandidate["placeOfPerformance"] {
  const place = opportunity.placeOfPerformance;
  if (!place) return undefined;
  const parts = [
    presentText(place.streetAddress),
    presentText(place.streetAddress2),
    presentText(place.city?.name),
    presentText(place.state?.name) ?? presentText(place.state?.code),
    presentText(place.zip),
    presentText(place.country?.name) ?? presentText(place.country?.code),
  ].filter((part): part is string => Boolean(part));
  const countryCode = presentText(place.country?.code);
  return parts.length > 0 || countryCode
    ? { description: parts.length > 0 ? parts.join(", ") : undefined, countryCode }
    : undefined;
}

function publicUrl(value: string | null | undefined): string | undefined {
  const text = presentText(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.searchParams.delete("api_key");
    return url.toString();
  } catch {
    return undefined;
  }
}

function documents(opportunity: SamOpportunity, canonicalUrl: string): SourceDocument[] {
  const result: SourceDocument[] = [
    {
      id: "sam-notice",
      title: "SAM.gov opportunity",
      url: canonicalUrl,
      documentType: "notice",
    },
  ];
  const additionalInfo = publicUrl(opportunity.additionalInfoLink);
  if (additionalInfo) {
    result.push({
      id: "additional-information",
      title: "Additional information",
      url: additionalInfo,
      documentType: "additionalInformation",
    });
  }
  const resourceLinks = [...new Set((opportunity.resourceLinks ?? []).flatMap((value) => {
    const url = publicUrl(value);
    return url ? [url] : [];
  }))].sort();
  resourceLinks.forEach((url, index) => {
    result.push({
      id: `attachment-${index + 1}`,
      title: `Attachment ${index + 1}`,
      url,
      documentType: "attachment",
    });
  });
  return result;
}

function candidateFromOpportunity(
  opportunity: SamOpportunity,
  federalOrganizationCode: string,
  discoveredAt: string,
): SourceCandidate | undefined {
  if (!PURSUABLE_NOTICE_TYPES.has(opportunity.type.trim().toLocaleLowerCase())) return undefined;

  const names = hierarchyParts(opportunity.fullParentPathName);
  const clientName = presentText(opportunity.subTier) ?? names[1] ?? names[0];
  const procuringEntityName = presentText(opportunity.office) ?? names.at(-1);
  const canonicalUrl = `https://sam.gov/opp/${encodeURIComponent(opportunity.noticeId)}/view`;
  const setAside = presentText(opportunity.typeOfSetAsideDescription);
  const sourceStatus = presentText(opportunity.active)?.toLocaleLowerCase() === "yes"
    ? "active"
    : presentText(opportunity.active)?.toLocaleLowerCase() === "no"
      ? "inactive"
      : presentText(opportunity.active);

  return {
    sourceId: samGovSourceDefinition.id,
    sourceEventId: opportunity.noticeId,
    sourceOpportunityId: sourceOpportunityId(opportunity),
    canonicalUrl,
    originalEventType: opportunity.type,
    eventType: "tender",
    publishedAt: normalizedSourceDate(opportunity.postedDate),
    discoveredAt,
    opportunityName: opportunity.title.trim(),
    clientName,
    procuringEntityName:
      procuringEntityName && procuringEntityName !== clientName ? procuringEntityName : undefined,
    dueDate: normalizedSourceDate(opportunity.responseDeadLine),
    placeOfPerformance: placeOfPerformance(opportunity),
    eligibility: setAside,
    sourceStatus,
    documents: documents(opportunity, canonicalUrl),
    sourceData: {
      noticeId: opportunity.noticeId,
      solicitationNumber: presentText(opportunity.solicitationNumber),
      federalOrganizationCode,
      fullParentPathName: presentText(opportunity.fullParentPathName),
      fullParentPathCode: presentText(opportunity.fullParentPathCode),
      noticeType: opportunity.type,
      baseType: presentText(opportunity.baseType),
      archiveType: presentText(opportunity.archiveType),
      archiveDate: normalizedSourceDate(opportunity.archiveDate),
      active: presentText(opportunity.active),
      responseDeadline: presentText(opportunity.responseDeadLine),
      naicsCode: presentText(opportunity.naicsCode),
      naicsCodes: opportunity.naicsCodes,
      classificationCode: presentText(opportunity.classificationCode),
      setAsideCode: presentText(opportunity.typeOfSetAside),
      setAsideDescription: setAside,
      organizationType: presentText(opportunity.organizationType),
      descriptionUrl: publicUrl(opportunity.description),
    },
  };
}

function sourceErrorForStatus(status: number): SourceScanError {
  if (status === 429) {
    return new SourceScanError(
      "rate_limited",
      "SAM.gov rejected the scan because the API request quota was exhausted.",
      false,
    );
  }
  if (status === 401 || status === 403) {
    return new SourceScanError(
      "authentication_failed",
      "SAM.gov rejected the configured API key.",
      false,
    );
  }
  if (status === 400) {
    return new SourceScanError(
      "request_rejected",
      "SAM.gov rejected the opportunity search parameters.",
      false,
    );
  }
  return new SourceScanError(
    "source_unavailable",
    `SAM.gov opportunity search failed with HTTP ${status}.`,
    status >= 500,
  );
}

export function createSamGovAdapter(options: SamGovAdapterOptions): SourceAdapter {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new SourceScanError(
      "missing_credentials",
      "SAM.gov is enabled but SAM_API_KEY is not configured.",
      false,
    );
  }
  const fetcher = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
    throw new Error(`SAM.gov pageSize must be between 1 and ${DEFAULT_PAGE_SIZE}`);
  }
  if (options.organizations.length === 0) {
    throw new Error("SAM.gov requires at least one organization");
  }

  return {
    definition: samGovSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      const postedFrom = apiDate(scanStart(context));
      const postedTo = apiDate(context.now);
      const opportunities = new Map<string, {
        opportunity: SamOpportunity;
        federalOrganizationCode: string;
      }>();

      for (const organization of options.organizations) {
        let offset = 0;
        while (true) {
          const url = new URL(SEARCH_ENDPOINT);
          url.searchParams.set("api_key", apiKey);
          url.searchParams.set("postedFrom", postedFrom);
          url.searchParams.set("postedTo", postedTo);
          url.searchParams.set("organizationCode", organization.code);
          url.searchParams.set("limit", String(pageSize));
          url.searchParams.set("offset", String(offset));
          for (const code of PURSUABLE_NOTICE_CODES) url.searchParams.append("ptype", code);

          let response: Response;
          try {
            response = await fetcher(url, { signal: context.signal });
          } catch (error) {
            if (error instanceof SourceScanError) throw error;
            throw new SourceScanError(
              "source_unavailable",
              "SAM.gov opportunity search failed before a response was received.",
              true,
            );
          }
          if (response.status === 404) break;
          if (!response.ok) throw sourceErrorForStatus(response.status);

          let raw: unknown;
          try {
            raw = await response.json();
          } catch {
            throw new SourceScanError(
              "invalid_response",
              "SAM.gov returned an invalid JSON response.",
              true,
            );
          }
          const parsed = responseSchema.safeParse(raw);
          if (!parsed.success) {
            throw new SourceScanError(
              "invalid_response",
              "SAM.gov returned an unexpected opportunity search response.",
              true,
            );
          }

          for (const [index, rawOpportunity] of parsed.data.opportunitiesData.entries()) {
            const opportunity = opportunitySchema.safeParse(rawOpportunity);
            if (!opportunity.success) {
              throw new SourceScanError(
                "invalid_record",
                `SAM.gov returned an invalid opportunity for organization ${organization.code} at page ${offset}, record ${index}.`,
                true,
              );
            }
            const returnedOrganization = hierarchyParts(opportunity.data.fullParentPathCode)[0];
            if (returnedOrganization && returnedOrganization !== organization.code) {
              throw new SourceScanError(
                "unexpected_organization",
                `SAM.gov returned organization ${returnedOrganization} while scanning ${organization.code}.`,
                true,
              );
            }
            opportunities.set(opportunity.data.noticeId, {
              opportunity: opportunity.data,
              federalOrganizationCode: organization.code,
            });
          }

          const loadedThrough = (offset + 1) * parsed.data.limit;
          if (loadedThrough >= parsed.data.totalRecords) break;
          if (parsed.data.opportunitiesData.length === 0) {
            throw new SourceScanError(
              "invalid_pagination",
              `SAM.gov returned an empty page before organization ${organization.code} was complete.`,
              true,
            );
          }
          offset += 1;
        }
      }

      const discoveredAt = context.now.toISOString();
      const candidates = [...opportunities.values()]
        .flatMap(({ opportunity, federalOrganizationCode }) => {
          const candidate = candidateFromOpportunity(opportunity, federalOrganizationCode, discoveredAt);
          return candidate ? [candidate] : [];
        })
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
