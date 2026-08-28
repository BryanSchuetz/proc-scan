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

const SEARCH_ENDPOINT = "https://api.ted.europa.eu/v3/notices/search";
const MAX_PAGE_SIZE = 250;
const EXTERNAL_AID_FUNDING = "external-aid-program";
const SEARCH_FIELDS = [
  "publication-number",
  "notice-identifier",
  "notice-version",
  "procedure-identifier",
  "publication-date",
  "notice-title",
  "title-proc",
  "title-lot",
  "description-proc",
  "description-lot",
  "buyer-name",
  "buyer-country",
  "place-of-performance",
  "place-of-performance-country-proc",
  "place-of-performance-country-lot",
  "deadline-receipt-tender-date-lot",
  "deadline-receipt-tender-time-lot",
  "deadline-receipt-request-date-lot",
  "deadline-receipt-request-time-lot",
  "estimated-value-proc",
  "estimated-value-cur-proc",
  "estimated-value-lot",
  "estimated-value-cur-lot",
  "notice-type",
  "form-type",
  "classification-cpv",
  "funding",
  "change-notice-version-identifier",
  "change-description",
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

const amountSchema = z.union([z.number(), z.string()]).transform((value, context) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    context.addIssue({ code: "custom", message: "Expected a non-negative amount" });
    return z.NEVER;
  }
  return parsed;
});
const optionalAmount = amountSchema.nullish().transform((value) => value ?? undefined);
const optionalText = z.string().nullish().transform((value) => value?.trim() || undefined);
const optionalTextArray = z.array(z.string()).nullish().transform((values) =>
  values?.map((value) => value.trim()).filter(Boolean) ?? []
);
const i18nTextSchema = z.record(z.string(), z.string());
const i18nTextListSchema = z.record(z.string(), z.array(z.string()));
const linksSchema = z.object({
  xml: z.record(z.string(), z.string()).optional(),
}).passthrough();
const noticeSchema = z.object({
  "publication-number": z.string().trim().regex(/^\d+-\d{4}$/),
  "notice-identifier": z.string().trim().min(1),
  "notice-version": integerSchema(1),
  "procedure-identifier": optionalText,
  "publication-date": z.string().trim().min(1),
  "notice-title": i18nTextSchema.optional(),
  "title-proc": i18nTextSchema.optional(),
  "title-lot": i18nTextListSchema.optional(),
  "description-proc": i18nTextSchema.optional(),
  "description-lot": i18nTextListSchema.optional(),
  "buyer-name": i18nTextListSchema.optional(),
  "buyer-country": optionalTextArray,
  "place-of-performance": optionalTextArray,
  "place-of-performance-country-proc": optionalTextArray,
  "place-of-performance-country-lot": optionalTextArray,
  "deadline-receipt-tender-date-lot": optionalTextArray,
  "deadline-receipt-tender-time-lot": optionalTextArray,
  "deadline-receipt-request-date-lot": optionalTextArray,
  "deadline-receipt-request-time-lot": optionalTextArray,
  "estimated-value-proc": optionalAmount,
  "estimated-value-cur-proc": optionalText,
  "estimated-value-lot": z.array(amountSchema).nullish().transform((values) => values ?? []),
  "estimated-value-cur-lot": optionalTextArray,
  "notice-type": z.string().trim().min(1),
  "form-type": z.string().trim().min(1),
  "classification-cpv": optionalTextArray,
  funding: z.array(z.string().trim().min(1)),
  "change-notice-version-identifier": optionalText,
  "change-description": i18nTextListSchema.optional(),
  links: linksSchema.optional(),
}).passthrough();
const responseSchema = z.object({
  notices: z.array(z.unknown()),
  totalNoticeCount: integerSchema(0),
  iterationNextToken: z.string().min(1).optional(),
  timedOut: z.boolean(),
});
const tedConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  funding: z.literal(EXTERNAL_AID_FUNDING),
  clients: z.array(z.string().regex(/^DG [A-Z][A-Z0-9-]*$/)).min(1),
  sort: z.literal("publication-number DESC"),
  scope: z.enum(["LATEST", "ACTIVE", "ALL"]),
  only_latest_versions: z.boolean(),
  pursuable_form_types: z.array(z.enum(["planning", "competition"])).min(1),
  page_size: z.number().int().min(1).max(MAX_PAGE_SIZE),
});

type TedNotice = z.infer<typeof noticeSchema>;
export type TedConfig = z.infer<typeof tedConfigSchema>;

export const tedSourceDefinition: SourceDefinition = {
  id: "ted",
  name: "TED",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface TedAdapterOptions {
  config: TedConfig;
  fetch?: typeof fetch;
  pageSize?: number;
}

export function parseTedConfig(raw: string): TedConfig {
  const config = tedConfigSchema.parse(parse(raw));
  if (new Set(config.clients).size !== config.clients.length) {
    throw new Error("Duplicate TED client");
  }
  if (new Set(config.pursuable_form_types).size !== config.pursuable_form_types.length) {
    throw new Error("Duplicate TED pursuable form type");
  }
  return config;
}

function clientCode(client: string): string {
  return client.slice("DG ".length);
}

function expertQuery(config: TedConfig): string {
  const clients = config.clients.map(clientCode).join(" ");
  return `(funding IN (${config.funding})) AND (buyer-name IN (${clients})) SORT BY ${config.sort}`;
}

function sourceErrorForStatus(status: number): SourceScanError {
  if (status === 429) {
    return new SourceScanError(
      "rate_limited",
      "TED rejected the scan because its fair-use request limit was reached.",
      true,
    );
  }
  if (status === 400) {
    return new SourceScanError(
      "request_rejected",
      "TED rejected the configured expert search query.",
      false,
    );
  }
  if (status === 401 || status === 403) {
    return new SourceScanError(
      "access_denied",
      "TED denied access to its public notice search.",
      false,
    );
  }
  return new SourceScanError(
    "source_unavailable",
    `TED notice search failed with HTTP ${status}.`,
    status >= 500,
  );
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
      "TED notice search failed before a response was received.",
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
      "TED returned an invalid JSON response.",
      true,
    );
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SourceScanError(
      "invalid_response",
      "TED returned an unexpected notice search response.",
      true,
    );
  }
  if (parsed.data.timedOut) {
    throw new SourceScanError(
      "source_timeout",
      "TED timed out while executing the notice search.",
      true,
    );
  }
  return parsed.data;
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function preferredText(values: Record<string, string> | undefined): string | undefined {
  if (!values) return undefined;
  return normalizedText(values.eng) ?? Object.keys(values).sort()
    .map((language) => normalizedText(values[language]))
    .find(Boolean);
}

function preferredTexts(values: Record<string, string[]> | undefined): string[] {
  if (!values) return [];
  const language = values.eng ? "eng" : Object.keys(values).sort()[0];
  return language
    ? [...new Set(values[language].map((value) => normalizedText(value)).filter((value): value is string => !!value))]
    : [];
}

function allTexts(values: Record<string, string[]> | undefined): string[] {
  if (!values) return [];
  return [...new Set(Object.keys(values).sort().flatMap((language) =>
    values[language].map((value) => normalizedText(value)).filter((value): value is string => !!value)
  ))];
}

function matchedClient(notice: TedNotice, clients: readonly string[]): string | undefined {
  const buyerNames = allTexts(notice["buyer-name"]);
  return clients.find((client) => {
    const code = clientCode(client);
    const codePattern = new RegExp(`(^|[^A-Z0-9])${code}([^A-Z0-9]|$)`, "i");
    return buyerNames.some((buyerName) => codePattern.test(buyerName));
  });
}

function normalizedTedDate(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) return undefined;
  return date.toISOString();
}

function deadlineInstant(dateValue: string, timeValue?: string): string | undefined {
  const dateMatch = /^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:\d{2})?$/.exec(dateValue);
  if (!dateMatch) return undefined;
  if (!timeValue) return normalizedTedDate(dateValue);
  const timeMatch = /^(\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})?$/.exec(timeValue);
  if (!timeMatch) return undefined;
  const offset = timeMatch[2] ?? dateMatch[2] ?? "Z";
  const instant = new Date(`${dateMatch[1]}T${timeMatch[1]}${offset}`);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

function earliestDeadline(notice: TedNotice): { value?: string; basis?: string } {
  const candidates: Array<{ value: string; basis: string }> = [];
  for (const [dates, times, basis] of [
    [notice["deadline-receipt-tender-date-lot"], notice["deadline-receipt-tender-time-lot"], "tender-deadline"],
    [notice["deadline-receipt-request-date-lot"], notice["deadline-receipt-request-time-lot"], "request-deadline"],
  ] as const) {
    dates.forEach((date, index) => {
      const value = deadlineInstant(date, times[index]);
      if (value) candidates.push({ value, basis });
    });
  }
  candidates.sort((a, b) => a.value.localeCompare(b.value));
  return candidates[0] ?? {};
}

function noticeVersionIdentifier(notice: TedNotice): string {
  return `${notice["notice-identifier"]}-${String(notice["notice-version"]).padStart(2, "0")}`;
}

function noticeIdentifierFromVersion(value: string | undefined): string | undefined {
  return value?.replace(/-\d{2}$/, "");
}

function rootNoticeIdentifier(
  notice: TedNotice,
  noticesByIdentifier: ReadonlyMap<string, TedNotice>,
): string {
  let identifier = notice["notice-identifier"];
  let current: TedNotice | undefined = notice;
  const visited = new Set<string>();
  while (current?.["change-notice-version-identifier"] && !visited.has(identifier)) {
    visited.add(identifier);
    const previousIdentifier = noticeIdentifierFromVersion(current["change-notice-version-identifier"]);
    if (!previousIdentifier) break;
    identifier = previousIdentifier;
    current = noticesByIdentifier.get(previousIdentifier);
  }
  return identifier;
}

function placeOfPerformance(notice: TedNotice): SourceCandidate["placeOfPerformance"] {
  const explicitCountries = [
    ...notice["place-of-performance-country-proc"],
    ...notice["place-of-performance-country-lot"],
  ];
  const fallbackCountries = notice["place-of-performance"]
    .filter((value) => /^[A-Z]{3}$/.test(value) && value.toLocaleLowerCase() !== "anyw");
  const countries = [...new Set(explicitCountries.length > 0 ? explicitCountries : fallbackCountries)];
  if (countries.length === 0) return undefined;
  return {
    description: countries.join(", "),
    countryCode: countries.length === 1 ? countries[0] : undefined,
  };
}

function xmlUrl(notice: TedNotice): string | undefined {
  const links = notice.links?.xml;
  if (!links) return undefined;
  return links.MUL ?? links.ENG ?? Object.keys(links).sort().map((language) => links[language]).find(Boolean);
}

function candidateFromNotice(
  notice: TedNotice,
  noticesByIdentifier: ReadonlyMap<string, TedNotice>,
  discoveredAt: string,
  clientFilter: string,
): SourceCandidate {
  const publicationNumber = notice["publication-number"];
  const canonicalUrl = `https://ted.europa.eu/en/notice/-/detail/${encodeURIComponent(publicationNumber)}`;
  const opportunityName = preferredText({
    ...(notice["notice-title"]?.eng ? { eng: notice["notice-title"].eng } : {}),
    ...notice["title-proc"],
  }) ?? preferredTexts(notice["title-lot"])[0] ?? preferredText(notice["notice-title"]);
  if (!opportunityName) {
    throw new SourceScanError(
      "invalid_record",
      `TED notice ${publicationNumber} does not contain a usable title.`,
      true,
    );
  }
  const descriptionParts = [
    preferredText(notice["description-proc"]),
    ...preferredTexts(notice["title-lot"]),
    ...preferredTexts(notice["description-lot"]),
  ].filter((value): value is string => !!value);
  const description = [...new Set(descriptionParts)].join("\n") || undefined;
  const buyerNames = preferredTexts(notice["buyer-name"]);
  const publishedAt = normalizedTedDate(notice["publication-date"]);
  if (!publishedAt) {
    throw new SourceScanError(
      "invalid_record",
      `TED notice ${publicationNumber} has an invalid publication date.`,
      true,
    );
  }
  const procedureValue = notice["estimated-value-proc"];
  const procedureCurrency = notice["estimated-value-cur-proc"]?.toUpperCase();
  const deadline = earliestDeadline(notice);
  const changeNoticeVersionIdentifier = notice["change-notice-version-identifier"];
  const sourceEventId = noticeVersionIdentifier(notice);
  const sourceOpportunityId = notice["procedure-identifier"] ??
    rootNoticeIdentifier(notice, noticesByIdentifier);

  return {
    sourceId: tedSourceDefinition.id,
    sourceEventId,
    sourceOpportunityId,
    canonicalUrl,
    originalEventType: notice["notice-type"],
    eventType: changeNoticeVersionIdentifier ? "modification" : "tender",
    isFormalAmendment: changeNoticeVersionIdentifier ? true : undefined,
    publishedAt,
    discoveredAt,
    opportunityName,
    description,
    clientName: buyerNames[0],
    value: procedureValue === undefined
      ? undefined
      : { amount: procedureValue, currency: procedureCurrency },
    dueDate: deadline.value,
    placeOfPerformance: placeOfPerformance(notice),
    sourceStatus: "active",
    documents: [{
      id: "ted-notice",
      title: "TED notice",
      url: canonicalUrl,
      documentType: notice["notice-type"],
    }],
    sourceData: {
      publicationNumber,
      noticeIdentifier: notice["notice-identifier"],
      noticeVersion: notice["notice-version"],
      noticeVersionIdentifier: sourceEventId,
      procedureIdentifier: notice["procedure-identifier"],
      formType: notice["form-type"],
      noticeType: notice["notice-type"],
      funding: [...new Set(notice.funding)].sort(),
      classificationCpv: [...new Set(notice["classification-cpv"])].sort(),
      clientFilter,
      buyerNames,
      buyerCountries: [...new Set(notice["buyer-country"])].sort(),
      placeOfPerformance: [...new Set(notice["place-of-performance"])].sort(),
      procedureEstimatedValue: procedureValue,
      procedureEstimatedValueCurrency: procedureCurrency,
      lotEstimatedValues: notice["estimated-value-lot"],
      lotEstimatedValueCurrencies: notice["estimated-value-cur-lot"],
      valueBasis: procedureValue === undefined ? undefined : "estimated-procedure-value",
      deadlineBasis: deadline.basis,
      changeNoticeVersionIdentifier,
      changeDescription: preferredTexts(notice["change-description"]),
      xmlUrl: xmlUrl(notice),
    },
  };
}

export function createTedAdapter(options: TedAdapterOptions): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? options.config.page_size;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`TED pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  const pursuableFormTypes = new Set(options.config.pursuable_form_types);

  return {
    definition: tedSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      const rawNotices: unknown[] = [];
      const seenTokens = new Set<string>();
      let iterationNextToken: string | undefined;
      let expectedNoticeCount: number | undefined;

      while (true) {
        const response = await search(fetcher, {
          query: expertQuery(options.config),
          fields: SEARCH_FIELDS,
          limit: pageSize,
          scope: options.config.scope,
          checkQuerySyntax: false,
          paginationMode: "ITERATION",
          onlyLatestVersions: options.config.only_latest_versions,
          ...(iterationNextToken ? { iterationNextToken } : {}),
        }, context.signal);
        expectedNoticeCount ??= response.totalNoticeCount;
        rawNotices.push(...response.notices);
        if (response.notices.length === 0 || !response.iterationNextToken) break;
        if (seenTokens.has(response.iterationNextToken)) {
          throw new SourceScanError(
            "invalid_pagination",
            "TED returned a repeated iteration token.",
            true,
          );
        }
        seenTokens.add(response.iterationNextToken);
        iterationNextToken = response.iterationNextToken;
      }

      if (rawNotices.length !== expectedNoticeCount) {
        throw new SourceScanError(
          "invalid_pagination",
          `TED returned ${rawNotices.length} notices while reporting ${expectedNoticeCount}.`,
          true,
        );
      }

      const notices = rawNotices.map((rawNotice, index) => {
        const parsed = noticeSchema.safeParse(rawNotice);
        if (!parsed.success) {
          throw new SourceScanError(
            "invalid_record",
            `TED returned an invalid notice at record ${index}.`,
            true,
          );
        }
        if (!parsed.data.funding.includes(EXTERNAL_AID_FUNDING)) {
          throw new SourceScanError(
            "unexpected_scope",
            `TED returned notice ${parsed.data["publication-number"]} outside the external-aid scope.`,
            true,
          );
        }
        return parsed.data;
      });
      const noticesByIdentifier = new Map(
        notices.map((notice) => [notice["notice-identifier"], notice] as const),
      );
      const discoveredAt = context.now.toISOString();
      const candidates = notices
        .filter((notice) => pursuableFormTypes.has(notice["form-type"] as "planning" | "competition"))
        .map((notice) => {
          const client = matchedClient(notice, options.config.clients);
          return client ? candidateFromNotice(notice, noticesByIdentifier, discoveredAt, client) : undefined;
        })
        .filter((candidate): candidate is SourceCandidate => candidate !== undefined)
        .sort((a, b) =>
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
