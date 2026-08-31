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

const BASE_URL = "https://www2.dgmarket.com";
const SEARCH_PATH = "/NoticeList";
const USER_AGENT = "proc-scan/1.0 (+https://github.com/BryanSchuetz/proc-scan)";
const EU_MEMBER_STATE_CODES = [
  "at", "be", "bg", "hr", "cy", "cz", "dk", "ee", "fi", "fr", "de", "gr", "hu", "ie",
  "it", "lv", "lt", "lu", "mt", "nl", "pl", "pt", "ro", "sk", "si", "es", "se",
] as const;

const countrySchema = z.object({
  code: z.string().regex(/^[a-z]{2}$/),
  name: z.string().trim().min(1),
});
const dgMarketConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  page_size: z.literal(25),
  request_delay_ms: z.number().int().min(0).max(5_000),
  max_pages_per_search: z.number().int().min(1).max(500),
  overlap_days: z.number().int().min(1).max(14),
  initial_lookback_days: z.number().int().min(1).max(365),
  notice_category: z.object({
    code: z.literal("2"),
    name: z.literal("Consultancy"),
  }),
  pursuable_notice_types: z.array(z.string().trim().min(1)).min(1),
  mca: z.object({
    funding_agency_id: z.string().regex(/^\d+$/),
    funding_agency_name: z.string().trim().min(1),
  }),
  eu_member_states: z.object({
    buyer_type: z.literal("GOVERNMENT"),
    countries: z.array(countrySchema).min(1),
  }),
});

export type DgMarketConfig = z.infer<typeof dgMarketConfigSchema>;
type DgMarketCountry = DgMarketConfig["eu_member_states"]["countries"][number];

interface DgMarketRecord {
  noticeId: string;
  canonicalUrl: string;
  title: string;
  buyer: string;
  changedAt: string;
  countries?: string;
  deadline?: string;
  noticeType: string;
  originalLanguage?: string;
  estimatedValue?: string;
}

interface ParsedListPage {
  total: number;
  pageSize: number;
  currentPage?: number;
  bodyText: string;
  records: DgMarketRecord[];
}

interface SearchScope {
  cohort: "mca" | "eu-member-state-government";
  buyerContactCountry?: DgMarketCountry;
}

interface DateWindow {
  startDate: string;
  endDate: string;
}

export const dgMarketSourceDefinition: SourceDefinition = {
  id: "dg-market",
  name: "dgMarket",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface DgMarketAdapterOptions {
  config: DgMarketConfig;
  fetch?: typeof fetch;
  pageSize?: number;
  requestDelayMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function parseDgMarketConfig(raw: string): DgMarketConfig {
  const config = dgMarketConfigSchema.parse(parse(raw));
  const codes = config.eu_member_states.countries.map(({ code }) => code);
  if (new Set(codes).size !== codes.length) throw new Error("Duplicate dgMarket EU member-state code");
  const configuredCodes = [...codes].sort();
  const expectedCodes = [...EU_MEMBER_STATE_CODES].sort();
  if (
    configuredCodes.length !== expectedCodes.length ||
    configuredCodes.some((code, index) => code !== expectedCodes[index])
  ) {
    throw new Error("dgMarket EU buyer scope must contain exactly the 27 EU member states");
  }
  if (new Set(config.pursuable_notice_types.map((value) => value.toLocaleLowerCase())).size !==
    config.pursuable_notice_types.length) {
    throw new Error("Duplicate dgMarket pursuable notice type");
  }
  return config;
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function appendText(
  parts: string[] | undefined,
  text: { readonly text: string; readonly lastInTextNode: boolean },
): void {
  if (!parts) return;
  parts.push(text.text);
  if (text.lastInTextNode) parts.push(" ");
}

function parseCount(value: string | undefined, label: string): number {
  const parsed = Number(value?.replaceAll(",", ""));
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new SourceScanError(
      "invalid_response",
      `dgMarket returned an invalid ${label}.`,
      true,
    );
  }
  return parsed;
}

function fieldFromRow(row: string, label: string): string | undefined {
  const labels = [
    "Buyer",
    "Create/Change Date",
    "Countries",
    "Deadline",
    "Type",
    "Original Language",
    "Estimated Value",
  ];
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const otherLabels = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const match = new RegExp(
    `${escapedLabel}\\s*:\\s*(.*?)(?=\\s*(?:${otherLabels})\\s*:|\\s*View Details|$)`,
    "i",
  ).exec(row);
  return normalizedText(match?.[1]);
}

function normalizedSourceDate(value: string, recordId: string): string {
  const text = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T00:00:00Z`
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? `${text.replace(" ", "T")}Z`
      : text;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new SourceScanError(
      "invalid_record",
      `dgMarket record ${recordId} contains an invalid date.`,
      true,
    );
  }
  return date.toISOString();
}

function valueFromRecord(record: DgMarketRecord): SourceCandidate["value"] {
  const text = record.estimatedValue?.replace(/\u00a0/g, " ").trim();
  if (!text) return undefined;
  const match = /^([€$£])?\s*([\d,]+(?:\.\d+)?)\s*([A-Z]{3})?$/.exec(text);
  const symbolCurrency: Record<string, string> = { "€": "EUR", "$": "USD", "£": "GBP" };
  const amount = match ? Number(match[2].replaceAll(",", "")) : Number.NaN;
  const currency = match?.[3] ?? (match?.[1] ? symbolCurrency[match[1]] : undefined);
  if (!match || !Number.isFinite(amount) || amount < 0 || (currency && !/^[A-Z]{3}$/.test(currency))) {
    throw new SourceScanError(
      "invalid_record",
      `dgMarket record ${record.noticeId} contains an invalid estimated value.`,
      true,
    );
  }
  if (amount === 0 || !currency) return undefined;
  return { amount, currency };
}

async function parseListPage(response: Response): Promise<ParsedListPage> {
  const records: DgMarketRecord[] = [];
  const bodyParts: string[] = [];
  let totalText: string[] | undefined;
  let pageSizeText: string[] | undefined;
  let currentPageText: string[] | undefined;
  let currentCard: Partial<DgMarketRecord> | undefined;
  let currentTitleParts: string[] | undefined;
  let currentRowParts: string[] | undefined;

  const bodyTextResponse = new HTMLRewriter()
    .on("div#searchInfo span", {
      text(text) {
        appendText(bodyParts, text);
      },
    })
    .transform(response.clone());
  const transformed = new HTMLRewriter()
    .on("div.pr-5", {
      element(element) {
        totalText = [];
        element.onEndTag(() => {
          const match = /^([\d,]+) notices found$/i.exec(normalizedText(totalText?.join("")) ?? "");
          if (match) totalText = [match[1]];
        });
      },
      text(text) {
        appendText(totalText, text);
      },
    })
    .on("select#pageSize option[selected]", {
      element(element) {
        pageSizeText = [element.getAttribute("value") ?? ""];
      },
      text(text) {
        appendText(pageSizeText, text);
      },
    })
    .on("li.page-item.active a.page-link", {
      element() {
        currentPageText = [];
      },
      text(text) {
        appendText(currentPageText, text);
      },
    })
    .on("div.mb-2", {
      element(element) {
        currentCard = {};
        element.onEndTag(() => {
          if (!currentCard?.noticeId) {
            currentCard = undefined;
            return;
          }
          const required = [
            currentCard.title,
            currentCard.buyer,
            currentCard.changedAt,
            currentCard.noticeType,
          ];
          if (required.some((value) => !value)) {
            throw new SourceScanError(
              "invalid_record",
              `dgMarket record ${currentCard.noticeId} is missing a required listing field.`,
              true,
            );
          }
          records.push(currentCard as DgMarketRecord);
          currentCard = undefined;
        });
      },
    })
    .on('div.mb-2 a.card-link[href^="/Notice/"]', {
      element(element) {
        if (!currentCard || currentCard.noticeId) return;
        const href = element.getAttribute("href");
        const match = /^\/Notice\/(\d+)$/.exec(href ?? "");
        if (!match) return;
        currentCard.noticeId = match[1];
        currentCard.canonicalUrl = new URL(href as string, BASE_URL).toString();
        currentTitleParts = [];
        element.onEndTag(() => {
          if (currentCard) currentCard.title = normalizedText(currentTitleParts?.join(""));
          currentTitleParts = undefined;
        });
      },
      text(text) {
        appendText(currentTitleParts, text);
      },
    })
    .on("div.mb-2 tr", {
      element(element) {
        currentRowParts = [];
        element.onEndTag(() => {
          if (!currentCard) return;
          const row = normalizedText(currentRowParts?.join("")) ?? "";
          currentCard.buyer ??= fieldFromRow(row, "Buyer");
          currentCard.changedAt ??= fieldFromRow(row, "Create/Change Date");
          currentCard.countries ??= fieldFromRow(row, "Countries");
          currentCard.deadline ??= fieldFromRow(row, "Deadline");
          currentCard.noticeType ??= fieldFromRow(row, "Type");
          currentCard.originalLanguage ??= fieldFromRow(row, "Original Language");
          currentCard.estimatedValue ??= fieldFromRow(row, "Estimated Value");
          currentRowParts = undefined;
        });
      },
      text(text) {
        appendText(currentRowParts, text);
      },
    })
    .transform(response);
  await Promise.all([bodyTextResponse.arrayBuffer(), transformed.arrayBuffer()]);

  const total = parseCount(totalText?.[0], "notice count");
  const pageSize = parseCount(pageSizeText?.[0], "page size");
  const currentPageValue = normalizedText(currentPageText?.join(""));
  const currentPage = currentPageValue ? parseCount(currentPageValue, "current page") : undefined;
  return {
    total,
    pageSize,
    currentPage,
    bodyText: normalizedText(bodyParts.join("")) ?? "",
    records,
  };
}

function sourceErrorForStatus(status: number): SourceScanError {
  if (status === 429) {
    return new SourceScanError(
      "rate_limited",
      "dgMarket rejected the scan because its request limit was reached.",
      true,
    );
  }
  if (status === 401 || status === 403) {
    return new SourceScanError(
      "access_denied",
      "dgMarket denied access to its public notice search.",
      false,
    );
  }
  if (status >= 500) {
    return new SourceScanError(
      "source_unavailable",
      `dgMarket notice search failed with HTTP ${status}.`,
      true,
    );
  }
  return new SourceScanError(
    "request_rejected",
    `dgMarket rejected the configured notice search with HTTP ${status}.`,
    false,
  );
}

function sessionCookie(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const match = /(?:^|,\s*)JSESSIONID=([^;,\s]+)/.exec(value);
    if (match) return `JSESSIONID=${match[1]}`;
  }
  return undefined;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function dateWindow(context: SourceScanContext, config: DgMarketConfig): DateWindow {
  let anchor: Date;
  let lookbackDays: number;
  if (context.cursor?.value) {
    anchor = new Date(context.cursor.value);
    lookbackDays = config.overlap_days;
    if (Number.isNaN(anchor.getTime()) || anchor > context.now) {
      throw new SourceScanError("invalid_cursor", "dgMarket has an invalid saved scan cursor.", false);
    }
  } else {
    anchor = context.now;
    lookbackDays = config.initial_lookback_days;
  }
  const start = new Date(anchor);
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  const end = new Date(context.now);
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function searchUrl(config: DgMarketConfig, scope: SearchScope, window: DateWindow): URL {
  const url = new URL(SEARCH_PATH, BASE_URL);
  url.searchParams.set("noticeCategory", config.notice_category.code);
  url.searchParams.set("startDate", window.startDate);
  url.searchParams.set("endDate", window.endDate);
  if (scope.cohort === "mca") {
    url.searchParams.set("fundingAgency", config.mca.funding_agency_id);
  } else {
    url.searchParams.set("noticeContactCountry", scope.buyerContactCountry?.code ?? "");
    url.searchParams.set("buyerTypes", config.eu_member_states.buyer_type);
  }
  return url;
}

function expectedCriteria(config: DgMarketConfig, scope: SearchScope, window: DateWindow): string[] {
  const common = [
    "Sectors:",
    config.notice_category.name,
    "Published from:",
    `${window.startDate} 00:00:00`,
    "Published till:",
    `${window.endDate} 00:00:00`,
  ];
  if (scope.cohort === "mca") {
    return ["Funding Agency:", config.mca.funding_agency_name, ...common];
  }
  return [
    "Buyer types:",
    "Government Organization",
    "Country of Notice Contact:",
    scope.buyerContactCountry?.name ?? "",
    ...common,
  ];
}

function assertExpectedCriteria(page: ParsedListPage, criteria: readonly string[]): void {
  const body = page.bodyText.toLocaleLowerCase();
  const missing = criteria.filter((criterion) => !body.includes(criterion.toLocaleLowerCase()));
  if (missing.length > 0) {
    throw new SourceScanError(
      "unexpected_scope",
      `dgMarket did not apply the configured notice search criteria: ${missing.join(", ")}.`,
      true,
    );
  }
}

function recordCandidate(
  record: DgMarketRecord,
  config: DgMarketConfig,
  scope: SearchScope,
  discoveredAt: string,
): SourceCandidate | undefined {
  if (!config.pursuable_notice_types.some((type) =>
    type.toLocaleLowerCase() === record.noticeType.toLocaleLowerCase()
  )) return undefined;

  const value = valueFromRecord(record);
  const place = record.countries?.replace(/^\[/, "").replace(/\]$/, "").trim();
  const publishedAt = normalizedSourceDate(record.changedAt, record.noticeId);
  const dueDate = record.deadline
    ? normalizedSourceDate(record.deadline, record.noticeId)
    : undefined;
  return {
    sourceId: dgMarketSourceDefinition.id,
    sourceEventId: record.noticeId,
    sourceOpportunityId: record.noticeId,
    canonicalUrl: record.canonicalUrl,
    originalEventType: record.noticeType,
    eventType: "tender",
    publishedAt,
    discoveredAt,
    opportunityName: record.title,
    clientName: record.buyer,
    funderNames: scope.cohort === "mca" ? [config.mca.funding_agency_name] : undefined,
    value,
    dueDate,
    placeOfPerformance: place ? { description: place } : undefined,
    documents: [{
      id: `dg-market-notice-${record.noticeId}`,
      title: "dgMarket notice",
      url: record.canonicalUrl,
      documentType: record.noticeType,
    }],
    sourceData: {
      noticeId: record.noticeId,
      clientCohort: scope.cohort,
      buyerContactCountryCode: scope.buyerContactCountry?.code,
      buyerContactCountryName: scope.buyerContactCountry?.name,
      buyerType: scope.cohort === "eu-member-state-government"
        ? config.eu_member_states.buyer_type
        : undefined,
      fundingAgencyId: scope.cohort === "mca" ? config.mca.funding_agency_id : undefined,
      fundingAgencyName: scope.cohort === "mca" ? config.mca.funding_agency_name : undefined,
      noticeCategoryCode: config.notice_category.code,
      noticeCategoryName: config.notice_category.name,
      originalLanguage: record.originalLanguage,
      countries: record.countries,
      rawEstimatedValue: record.estimatedValue,
      valueBasis: value ? "estimated-value" : undefined,
      publicationDateBasis: "create-change-date",
      descriptionAvailability: "subscription-required",
    },
  };
}

export function createDgMarketAdapter(options: DgMarketAdapterOptions): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? options.config.page_size;
  const requestDelayMs = options.requestDelayMs ?? options.config.request_delay_ms;
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new Error("dgMarket pageSize must be between 1 and 50");
  }
  if (!Number.isInteger(requestDelayMs) || requestDelayMs < 0) {
    throw new Error("dgMarket requestDelayMs must be a non-negative integer");
  }

  return {
    definition: dgMarketSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      const window = dateWindow(context, options.config);
      const records = new Map<string, { record: DgMarketRecord; scope: SearchScope }>();
      let requestCount = 0;

      const request = async (url: URL, cookie?: string): Promise<Response> => {
        if (requestCount > 0) await sleep(requestDelayMs, context.signal);
        requestCount += 1;
        let response: Response;
        try {
          response = await fetcher(url, {
            headers: {
              Accept: "text/html",
              "User-Agent": USER_AGENT,
              ...(cookie ? { Cookie: cookie } : {}),
            },
            redirect: "follow",
            signal: context.signal,
          });
        } catch {
          throw new SourceScanError(
            "source_unavailable",
            "dgMarket notice search failed before a response was received.",
            true,
          );
        }
        if (!response.ok) throw sourceErrorForStatus(response.status);
        if (!response.headers.get("content-type")?.toLocaleLowerCase().includes("text/html")) {
          throw new SourceScanError(
            "invalid_response",
            "dgMarket returned a non-HTML notice search response.",
            true,
          );
        }
        return response;
      };

      const runSearch = async (scope: SearchScope): Promise<void> => {
        const response = await request(searchUrl(options.config, scope, window));
        const cookie = sessionCookie(response);
        const firstPage = await parseListPage(response);
        const criteria = expectedCriteria(options.config, scope, window);
        assertExpectedCriteria(firstPage, criteria);
        if (firstPage.pageSize !== pageSize) {
          throw new SourceScanError(
            "invalid_pagination",
            `dgMarket returned page size ${firstPage.pageSize}, expected ${pageSize}.`,
            true,
          );
        }
        const pageCount = Math.ceil(firstPage.total / pageSize) || 1;
        if (pageCount > options.config.max_pages_per_search) {
          throw new SourceScanError(
            "result_set_too_large",
            "dgMarket returned more notice pages than the configured scan limit.",
            false,
          );
        }
        if (pageCount > 1 && !cookie) {
          throw new SourceScanError(
            "invalid_session",
            "dgMarket did not establish the session required for notice pagination.",
            true,
          );
        }

        const found = [...firstPage.records];
        for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
          const pageUrl = new URL(`${SEARCH_PATH}/gotoPage/${pageNumber}`, BASE_URL);
          const page = await parseListPage(await request(pageUrl, cookie));
          assertExpectedCriteria(page, criteria);
          if (
            page.total !== firstPage.total ||
            page.pageSize !== pageSize ||
            (page.currentPage !== undefined && page.currentPage !== pageNumber)
          ) {
            throw new SourceScanError(
              "invalid_pagination",
              "dgMarket returned inconsistent notice pagination metadata.",
              true,
            );
          }
          found.push(...page.records);
        }
        if (found.length !== firstPage.total) {
          throw new SourceScanError(
            "invalid_pagination",
            `dgMarket returned ${found.length} records while reporting ${firstPage.total}.`,
            true,
          );
        }
        for (const record of found) {
          if (!records.has(record.noticeId)) records.set(record.noticeId, { record, scope });
        }
      };

      await runSearch({ cohort: "mca" });
      for (const country of options.config.eu_member_states.countries) {
        await runSearch({
          cohort: "eu-member-state-government",
          buyerContactCountry: country,
        });
      }

      const discoveredAt = context.now.toISOString();
      const candidates = [...records.values()]
        .map(({ record, scope }) => recordCandidate(record, options.config, scope, discoveredAt))
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
