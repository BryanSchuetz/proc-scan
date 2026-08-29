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

const SEARCH_ENDPOINT = "https://api.tech.ec.europa.eu/search-api/prod/rest/search";
const PUBLIC_API_KEY = "SEDIA";
const MAX_PAGE_SIZE = 100;
const TENDER_TYPE_CODE = "0";
const STATUS_CODES = {
  forthcoming: "31094501",
  open: "31094502",
} as const;
const DISPLAY_FIELDS = [
  "identifier",
  "cftId",
  "callIdentifier",
  "title",
  "description",
  "status",
  "type",
  "startDate",
  "deadlineDate",
  "twoStageDeadlineDate",
  "closingDate",
  "updateDate",
  "cftPublicationDateEForm",
  "cftEXARegistrationDeadline",
  "cftPlannedDate",
  "cftEstimatedTotalProcedureValue",
  "cftEstimatedOverallContractAmount",
  "cftEstimatedOverallContractCurrency",
  "cftLeadContractingAuthorityCode",
  "cftPartyLegalEntityId",
  "procedureType",
  "contractType",
  "mainCpv",
  "geographicalZone",
  "geographicalZones",
  "cftPublishedPinReference",
  "cftContractNoticeLink",
  "cftCorrigendaList",
  "cftRepublish",
] as const;

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

const textList = z.array(z.string()).nullish().transform((values) =>
  values?.map((value) => value.trim()).filter(Boolean) ?? []
);
const metadataSchema = z.object({
  identifier: textList,
  cftId: textList,
  callIdentifier: textList,
  title: textList,
  description: textList,
  status: textList,
  type: textList,
  startDate: textList,
  deadlineDate: textList,
  twoStageDeadlineDate: textList,
  closingDate: textList,
  updateDate: textList,
  cftPublicationDateEForm: textList,
  cftEXARegistrationDeadline: textList,
  cftPlannedDate: textList,
  cftEstimatedTotalProcedureValue: textList,
  cftEstimatedOverallContractAmount: textList,
  cftEstimatedOverallContractCurrency: textList,
  cftLeadContractingAuthorityCode: textList,
  cftPartyLegalEntityId: textList,
  procedureType: textList,
  contractType: textList,
  mainCpv: textList,
  geographicalZone: textList,
  geographicalZones: textList,
  cftPublishedPinReference: textList,
  cftContractNoticeLink: textList,
  cftCorrigendaList: textList,
  cftRepublish: textList,
}).passthrough();
const searchResultSchema = z.object({
  reference: z.string().trim().min(1),
  summary: z.string().nullish(),
  content: z.string().nullish(),
  metadata: metadataSchema,
}).passthrough();
const responseSchema = z.object({
  totalResults: integerSchema(0),
  pageNumber: integerSchema(1),
  pageSize: integerSchema(1),
  results: z.array(z.unknown()),
}).passthrough();
const authoritySchema = z.object({
  name: z.string().trim().min(1),
  link: z.string().trim().url().optional(),
  isLeadAuthority: z.boolean().optional(),
}).passthrough();
const corrigendumNoticeSchema = z.object({
  noticeID: z.string().trim().min(1),
  publicationDate: z.string().trim().min(1),
  publicationID: z.string().trim().min(1).optional(),
  versionID: z.string().trim().min(1).optional(),
  gazetteID: z.string().trim().min(1).optional(),
  noticeTypeCode: z.string().trim().min(1).optional(),
  noticeTypeLongCode: z.string().trim().min(1).optional(),
}).passthrough();
const corrigendaEnvelopeSchema = z.object({
  cftCorrigendaList: z.array(z.object({ notice: corrigendumNoticeSchema }).passthrough()),
}).passthrough();
const euFundingTendersConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  opportunity_type: z.literal("calls-for-tenders"),
  pursuable_statuses: z.array(z.enum(["forthcoming", "open"])).min(1),
  clients: z.array(z.string().regex(/^DG [A-Z][A-Z0-9-]*$/)).min(1),
  language: z.literal("en"),
  sort: z.literal("startDate DESC"),
  page_size: z.number().int().min(1).max(MAX_PAGE_SIZE),
});

type SearchResult = z.infer<typeof searchResultSchema>;
type CorrigendumNotice = z.infer<typeof corrigendumNoticeSchema>;
export type EuFundingTendersConfig = z.infer<typeof euFundingTendersConfigSchema>;

export const euFundingTendersSourceDefinition: SourceDefinition = {
  id: "eu-funding-tenders",
  name: "EU Funding & Tenders Portal",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface EuFundingTendersAdapterOptions {
  config: EuFundingTendersConfig;
  fetch?: typeof fetch;
  pageSize?: number;
}

export function parseEuFundingTendersConfig(raw: string): EuFundingTendersConfig {
  const config = euFundingTendersConfigSchema.parse(parse(raw));
  if (new Set(config.clients).size !== config.clients.length) {
    throw new Error("Duplicate EU Funding & Tenders client");
  }
  if (new Set(config.pursuable_statuses).size !== config.pursuable_statuses.length) {
    throw new Error("Duplicate EU Funding & Tenders pursuable status");
  }
  return config;
}

export function validateEuFundingTendersClientScope(
  config: EuFundingTendersConfig,
  tedClients: readonly string[],
): void {
  const configured = [...config.clients].sort();
  const expected = [...tedClients].sort();
  if (configured.length !== expected.length || configured.some((client, index) => client !== expected[index])) {
    throw new Error("EU Funding & Tenders clients must match the approved TED client scope");
  }
}

function sourceErrorForStatus(status: number): SourceScanError {
  if (status === 429) {
    return new SourceScanError(
      "rate_limited",
      "EU Funding & Tenders rejected the scan because its request limit was reached.",
      true,
    );
  }
  if (status === 400) {
    return new SourceScanError(
      "request_rejected",
      "EU Funding & Tenders rejected the configured opportunity search.",
      false,
    );
  }
  if (status === 401 || status === 403) {
    return new SourceScanError(
      "access_denied",
      "EU Funding & Tenders denied access to its public opportunity search.",
      false,
    );
  }
  return new SourceScanError(
    "source_unavailable",
    `EU Funding & Tenders opportunity search failed with HTTP ${status}.`,
    status >= 500,
  );
}

function jsonPart(value: unknown): Blob {
  return new Blob([JSON.stringify(value)], { type: "application/json" });
}

async function search(
  fetcher: typeof fetch,
  query: Record<string, unknown>,
  pageNumber: number,
  pageSize: number,
  signal: AbortSignal,
) {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("apiKey", PUBLIC_API_KEY);
  url.searchParams.set("text", "***");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("pageNumber", String(pageNumber));
  const body = new FormData();
  body.append("query", jsonPart(query));
  body.append("sort", jsonPart({ order: "DESC", field: "startDate" }));
  body.append("languages", jsonPart(["en"]));
  body.append("displayFields", jsonPart(DISPLAY_FIELDS));

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { Accept: "application/json" },
      body,
      signal,
    });
  } catch {
    throw new SourceScanError(
      "source_unavailable",
      "EU Funding & Tenders opportunity search failed before a response was received.",
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
      "EU Funding & Tenders returned an invalid JSON response.",
      true,
    );
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SourceScanError(
      "invalid_response",
      "EU Funding & Tenders returned an unexpected opportunity search response.",
      true,
    );
  }
  return parsed.data;
}

function normalizedText(value: string | null | undefined): string | undefined {
  const normalized = value
    ?.replaceAll("\r", "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return normalized || undefined;
}

function normalizedSourceDate(value: string | undefined): string | undefined {
  let text = value?.trim();
  if (!text) return undefined;
  text = text.replace(/\s+[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)+$/, "");
  if (/^\d{4}-\d{2}-\d{2}(?:[+-]\d{2}:\d{2})?$/.test(text)) {
    text = `${text.slice(0, 10)}T00:00:00Z`;
  }
  text = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) {
    text = `${text}Z`;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function uniqueTexts(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizedText(value)).filter((value): value is string => !!value))];
}

interface LeadAuthority {
  name: string;
  link?: string;
}

function leadAuthorities(record: SearchResult): LeadAuthority[] {
  const authorities: LeadAuthority[] = [];
  for (const encoded of record.metadata.cftLeadContractingAuthorityCode) {
    let raw: unknown;
    try {
      raw = JSON.parse(encoded);
    } catch {
      continue;
    }
    const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
    for (const value of values) {
      const authority = authoritySchema.safeParse(value);
      if (authority.success && authority.data.isLeadAuthority !== false) {
        authorities.push({ name: authority.data.name, link: authority.data.link });
      }
    }
  }
  return authorities.filter((authority, index) =>
    authorities.findIndex((candidate) => candidate.name === authority.name) === index
  );
}

function clientCode(client: string): string {
  return client.slice("DG ".length);
}

function matchedClient(
  authorities: readonly LeadAuthority[],
  clients: readonly string[],
): { filter: string; authority: LeadAuthority } | undefined {
  for (const client of clients) {
    const codePattern = new RegExp(`(^|[^A-Z0-9])${clientCode(client)}([^A-Z0-9]|$)`, "i");
    const authority = authorities.find(({ name }) => codePattern.test(name));
    if (authority) return { filter: client, authority };
  }
  return undefined;
}

function corrigenda(record: SearchResult): CorrigendumNotice[] {
  const notices: CorrigendumNotice[] = [];
  for (const encoded of record.metadata.cftCorrigendaList) {
    let raw: unknown;
    try {
      raw = JSON.parse(encoded);
    } catch {
      throw new SourceScanError(
        "invalid_record",
        `EU Funding & Tenders record ${record.reference} contains invalid corrigendum metadata.`,
        true,
      );
    }
    const envelope = corrigendaEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new SourceScanError(
        "invalid_record",
        `EU Funding & Tenders record ${record.reference} contains unexpected corrigendum metadata.`,
        true,
      );
    }
    notices.push(...envelope.data.cftCorrigendaList.map(({ notice }) => notice));
  }
  return notices;
}

function latestCorrigendum(
  record: SearchResult,
  notices: readonly CorrigendumNotice[],
): { notice: CorrigendumNotice; publishedAt: string } | undefined {
  const dated = notices.map((notice) => ({
    notice,
    publishedAt: normalizedSourceDate(notice.publicationDate),
  }));
  if (dated.some(({ publishedAt }) => !publishedAt)) {
    throw new SourceScanError(
      "invalid_record",
      `EU Funding & Tenders record ${record.reference} contains an invalid corrigendum date.`,
      true,
    );
  }
  return dated
    .map(({ notice, publishedAt }) => ({ notice, publishedAt: publishedAt as string }))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) ||
      a.notice.noticeID.localeCompare(b.notice.noticeID))
    .at(-1);
}

function procedureValue(record: SearchResult): SourceCandidate["value"] {
  const combined = record.metadata.cftEstimatedTotalProcedureValue[0];
  if (combined) {
    const match = /^(\d+(?:\.\d+)?)\s+([A-Z]{3})$/.exec(combined);
    const amount = match ? Number(match[1]) : Number.NaN;
    if (!match || !Number.isFinite(amount) || amount < 0) {
      throw new SourceScanError(
        "invalid_record",
        `EU Funding & Tenders record ${record.reference} contains an invalid procedure value.`,
        true,
      );
    }
    return { amount, currency: match[2] };
  }

  const rawAmount = record.metadata.cftEstimatedOverallContractAmount[0];
  const currency = record.metadata.cftEstimatedOverallContractCurrency[0]?.toUpperCase();
  if (!rawAmount || !currency) return undefined;
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw new SourceScanError(
      "invalid_record",
      `EU Funding & Tenders record ${record.reference} contains an invalid procedure value.`,
      true,
    );
  }
  return { amount, currency };
}

function publicationDate(record: SearchResult): { value?: string; basis?: string } {
  for (const [values, basis] of [
    [record.metadata.cftPublicationDateEForm, "eforms-publication-date"],
    [record.metadata.startDate, "search-start-date"],
  ] as const) {
    for (const value of values) {
      const normalized = normalizedSourceDate(value);
      if (normalized) return { value: normalized, basis };
    }
  }
  return {};
}

function deadline(record: SearchResult): { value?: string; basis?: string } {
  const candidates: Array<{ value: string; basis: string }> = [];
  for (const [values, basis] of [
    [record.metadata.deadlineDate, "deadline-date"],
    [record.metadata.twoStageDeadlineDate, "two-stage-deadline"],
    [record.metadata.cftEXARegistrationDeadline, "registration-deadline"],
    [record.metadata.closingDate, "closing-date"],
  ] as const) {
    for (const value of values) {
      const normalized = normalizedSourceDate(value);
      if (normalized) candidates.push({ value: normalized, basis });
    }
  }
  return candidates.sort((a, b) => a.value.localeCompare(b.value))[0] ?? {};
}

function noticeKind(reference: string): string {
  if (/-PIN$/i.test(reference)) return "prior-information-notice";
  if (/-CN$/i.test(reference)) return "contract-notice";
  if (/-EXA$/i.test(reference)) return "ex-ante-advertisement";
  return "call-for-tenders";
}

function sourceOpportunityId(record: SearchResult): string {
  const rootReference = record.reference.replace(/-(?:PIN|CN|EXA)$/i, "");
  if (rootReference !== record.reference) return rootReference;
  const callIdentifier = record.metadata.callIdentifier[0];
  return callIdentifier?.replace(/-(?:PIN|CN|EXA)$/i, "") ?? record.reference;
}

function candidateFromResult(
  record: SearchResult,
  authorities: readonly LeadAuthority[],
  client: { filter: string; authority: LeadAuthority },
  status: keyof typeof STATUS_CODES,
  discoveredAt: string,
): SourceCandidate {
  const opportunityName = normalizedText(record.metadata.title[0]) ??
    normalizedText(record.summary) ?? normalizedText(record.content);
  if (!opportunityName) {
    throw new SourceScanError(
      "invalid_record",
      `EU Funding & Tenders record ${record.reference} does not contain a usable title.`,
      true,
    );
  }
  const published = publicationDate(record);
  if (!published.value) {
    throw new SourceScanError(
      "invalid_record",
      `EU Funding & Tenders record ${record.reference} does not contain a usable publication date.`,
      true,
    );
  }
  const correctionNotices = corrigenda(record);
  const latestCorrection = latestCorrigendum(record, correctionNotices);
  const due = deadline(record);
  const value = procedureValue(record);
  const kind = noticeKind(record.reference);
  const canonicalUrl =
    `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/tender-details/${encodeURIComponent(record.reference)}`;

  return {
    sourceId: euFundingTendersSourceDefinition.id,
    sourceEventId: latestCorrection?.notice.noticeID ?? record.reference,
    sourceOpportunityId: sourceOpportunityId(record),
    canonicalUrl,
    originalEventType: latestCorrection?.notice.noticeTypeLongCode ?? kind,
    eventType: latestCorrection ? "modification" : "tender",
    isFormalAmendment: latestCorrection ? true : undefined,
    publishedAt: latestCorrection?.publishedAt ?? published.value,
    discoveredAt,
    opportunityName,
    description: uniqueTexts(record.metadata.description).join("\n") || undefined,
    clientName: client.authority.name,
    value,
    dueDate: due.value,
    sourceStatus: status,
    documents: [{
      id: "eu-funding-tenders-notice",
      title: "EU Funding & Tenders opportunity",
      url: canonicalUrl,
      documentType: kind,
    }],
    sourceData: {
      reference: record.reference,
      identifier: record.metadata.identifier[0],
      cftId: record.metadata.cftId[0],
      callIdentifier: record.metadata.callIdentifier[0],
      opportunityType: "calls-for-tenders",
      typeCode: TENDER_TYPE_CODE,
      statusCode: STATUS_CODES[status],
      status,
      noticeKind: kind,
      clientFilter: client.filter,
      leadContractingAuthorities: authorities,
      partyLegalEntityIds: [...new Set(record.metadata.cftPartyLegalEntityId)].sort(),
      procedureTypeCodes: [...new Set(record.metadata.procedureType)].sort(),
      contractTypeCodes: [...new Set(record.metadata.contractType)].sort(),
      mainCpvCodes: [...new Set(record.metadata.mainCpv)].sort(),
      geographicalZoneCodes: [...new Set([
        ...record.metadata.geographicalZone,
        ...record.metadata.geographicalZones,
      ])].sort(),
      estimatedTotalProcedureValue: record.metadata.cftEstimatedTotalProcedureValue[0],
      estimatedOverallContractAmount: record.metadata.cftEstimatedOverallContractAmount[0],
      estimatedOverallContractCurrency: record.metadata.cftEstimatedOverallContractCurrency[0],
      valueBasis: value ? "estimated-total-procedure-value" : undefined,
      deadlineBasis: due.basis,
      publicationDateBasis: latestCorrection ? "corrigendum-publication-date" : published.basis,
      startDate: record.metadata.startDate[0],
      eformsPublicationDate: record.metadata.cftPublicationDateEForm[0],
      updateDate: record.metadata.updateDate[0],
      plannedDate: record.metadata.cftPlannedDate[0],
      publishedPinReference: record.metadata.cftPublishedPinReference,
      contractNoticeLink: record.metadata.cftContractNoticeLink,
      republished: record.metadata.cftRepublish[0],
      corrigenda: correctionNotices,
      portalReference: latestCorrection ? record.reference : undefined,
    },
  };
}

export function createEuFundingTendersAdapter(
  options: EuFundingTendersAdapterOptions,
): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? options.config.page_size;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`EU Funding & Tenders pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  const configuredStatusCodes = new Map<string, keyof typeof STATUS_CODES>(
    options.config.pursuable_statuses.map((status) => [STATUS_CODES[status], status]),
  );
  const query = {
    bool: {
      must: [
        { terms: { type: [TENDER_TYPE_CODE] } },
        { terms: { status: [...configuredStatusCodes.keys()] } },
      ],
    },
  };

  return {
    definition: euFundingTendersSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      const rawResults: unknown[] = [];
      let pageNumber = 1;
      let expectedTotal: number | undefined;

      while (expectedTotal === undefined || rawResults.length < expectedTotal) {
        const page = await search(fetcher, query, pageNumber, pageSize, context.signal);
        expectedTotal ??= page.totalResults;
        if (
          page.pageNumber !== pageNumber ||
          page.pageSize !== pageSize ||
          page.totalResults !== expectedTotal
        ) {
          throw new SourceScanError(
            "invalid_pagination",
            "EU Funding & Tenders returned inconsistent pagination metadata.",
            true,
          );
        }
        if (page.results.length === 0 && rawResults.length < expectedTotal) {
          throw new SourceScanError(
            "invalid_pagination",
            "EU Funding & Tenders returned an empty page before the opportunity search was complete.",
            true,
          );
        }
        rawResults.push(...page.results);
        pageNumber += 1;
      }

      if (rawResults.length !== expectedTotal) {
        throw new SourceScanError(
          "invalid_pagination",
          `EU Funding & Tenders returned ${rawResults.length} records while reporting ${expectedTotal}.`,
          true,
        );
      }

      const records = new Map<string, SearchResult>();
      rawResults.forEach((rawResult, index) => {
        const parsed = searchResultSchema.safeParse(rawResult);
        if (!parsed.success) {
          throw new SourceScanError(
            "invalid_record",
            `EU Funding & Tenders returned an invalid opportunity at record ${index}.`,
            true,
          );
        }
        const statusCode = parsed.data.metadata.status[0];
        if (!parsed.data.metadata.type.includes(TENDER_TYPE_CODE) || !configuredStatusCodes.has(statusCode)) {
          throw new SourceScanError(
            "unexpected_scope",
            `EU Funding & Tenders returned record ${parsed.data.reference} outside the configured scope.`,
            true,
          );
        }
        if (!records.has(parsed.data.reference)) records.set(parsed.data.reference, parsed.data);
      });

      const discoveredAt = context.now.toISOString();
      const candidates = [...records.values()].flatMap((record) => {
        const authorities = leadAuthorities(record);
        const client = matchedClient(authorities, options.config.clients);
        if (!client) return [];
        const statusCode = record.metadata.status[0];
        const status = configuredStatusCodes.get(statusCode);
        if (!status) return [];
        return [candidateFromResult(record, authorities, client, status, discoveredAt)];
      }).sort((a, b) =>
        (a.publishedAt ?? discoveredAt).localeCompare(b.publishedAt ?? discoveredAt) ||
        (a.sourceEventId ?? "").localeCompare(b.sourceEventId ?? ""),
      );

      return {
        candidates,
        nextCursor: { value: context.now.toISOString() },
      };
    },
  };
}
