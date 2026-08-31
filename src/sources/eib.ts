import { z } from "zod";
import type {
  SourceAdapter,
  SourceCandidate,
  SourceDefinition,
  SourceScanContext,
  SourceScanResult,
} from "./adapter";
import { SourceScanError } from "./adapter";

const LIST_ENDPOINT = "https://www.eib.org/provider-eib/app/list/medias/procurements";
const DETAIL_ENDPOINT = "https://www.eib.org/provider-eib/app/media/procurements";
const TED_SEARCH_ENDPOINT = "https://api.ted.europa.eu/v3/notices/search";
const DETAIL_PAGE_BASE = "https://www.eib.org/en/about/procurement/calls-technical-assistance/all";
const USER_AGENT = "proc-scan/1.0 (+https://github.com/BryanSchuetz/proc-scan)";
const CLIENT_NAME = "EIB";
const PROCURING_ENTITY = "European Investment Bank";
const MAX_PAGE_SIZE = 100;
const DETAIL_BATCH_SIZE = 5;
const TED_FIELDS = [
  "publication-number",
  "notice-identifier",
  "notice-version",
  "publication-date",
  "notice-title",
  "title-proc",
  "description-proc",
  "description-lot",
  "buyer-name",
  "place-of-performance-country-proc",
  "place-of-performance-country-lot",
  "deadline-receipt-tender-date-lot",
  "deadline-receipt-tender-time-lot",
  "estimated-value-proc",
  "estimated-value-cur-proc",
  "estimated-value-lot",
  "estimated-value-cur-lot",
  "notice-type",
  "form-type",
  "classification-cpv",
] as const;

const epochSchema = z.number().int().nonnegative();
const amountSchema = z.union([z.number(), z.string()]).transform((value, context) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    context.addIssue({ code: "custom", message: "Expected a non-negative amount" });
    return z.NEVER;
  }
  return amount;
});
const optionalAmount = amountSchema.nullish().transform((value) => value ?? undefined);
const optionalText = z.string().nullish().transform((value) => value?.trim() || undefined);
const optionalTextArray = z.array(z.string()).nullish().transform((values) =>
  values?.map((value) => value.trim()).filter(Boolean) ?? []
);
const i18nTextSchema = z.record(z.string(), z.string());
const i18nTextListSchema = z.record(z.string(), z.array(z.string()));
const optionalI18nText = i18nTextSchema.nullish().transform((value) => value ?? undefined);
const optionalI18nTextList = i18nTextListSchema.nullish().transform((value) => value ?? undefined);

const listRecordSchema = z.object({
  id: z.string().trim().min(1),
  url: z.string().trim().min(1),
  title: z.string().trim().min(1),
  subType: z.string().trim().min(1),
  endDate: epochSchema.nullable(),
  additionalInformation: z.array(z.string()).min(5),
}).passthrough();
const listResponseSchema = z.object({
  valid: z.literal(true),
  pageNumber: z.number().int().nonnegative(),
  itemPerPage: z.number().int().positive(),
  resultItems: z.number().int().nonnegative(),
  totalItems: z.number().int().nonnegative(),
  data: z.array(z.unknown()),
}).passthrough();
const detailSchema = z.object({
  id: z.string().trim().min(1),
  url: z.string().trim().min(1),
  title: z.string().trim().min(1),
  pageType: z.literal("procurement"),
  pageSubType: z.literal("callTechnicalAssistance"),
  navContents: z.array(z.object({
    code: z.string(),
    content: z.unknown(),
  }).passthrough()),
}).passthrough();
const procurementHistorySchema = z.object({
  date: z.array(epochSchema).min(1),
  reference: z.array(z.string().trim().regex(/^\d+$/)).min(1),
  step: z.array(z.string()),
  oj: z.array(z.string()),
}).passthrough();
const procurementInformationSchema = z.object({
  reference: z.array(z.string().trim().min(1)).min(1),
  closeDate: z.array(epochSchema).min(1),
  type: z.array(z.string().trim().min(1)).min(1),
  publicationDate: z.array(epochSchema).min(1),
  items: z.array(z.object({
    code: z.string(),
    content: z.unknown(),
  }).passthrough()),
}).passthrough();
const tedNoticeSchema = z.object({
  "publication-number": z.string().trim().regex(/^\d+-\d{4}$/),
  "notice-identifier": z.string().trim().min(1),
  "notice-version": z.union([z.number(), z.string()]),
  "publication-date": z.string().trim().min(1),
  "notice-title": optionalI18nText,
  "title-proc": optionalI18nText,
  "description-proc": optionalI18nText,
  "description-lot": optionalI18nTextList,
  "buyer-name": optionalI18nTextList,
  "place-of-performance-country-proc": optionalTextArray,
  "place-of-performance-country-lot": optionalTextArray,
  "deadline-receipt-tender-date-lot": optionalTextArray,
  "deadline-receipt-tender-time-lot": optionalTextArray,
  "estimated-value-proc": optionalAmount,
  "estimated-value-cur-proc": optionalText,
  "estimated-value-lot": z.array(amountSchema).nullish().transform((values) => values ?? []),
  "estimated-value-cur-lot": optionalTextArray,
  "notice-type": z.string().trim().min(1),
  "form-type": z.string().trim().min(1),
  "classification-cpv": optionalTextArray,
}).passthrough();
const tedResponseSchema = z.object({
  notices: z.array(z.unknown()),
  totalNoticeCount: z.union([z.number(), z.string()]).transform((value, context) => {
    const count = Number(value);
    if (!Number.isInteger(count) || count < 0) {
      context.addIssue({ code: "custom", message: "Expected a non-negative notice count" });
      return z.NEVER;
    }
    return count;
  }),
  timedOut: z.boolean(),
});

type ListRecord = z.infer<typeof listRecordSchema>;
type TedNotice = z.infer<typeof tedNoticeSchema>;

interface ProcurementHistory {
  publicationNumber: string;
  step?: string;
  ojIssue?: string;
}

interface EibDetail {
  reference: string;
  closeDate: number;
  publicationDate: number;
  histories: ProcurementHistory[];
}

interface TedValue {
  amount: number;
  currency?: string;
  basis: "estimated-procedure-value" | "sum-estimated-lot-values";
}

export const eibSourceDefinition: SourceDefinition = {
  id: "eib",
  name: "EIB Procurement",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface EibAdapterOptions {
  fetch?: typeof fetch;
  pageSize?: number;
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function sourceErrorForStatus(provider: "EIB" | "TED", status: number): SourceScanError {
  if (status === 429) {
    return new SourceScanError(
      "rate_limited",
      `${provider} rejected the scan because its request limit was reached.`,
      true,
    );
  }
  if (status === 401 || status === 403) {
    return new SourceScanError(
      "access_denied",
      `${provider} denied access to its public procurement data.`,
      false,
    );
  }
  return new SourceScanError(
    "source_unavailable",
    `${provider} procurement request failed with HTTP ${status}.`,
    status >= 500,
  );
}

async function requestJson(
  fetcher: typeof fetch,
  provider: "EIB" | "TED",
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    throw new SourceScanError(
      "source_unavailable",
      `${provider} procurement request failed before a response was received.`,
      true,
    );
  }
  if (!response.ok) throw sourceErrorForStatus(provider, response.status);
  if (!response.headers.get("Content-Type")?.toLocaleLowerCase().includes("application/json")) {
    throw new SourceScanError(
      "invalid_response",
      `${provider} returned a non-JSON procurement response.`,
      true,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new SourceScanError(
      "invalid_response",
      `${provider} returned invalid procurement JSON.`,
      true,
    );
  }
}

function listUrl(pageNumber: number, pageSize: number): string {
  const url = new URL(LIST_ENDPOINT);
  url.searchParams.set("sortColumn", "configuration.contentStart");
  url.searchParams.set("sortDir", "desc");
  url.searchParams.set("pageNumber", String(pageNumber));
  url.searchParams.set("itemPerPage", String(pageSize));
  url.searchParams.set("pageable", "true");
  url.searchParams.set("language", "EN");
  url.searchParams.set("defaultLanguage", "EN");
  url.searchParams.set("procurementStatus", "onGoing");
  url.searchParams.set("_g_procurementInformations_type", "call-technical-assistance");
  url.searchParams.set("or_g_procurementInformations_type", "true");
  return url.toString();
}

function validateListRecord(record: ListRecord): void {
  if (
    record.subType !== "procurements-call-technical-assistance" ||
    record.additionalInformation[0].trim().toLocaleLowerCase() !== "on going" ||
    record.additionalInformation[1].trim().toLocaleLowerCase() !== "ta operations"
  ) {
    throw new SourceScanError(
      "unexpected_scope",
      `EIB returned procurement ${record.id} outside the active TA Operations scope.`,
      true,
    );
  }
}

async function listActiveRecords(
  fetcher: typeof fetch,
  pageSize: number,
  context: SourceScanContext,
): Promise<ListRecord[]> {
  const records: ListRecord[] = [];
  let expectedTotal: number | undefined;
  for (let pageNumber = 0; ; pageNumber += 1) {
    const raw = await requestJson(fetcher, "EIB", listUrl(pageNumber, pageSize), {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: context.signal,
    });
    const response = listResponseSchema.safeParse(raw);
    if (!response.success) {
      throw new SourceScanError(
        "invalid_response",
        "EIB returned an unexpected procurement-list response.",
        true,
      );
    }
    if (
      response.data.pageNumber !== pageNumber ||
      response.data.itemPerPage !== pageSize ||
      response.data.resultItems !== response.data.data.length
    ) {
      throw new SourceScanError(
        "invalid_pagination",
        "EIB returned inconsistent procurement pagination metadata.",
        true,
      );
    }
    expectedTotal ??= response.data.totalItems;
    if (response.data.totalItems !== expectedTotal) {
      throw new SourceScanError(
        "invalid_pagination",
        "EIB changed the procurement result count during pagination.",
        true,
      );
    }
    response.data.data.forEach((rawRecord, index) => {
      const parsed = listRecordSchema.safeParse(rawRecord);
      if (!parsed.success) {
        throw new SourceScanError(
          "invalid_record",
          `EIB returned an invalid procurement at page ${pageNumber}, record ${index}.`,
          true,
        );
      }
      validateListRecord(parsed.data);
      records.push(parsed.data);
    });
    if (records.length >= expectedTotal) break;
    if (response.data.data.length === 0) {
      throw new SourceScanError(
        "invalid_pagination",
        `EIB stopped pagination after ${records.length} of ${expectedTotal} procurements.`,
        true,
      );
    }
  }
  if (records.length !== expectedTotal) {
    throw new SourceScanError(
      "invalid_pagination",
      `EIB returned ${records.length} procurements while reporting ${expectedTotal}.`,
      true,
    );
  }
  if (new Set(records.map(({ id }) => id)).size !== records.length) {
    throw new SourceScanError("invalid_response", "EIB returned duplicate procurement IDs.", true);
  }
  const currentDate = normalizedEibDate(context.now.getTime());
  return records.filter(({ endDate }) =>
    endDate !== null && normalizedEibDate(endDate) >= currentDate
  );
}

function luxembourgCalendarParts(value: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Luxembourg",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(value));
  const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: numberPart("year"), month: numberPart("month"), day: numberPart("day") };
}

function normalizedEibDate(value: number): string {
  const { year, month, day } = luxembourgCalendarParts(value);
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function publicationNumber(reference: string, date: number): string {
  return `${reference}-${luxembourgCalendarParts(date).year}`;
}

function parseDetail(raw: unknown, record: ListRecord): EibDetail {
  const detail = detailSchema.safeParse(raw);
  if (!detail.success) {
    throw new SourceScanError(
      "invalid_record",
      `EIB returned invalid detail for procurement ${record.id}.`,
      true,
    );
  }
  if (
    detail.data.id !== record.id ||
    detail.data.url !== record.url ||
    normalizedText(detail.data.title) !== normalizedText(record.title)
  ) {
    throw new SourceScanError(
      "invalid_record",
      `EIB returned mismatched detail for procurement ${record.id}.`,
      true,
    );
  }
  const informationBlock = detail.data.navContents.find(({ code }) => code === "procurementInformations");
  const information = procurementInformationSchema.safeParse(informationBlock?.content);
  if (!information.success || !information.data.type.includes("call-technical-assistance")) {
    throw new SourceScanError(
      "unexpected_scope",
      `EIB procurement ${record.id} does not contain TA Operations detail.`,
      true,
    );
  }
  const closeDate = information.data.closeDate[0];
  if (record.endDate !== closeDate) {
    throw new SourceScanError(
      "invalid_record",
      `EIB procurement ${record.id} contains inconsistent closing dates.`,
      true,
    );
  }
  const histories = information.data.items
    .filter(({ code }) => code === "procurementHistory")
    .map((item, index) => {
      const history = procurementHistorySchema.safeParse(item.content);
      if (!history.success) {
        throw new SourceScanError(
          "invalid_record",
          `EIB procurement ${record.id} contains invalid history ${index}.`,
          true,
        );
      }
      return {
        publicationNumber: publicationNumber(history.data.reference[0], history.data.date[0]),
        step: normalizedText(history.data.step[0]),
        ojIssue: normalizedText(history.data.oj[0]),
      };
    });
  return {
    reference: information.data.reference[0],
    closeDate,
    publicationDate: information.data.publicationDate[0],
    histories,
  };
}

async function fetchDetails(
  fetcher: typeof fetch,
  records: readonly ListRecord[],
  context: SourceScanContext,
): Promise<EibDetail[]> {
  const details: EibDetail[] = [];
  for (let index = 0; index < records.length; index += DETAIL_BATCH_SIZE) {
    const batch = records.slice(index, index + DETAIL_BATCH_SIZE);
    details.push(...await Promise.all(batch.map(async (record) => {
      const url = new URL(`${DETAIL_ENDPOINT}/${encodeURIComponent(record.id)}`);
      url.searchParams.set("language", "EN");
      url.searchParams.set("defaultLanguage", "EN");
      const raw = await requestJson(fetcher, "EIB", url.toString(), {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: context.signal,
      });
      return parseDetail(raw, record);
    })));
  }
  return details;
}

function normalizedTedDate(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) return undefined;
  return date.toISOString();
}

function deadlineInstant(dateValue: string, timeValue?: string): string | undefined {
  const date = /^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:\d{2})?$/.exec(dateValue);
  if (!date) return undefined;
  if (!timeValue) return normalizedTedDate(dateValue);
  const time = /^(\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})?$/.exec(timeValue);
  if (!time) return undefined;
  const instant = new Date(`${date[1]}T${time[1]}${time[2] ?? date[2] ?? "Z"}`);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

function earliestDeadline(notice: TedNotice): string | undefined {
  return notice["deadline-receipt-tender-date-lot"]
    .map((date, index) => deadlineInstant(date, notice["deadline-receipt-tender-time-lot"][index]))
    .filter((value): value is string => value !== undefined)
    .sort()[0];
}

function preferredText(values: Record<string, string> | undefined): string | undefined {
  if (!values) return undefined;
  return normalizedText(values.eng) ?? Object.keys(values).sort()
    .map((language) => normalizedText(values[language]))
    .find((value): value is string => value !== undefined);
}

function preferredTexts(values: Record<string, string[]> | undefined): string[] {
  if (!values) return [];
  const language = values.eng ? "eng" : Object.keys(values).sort()[0];
  return language
    ? values[language].map((value) => normalizedText(value)).filter((value): value is string => !!value)
    : [];
}

function tedValue(notice: TedNotice): TedValue | undefined {
  const procedureValue = notice["estimated-value-proc"];
  if (procedureValue !== undefined) {
    return {
      amount: procedureValue,
      currency: notice["estimated-value-cur-proc"]?.toUpperCase(),
      basis: "estimated-procedure-value",
    };
  }
  const lotValues = notice["estimated-value-lot"];
  const currencies = notice["estimated-value-cur-lot"].map((currency) => currency.toUpperCase());
  if (lotValues.length === 0 || currencies.length === 0 || new Set(currencies).size !== 1) return undefined;
  return {
    amount: lotValues.reduce((total, value) => total + value, 0),
    currency: currencies[0],
    basis: "sum-estimated-lot-values",
  };
}

async function fetchTedNotices(
  fetcher: typeof fetch,
  publicationNumbers: readonly string[],
  context: SourceScanContext,
): Promise<Map<string, TedNotice>> {
  if (publicationNumbers.length === 0) return new Map();
  const query = `(${publicationNumbers.map((number) => `publication-number = ${number}`).join(" OR ")})`;
  const raw = await requestJson(fetcher, "TED", TED_SEARCH_ENDPOINT, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      fields: TED_FIELDS,
      limit: Math.min(250, publicationNumbers.length),
      scope: "ALL",
      checkQuerySyntax: false,
      paginationMode: "PAGE_NUMBER",
      page: 1,
      onlyLatestVersions: true,
    }),
    signal: context.signal,
  });
  const response = tedResponseSchema.safeParse(raw);
  if (!response.success || response.data.timedOut) {
    throw new SourceScanError(
      response.success ? "source_timeout" : "invalid_response",
      response.success
        ? "TED timed out while enriching EIB procurements."
        : "TED returned an unexpected EIB-enrichment response.",
      true,
    );
  }
  if (response.data.notices.length !== response.data.totalNoticeCount) {
    throw new SourceScanError(
      "invalid_pagination",
      "TED returned incomplete EIB-enrichment results.",
      true,
    );
  }
  const requested = new Set(publicationNumbers);
  const notices = new Map<string, TedNotice>();
  response.data.notices.forEach((rawNotice, index) => {
    const notice = tedNoticeSchema.safeParse(rawNotice);
    if (!notice.success) {
      throw new SourceScanError(
        "invalid_record",
        `TED returned an invalid EIB-enrichment notice at record ${index}.`,
        true,
      );
    }
    const number = notice.data["publication-number"];
    if (!requested.has(number) || notices.has(number)) {
      throw new SourceScanError(
        "unexpected_scope",
        `TED returned an unexpected EIB-enrichment notice ${number}.`,
        true,
      );
    }
    notices.set(number, notice.data);
  });
  return notices;
}

function noticeDate(notice: TedNotice): number {
  return Date.parse(normalizedTedDate(notice["publication-date"]) ?? "");
}

function candidateFromRecord(
  record: ListRecord,
  detail: EibDetail,
  tedNotices: ReadonlyMap<string, TedNotice>,
  discoveredAt: string,
): SourceCandidate {
  const matchingNotices = detail.histories
    .map(({ publicationNumber }) => tedNotices.get(publicationNumber))
    .filter((notice): notice is TedNotice => notice !== undefined)
    .sort((a, b) => noticeDate(b) - noticeDate(a));
  const newestNotice = matchingNotices[0];
  const valueNotice = matchingNotices.find((notice) => tedValue(notice) !== undefined);
  const normalizedValue = valueNotice ? tedValue(valueNotice) : undefined;
  const descriptionNotice = matchingNotices.find((notice) =>
    preferredText(notice["description-proc"]) || preferredTexts(notice["description-lot"]).length > 0
  );
  const description = descriptionNotice
    ? [
        preferredText(descriptionNotice["description-proc"]),
        ...preferredTexts(descriptionNotice["description-lot"]),
      ].filter((value): value is string => !!value).join("\n") || undefined
    : undefined;
  const deadlineNotice = matchingNotices.find((notice) => earliestDeadline(notice) !== undefined);
  const dueDate = deadlineNotice ? earliestDeadline(deadlineNotice) : normalizedEibDate(detail.closeDate);
  const publicationNumberValue = newestNotice?.["publication-number"];
  const canonicalUrl = `${DETAIL_PAGE_BASE}/${encodeURIComponent(record.url)}`;
  const countries = newestNotice
    ? [...new Set([
        ...newestNotice["place-of-performance-country-proc"],
        ...newestNotice["place-of-performance-country-lot"],
      ])]
    : [];

  return {
    sourceId: eibSourceDefinition.id,
    sourceEventId: record.id,
    sourceOpportunityId: detail.reference,
    canonicalUrl,
    originalEventType: "TA operations",
    eventType: "tender",
    publishedAt: newestNotice
      ? normalizedTedDate(newestNotice["publication-date"]) ?? normalizedEibDate(detail.publicationDate)
      : normalizedEibDate(detail.publicationDate),
    discoveredAt,
    opportunityName: record.title,
    description,
    clientName: CLIENT_NAME,
    procuringEntityName: PROCURING_ENTITY,
    value: normalizedValue
      ? { amount: normalizedValue.amount, currency: normalizedValue.currency }
      : undefined,
    dueDate,
    placeOfPerformance: countries.length > 0
      ? { description: countries.join(", "), countryCode: countries.length === 1 ? countries[0] : undefined }
      : undefined,
    sourceStatus: "on-going",
    documents: [
      { id: "eib-procurement", title: "EIB procurement", url: canonicalUrl, documentType: "TA operations" },
      ...(publicationNumberValue ? [{
        id: "ted-notice",
        title: "TED notice",
        url: `https://ted.europa.eu/en/notice/-/detail/${encodeURIComponent(publicationNumberValue)}`,
        documentType: newestNotice?.["notice-type"],
      }] : []),
    ],
    sourceData: {
      eibRecordId: record.id,
      eibSlug: record.url,
      eibReference: detail.reference,
      eibStatus: record.additionalInformation[0].trim(),
      eibType: record.additionalInformation[1].trim(),
      eibCloseDate: normalizedEibDate(detail.closeDate),
      procurementHistory: detail.histories,
      tedPublicationNumber: publicationNumberValue,
      tedValuePublicationNumber: valueNotice?.["publication-number"],
      valueBasis: normalizedValue?.basis,
      deadlineBasis: deadlineNotice ? "ted-tender-deadline" : "eib-close-date",
      classificationCpv: newestNotice
        ? [...new Set(newestNotice["classification-cpv"])].sort()
        : [],
    },
  };
}

export function createEibAdapter(options: EibAdapterOptions = {}): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? MAX_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`EIB pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  }

  return {
    definition: eibSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      const records = await listActiveRecords(fetcher, pageSize, context);
      const details = await fetchDetails(fetcher, records, context);
      const publicationNumbers = [...new Set(details.flatMap(({ histories }) =>
        histories.map(({ publicationNumber }) => publicationNumber)
      ))].sort();
      const tedNotices = await fetchTedNotices(fetcher, publicationNumbers, context);
      const discoveredAt = context.now.toISOString();
      const candidates = records.map((record, index) =>
        candidateFromRecord(record, details[index], tedNotices, discoveredAt)
      ).filter((candidate) => {
        if (candidate.sourceData.deadlineBasis === "ted-tender-deadline") {
          return !!candidate.dueDate && Date.parse(candidate.dueDate) >= context.now.getTime();
        }
        return !!candidate.dueDate && candidate.dueDate >= normalizedEibDate(context.now.getTime());
      }).sort((a, b) =>
        (a.publishedAt ?? discoveredAt).localeCompare(b.publishedAt ?? discoveredAt) ||
        (a.sourceEventId ?? "").localeCompare(b.sourceEventId ?? "")
      );
      return { candidates, nextCursor: { value: discoveredAt } };
    },
  };
}
