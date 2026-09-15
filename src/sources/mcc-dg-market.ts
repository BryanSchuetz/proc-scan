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
import {
  createBrowserPageSessionFactory,
  type BrowserPageSession,
  type BrowserPageSessionFactory,
} from "./browser-page";

const BASE_URL = "https://mcc.dgmarket.com";
const LIST_URL = `${BASE_URL}/`;
const MCC_NAME = "Millennium Challenge Corporation (MCC)";

const configSchema = z.object({
  schema_version: z.number().int().positive(),
  request_delay_ms: z.number().int().min(0).max(5_000),
  max_pages: z.number().int().min(1).max(100),
  clients: z.array(z.enum(["MCC", "MCA"])).length(2),
  pursuable_notice_types: z.array(z.enum(["spn", "gpn", "rei", "pp"])).min(1),
});

export type MccDgMarketConfig = z.infer<typeof configSchema>;

interface ListRecord {
  noticeId: string;
  canonicalUrl: string;
  country: string;
  title: string;
  noticeType: string;
  published: string;
  deadline?: string;
}

interface ParsedListPage {
  firstRecord: number;
  lastRecord: number;
  total: number;
  currentPage: number;
  pageUrls: URL[];
  records: ListRecord[];
}

interface DetailRecord {
  title: string;
  noticeType: string;
  country?: string;
  published?: string;
  deadline?: string;
  agency?: string;
  buyer?: string;
  originalLanguage?: string;
  description?: string;
  value?: SourceCandidate["value"];
}

export const mccDgMarketSourceDefinition: SourceDefinition = {
  id: "mcc-dg-market",
  name: "MCCDGMarket",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface MccDgMarketAdapterOptions {
  config: MccDgMarketConfig;
  browser?: Fetcher;
  browserSessionFactory?: BrowserPageSessionFactory;
  fetch?: typeof fetch;
  requestDelayMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function parseMccDgMarketConfig(raw: string): MccDgMarketConfig {
  const config = configSchema.parse(parse(raw));
  if (new Set(config.clients).size !== 2) {
    throw new Error("MCCDGMarket client scope must contain MCC and MCA exactly once");
  }
  if (new Set(config.pursuable_notice_types).size !== config.pursuable_notice_types.length) {
    throw new Error("Duplicate MCCDGMarket pursuable notice type");
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

function parseSourceDate(value: string, noticeId: string): string {
  const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/.exec(
    value.trim(),
  );
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = match ? months.indexOf(match[1]) : -1;
  if (!match || month < 0) {
    throw new SourceScanError(
      "invalid_record",
      `MCCDGMarket record ${noticeId} contains an invalid date.`,
      true,
    );
  }
  return new Date(Date.UTC(Number(match[3]), month, Number(match[2]))).toISOString();
}

function valueFromText(value: string | undefined, noticeId: string): SourceCandidate["value"] {
  if (!value) return undefined;
  const match = /^([€$£])?\s*([\d,]+(?:\.\d+)?)\s*([A-Z]{3})?$/.exec(value.trim());
  const symbolCurrency: Record<string, string> = { "€": "EUR", "$": "USD", "£": "GBP" };
  const amount = match ? Number(match[2].replaceAll(",", "")) : Number.NaN;
  const currency = match?.[3] ?? (match?.[1] ? symbolCurrency[match[1]] : undefined);
  if (!match || !Number.isFinite(amount) || amount < 0 || !currency) {
    throw new SourceScanError(
      "invalid_record",
      `MCCDGMarket record ${noticeId} contains an invalid estimated value.`,
      true,
    );
  }
  return amount === 0 ? undefined : { amount, currency };
}

async function parseListPage(response: Response): Promise<ParsedListPage> {
  let rangeParts: string[] | undefined;
  let currentPageParts: string[] | undefined;
  let currentRow: { cells: string[][]; noticeId?: string; href?: string } | undefined;
  let currentCell: string[] | undefined;
  const records: ListRecord[] = [];
  const pageUrls: URL[] = [];

  const transformed = new HTMLRewriter()
    .on("#mainDivFlex > form > table > tbody > tr > td", {
      element() {
        rangeParts ??= [];
      },
      text(text) {
        appendText(rangeParts, text);
      },
    })
    .on("#mainDivFlex b", {
      element() {
        currentPageParts = [];
      },
      text(text) {
        appendText(currentPageParts, text);
      },
    })
    .on('#mainDivFlex a[href*="selPageNumber="]', {
      element(element) {
        const href = element.getAttribute("href");
        if (href) pageUrls.push(new URL(href.replaceAll("&amp;", "&"), BASE_URL));
      },
    })
    .on("table#notice tbody tr", {
      element(element) {
        currentRow = { cells: [] };
        element.onEndTag(() => {
          if (!currentRow?.noticeId || !currentRow.href || currentRow.cells.length !== 5) {
            throw new SourceScanError(
              "invalid_record",
              "MCCDGMarket returned a malformed notice-list row.",
              true,
            );
          }
          const values = currentRow.cells.map((cell) => normalizedText(cell.join("")) ?? "");
          records.push({
            noticeId: currentRow.noticeId,
            canonicalUrl: new URL(currentRow.href, BASE_URL).toString(),
            country: values[0],
            title: values[1],
            noticeType: values[2].toLocaleLowerCase(),
            published: values[3],
            deadline: values[4] || undefined,
          });
          currentRow = undefined;
        });
      },
    })
    .on("table#notice tbody tr td", {
      element(element) {
        if (!currentRow) return;
        currentCell = [];
        currentRow.cells.push(currentCell);
        element.onEndTag(() => {
          currentCell = undefined;
        });
      },
      text(text) {
        appendText(currentCell, text);
      },
    })
    .on('table#notice tbody tr td a[href^="/tender/"]', {
      element(element) {
        if (!currentRow || currentRow.noticeId) return;
        const href = element.getAttribute("href");
        const match = /^\/tender\/(\d+)$/.exec(href ?? "");
        if (match) {
          currentRow.noticeId = match[1];
          currentRow.href = href as string;
        }
      },
    })
    .transform(response);
  await transformed.arrayBuffer();

  const range = /(\d+)-(\d+) of (\d+)/.exec(normalizedText(rangeParts?.join("")) ?? "");
  const currentPage = Number(normalizedText(currentPageParts?.join("")));
  if (!range || !Number.isInteger(currentPage) || currentPage < 1) {
    throw new SourceScanError(
      "invalid_pagination",
      "MCCDGMarket returned invalid notice-list pagination.",
      true,
    );
  }
  return {
    firstRecord: Number(range[1]),
    lastRecord: Number(range[2]),
    total: Number(range[3]),
    currentPage,
    pageUrls,
    records,
  };
}

function fieldFromRow(row: string, label: string): string | undefined {
  const match = new RegExp(`^${label}\\s*:\\s*(.*)$`, "i").exec(row);
  return normalizedText(match?.[1]);
}

async function parseDetailPage(response: Response, noticeId: string): Promise<DetailRecord> {
  let titleParts: string[] | undefined;
  let typeParts: string[] | undefined;
  let rowParts: string[] | undefined;
  let descriptionParts: string[] | undefined;
  const fields: Record<string, string> = {};

  const transformed = new HTMLRewriter()
    .on(".notice-title h1", {
      element() { titleParts = []; },
      text(text) { appendText(titleParts, text); },
    })
    .on(".notice-title h4", {
      element() { typeParts = []; },
      text(text) { appendText(typeParts, text); },
    })
    .on('form[name="form1"] > table > tbody > tr', {
      element(element) {
        rowParts = [];
        element.onEndTag(() => {
          const row = normalizedText(rowParts?.join("")) ?? "";
          for (const label of [
            "Country", "Publication Date", "Deadline", "Agency", "Buyer",
            "Original Language", "Estimated Value",
          ]) {
            const value = fieldFromRow(row, label);
            if (value) fields[label] = value;
          }
          rowParts = undefined;
        });
      },
      text(text) { appendText(rowParts, text); },
    })
    .on(".fixwhitespace-wrapper", {
      element() { descriptionParts = []; },
      text(text) { appendText(descriptionParts, text); },
    })
    .transform(response);
  await transformed.arrayBuffer();

  const title = normalizedText(titleParts?.join(""));
  const noticeType = normalizedText(typeParts?.join(""))?.toLocaleLowerCase();
  if (!title || !noticeType) {
    throw new SourceScanError(
      "invalid_record",
      `MCCDGMarket record ${noticeId} is missing its title or notice type.`,
      true,
    );
  }
  return {
    title,
    noticeType,
    country: fields.Country,
    published: fields["Publication Date"],
    deadline: fields.Deadline,
    agency: fields.Agency,
    buyer: fields.Buyer,
    originalLanguage: fields["Original Language"],
    description: normalizedText(descriptionParts?.join("")),
    value: valueFromText(fields["Estimated Value"], noticeId),
  };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
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

function cancellationTitle(title: string): boolean {
  return /\b(?:cancel(?:led|lation)?|annulation|annul(?:é|ée|er))\b/i.test(title);
}

function awardTitle(title: string): boolean {
  return /\b(?:contract award|attribution de contrat|attribution de marchés)\b/i.test(title);
}

async function loadResponse(
  url: URL,
  readySelector: string,
  browserSession: BrowserPageSession | undefined,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  if (browserSession) return browserSession.load(url, readySelector);
  let response: Response;
  try {
    response = await fetcher(url, { signal, redirect: "follow" });
  } catch {
    throw new SourceScanError(
      "source_unavailable",
      "MCCDGMarket failed before a response was received.",
      true,
    );
  }
  if (!response.ok) {
    throw new SourceScanError(
      response.status === 403 ? "access_denied" : "request_rejected",
      `MCCDGMarket rejected its public-page request with HTTP ${response.status}.`,
      response.status === 403 || response.status === 429 || response.status >= 500,
    );
  }
  if (!response.headers.get("content-type")?.toLocaleLowerCase().includes("text/html")) {
    throw new SourceScanError(
      "invalid_response",
      "MCCDGMarket returned a non-HTML response.",
      true,
    );
  }
  return response;
}

export function createMccDgMarketAdapter(options: MccDgMarketAdapterOptions): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  const browserSessionFactory = options.browserSessionFactory ??
    (options.browser
      ? createBrowserPageSessionFactory(options.browser, mccDgMarketSourceDefinition.name)
      : undefined);
  const delay = options.requestDelayMs ?? options.config.request_delay_ms;
  const sleep = options.sleep ?? defaultSleep;

  return {
    definition: mccDgMarketSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      const browserSession = browserSessionFactory
        ? await browserSessionFactory(context.signal)
        : undefined;
      let requestCount = 0;
      const load = async (url: URL, selector: string) => {
        if (requestCount > 0) await sleep(delay, context.signal);
        requestCount += 1;
        return loadResponse(url, selector, browserSession, fetcher, context.signal);
      };

      try {
        const firstPage = await parseListPage(await load(new URL(LIST_URL), "table#notice"));
        const pageSize = firstPage.lastRecord - firstPage.firstRecord + 1;
        const pageCount = Math.ceil(firstPage.total / pageSize) || 1;
        if (pageCount > options.config.max_pages) {
          throw new SourceScanError(
            "result_set_too_large",
            "MCCDGMarket returned more pages than the configured scan limit.",
            false,
          );
        }

        const records = [...firstPage.records];
        let page = firstPage;
        for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
          const pageUrl = page.pageUrls.find((url) =>
            url.searchParams.get("selPageNumber") === String(pageNumber)
          );
          if (!pageUrl) {
            throw new SourceScanError(
              "invalid_pagination",
              "MCCDGMarket omitted the next notice-list page link.",
              true,
            );
          }
          page = await parseListPage(await load(pageUrl, "table#notice"));
          if (page.currentPage !== pageNumber || page.total !== firstPage.total) {
            throw new SourceScanError(
              "invalid_pagination",
              "MCCDGMarket returned inconsistent pagination metadata.",
              true,
            );
          }
          records.push(...page.records);
        }
        if (records.length !== firstPage.total) {
          throw new SourceScanError(
            "invalid_pagination",
            `MCCDGMarket returned ${records.length} records while reporting ${firstPage.total}.`,
            true,
          );
        }

        const pursuable = records.filter((record) =>
          !awardTitle(record.title) && (
            options.config.pursuable_notice_types.includes(record.noticeType as "spn" | "gpn" | "rei" | "pp") ||
            cancellationTitle(record.title)
          )
        );
        const candidates: SourceCandidate[] = [];
        for (const record of pursuable) {
          const detail = await parseDetailPage(
            await load(new URL(record.canonicalUrl), ".notice-title"),
            record.noticeId,
          );
          if (detail.title !== record.title && detail.noticeType !== record.noticeType) {
            throw new SourceScanError(
              "invalid_record",
              `MCCDGMarket record ${record.noticeId} changed between its list and detail pages.`,
              true,
            );
          }
          const mcaPattern = /(?:\bMCA\b|Millennium\s+Challenge\s+Account)/i;
          const mccPattern = /(?:\bMCC\b|Millennium\s+Challenge\s+Corporation)/i;
          const clientCohort = mcaPattern.test(detail.buyer ?? "")
            ? "mca"
            : mccPattern.test(detail.buyer ?? "")
              ? "mcc"
              : mcaPattern.test(detail.description ?? "")
                ? "mca"
                : mccPattern.test(detail.agency ?? "")
                  ? "mcc"
                  : undefined;
          if (!clientCohort) continue;
          if (!options.config.clients.includes(clientCohort === "mca" ? "MCA" : "MCC")) continue;
          const publishedAt = parseSourceDate(record.published, record.noticeId);
          const deadline = record.deadline ?? detail.deadline;
          const eventType = cancellationTitle(record.title) ? "cancellation" : "tender";
          candidates.push({
            sourceId: mccDgMarketSourceDefinition.id,
            sourceEventId: record.noticeId,
            sourceOpportunityId: record.noticeId,
            canonicalUrl: record.canonicalUrl,
            originalEventType: record.noticeType,
            eventType,
            opportunityName: record.title,
            description: detail.description,
            clientName: detail.buyer || (clientCohort === "mca" ? "Millennium Challenge Account" : MCC_NAME),
            funderNames: [detail.agency ?? MCC_NAME],
            placeOfPerformance: { description: detail.country ?? record.country },
            publishedAt,
            dueDate: deadline ? parseSourceDate(deadline, record.noticeId) : undefined,
            value: detail.value,
            discoveredAt: context.now.toISOString(),
            documents: [{
              id: `mcc-dg-market-notice-${record.noticeId}`,
              title: "MCCDGMarket notice",
              url: record.canonicalUrl,
              documentType: record.noticeType,
            }],
            sourceData: {
              noticeId: record.noticeId,
              clientCohort,
              originalLanguage: detail.originalLanguage,
              valueBasis: detail.value ? "estimated-value" : undefined,
              publicationDateBasis: "publication-date",
            },
          });
        }
        candidates.sort((a, b) =>
          (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "") ||
          (a.sourceEventId ?? "").localeCompare(b.sourceEventId ?? "")
        );
        return { candidates, nextCursor: { value: context.now.toISOString() } };
      } finally {
        await browserSession?.close();
      }
    },
  };
}
