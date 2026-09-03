import type {
  SourceAdapter,
  SourceCandidate,
  SourceDefinition,
  SourceScanContext,
  SourceScanResult,
} from "./adapter";
import { SourceScanError } from "./adapter";

const BASE_URL = "https://beisgroup.ukp.app.jaggaer.com";
const CURRENT_OPPORTUNITIES_URL =
  `${BASE_URL}/esop/guest/go/public/opportunity/current`;
const CURRENT_LIST_PATH = "/esop/toolkit/opportunity/current/list.si";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 " +
  "proc-scan/1.0 (+https://github.com/BryanSchuetz/proc-scan)";
const CLIENT_NAME = "DEZNZ";
const MAX_RECORDS = 250;

interface ListRecord {
  opportunityId: string;
  procurementRoute: string;
  buyerOrganisation: string;
  projectTitle: string;
  workCategory: string;
  listingDeadline: string;
}

interface ParsedListPage {
  records: ListRecord[];
  total: number;
}

interface DetailFieldBuffer {
  labelParts: string[];
  answerParts: string[];
}

interface DetailRecord {
  projectCode: string;
  projectTitle: string;
  projectDescription: string;
  workCategory: string;
  procurementRoute: string;
  listingDeadline: string;
  buyerOrganisation: string;
  contractStartDate?: string;
  contractDuration?: string;
  estimatedValue?: string;
  webLink?: string;
}

interface ParsedValue {
  amount: number;
  basis: "estimated-value-of-contract" | "sum-of-lot-estimates";
}

export const deznzJaggaerSourceDefinition: SourceDefinition = {
  id: "deznz-jaggaer",
  name: "DEZNZ Jaggaer",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface DeznzJaggaerAdapterOptions {
  fetch?: typeof fetch;
  requestDelayMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value
    ?.normalize("NFKC")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&rsquo;/gi, "’")
    .replace(/\s+/g, " ")
    .trim();
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

async function parseListPage(response: Response): Promise<ParsedListPage> {
  const records: ListRecord[] = [];
  let titleParts: string[] | undefined;
  let captionParts: string[] | undefined;
  let counterParts: string[] | undefined;
  let currentCells: string[][] | undefined;
  let currentCell: string[] | undefined;
  let currentOpportunityId: string | undefined;

  const transformed = new HTMLRewriter()
    .on("title", {
      element() {
        titleParts = [];
      },
      text(text) {
        appendText(titleParts, text);
      },
    })
    .on("table.list-table caption", {
      element() {
        captionParts = [];
      },
      text(text) {
        appendText(captionParts, text);
      },
    })
    .on(".pagination-counter", {
      element() {
        counterParts = [];
      },
      text(text) {
        appendText(counterParts, text);
      },
    })
    .on("table.list-table tr.table_cnt_body_a, table.list-table tr.table_cnt_body_b", {
      element(element) {
        currentCells = [];
        currentOpportunityId = undefined;
        element.onEndTag(() => {
          const cells = currentCells?.map((parts) => normalizedText(parts.join("")));
          const recordId = currentOpportunityId;
          currentCells = undefined;
          currentCell = undefined;
          currentOpportunityId = undefined;
          if (!cells || cells.length !== 5 || cells.some((value) => !value) || !recordId) {
            throw new SourceScanError(
              "invalid_record",
              "DEZNZ Jaggaer returned an incomplete opportunity row.",
              true,
            );
          }
          records.push({
            opportunityId: recordId,
            procurementRoute: cells[0] as string,
            buyerOrganisation: cells[1] as string,
            projectTitle: cells[2] as string,
            workCategory: cells[3] as string,
            listingDeadline: cells[4] as string,
          });
        });
      },
    })
    .on("table.list-table tr.table_cnt_body_a td, table.list-table tr.table_cnt_body_b td", {
      element(element) {
        if (!currentCells) return;
        currentCell = [];
        currentCells.push(currentCell);
        element.onEndTag(() => {
          currentCell = undefined;
        });
      },
      text(text) {
        appendText(currentCell, text);
      },
    })
    .on("table.list-table a.detailLink", {
      element(element) {
        if (!currentCells) return;
        const handler = normalizedText(element.getAttribute("onclick") ?? "") ?? "";
        const id = /goToDetail\(\s*['"](\d+)['"]/.exec(handler)?.[1];
        if (id) currentOpportunityId = id;
      },
    })
    .transform(response);
  await transformed.arrayBuffer();

  if (normalizedText(titleParts?.join(""))?.toLocaleLowerCase() !==
      "current opportunities (beis)" ||
    normalizedText(captionParts?.join(""))?.toLocaleLowerCase() !== "current opportunities") {
    throw new SourceScanError(
      "invalid_response",
      "DEZNZ Jaggaer returned an unexpected current-opportunities page.",
      true,
    );
  }
  const counter = normalizedText(counterParts?.join(""));
  const countMatch = /^Showing Result\s*(\d+)\s*-\s*(\d+)\s+of\s+(\d+)$/i.exec(counter ?? "");
  if (!countMatch) {
    throw new SourceScanError(
      "invalid_pagination",
      "DEZNZ Jaggaer did not report a valid opportunity count.",
      true,
    );
  }
  const first = Number(countMatch[1]);
  const last = Number(countMatch[2]);
  const total = Number(countMatch[3]);
  if (
    !Number.isInteger(total) || total < 0 || total > MAX_RECORDS ||
    (total === 0 && (first !== 0 || last !== 0 || records.length !== 0)) ||
    (total > 0 && (first !== 1 || last !== total || records.length !== total))
  ) {
    throw new SourceScanError(
      total > MAX_RECORDS ? "result_set_too_large" : "invalid_pagination",
      total > MAX_RECORDS
        ? "DEZNZ Jaggaer returned more opportunities than the configured scan limit."
        : "DEZNZ Jaggaer returned an incomplete current-opportunities snapshot.",
      total <= MAX_RECORDS,
    );
  }
  const ids = records.map(({ opportunityId }) => opportunityId);
  if (new Set(ids).size !== ids.length) {
    throw new SourceScanError(
      "invalid_response",
      "DEZNZ Jaggaer returned duplicate opportunity identifiers.",
      true,
    );
  }
  return { records, total };
}

async function parseDetailPage(response: Response, opportunityId: string): Promise<DetailRecord> {
  const fields = new Map<string, string>();
  let titleParts: string[] | undefined;
  let currentField: DetailFieldBuffer | undefined;
  let currentParts: string[] | undefined;

  const transformed = new HTMLRewriter()
    .on("title", {
      element() {
        titleParts = [];
      },
      text(text) {
        appendText(titleParts, text);
      },
    })
    .on("li.FormField", {
      element(element) {
        const field: DetailFieldBuffer = { labelParts: [], answerParts: [] };
        currentField = field;
        element.onEndTag(() => {
          const label = normalizedText(field.labelParts.join(""));
          const answer = normalizedText(field.answerParts.join(""));
          if (label && answer) {
            const existing = fields.get(label);
            if (existing && existing !== answer) {
              throw new SourceScanError(
                "invalid_record",
                `DEZNZ Jaggaer opportunity ${opportunityId} returned conflicting ${label} fields.`,
                true,
              );
            }
            fields.set(label, answer);
          }
          if (currentField === field) currentField = undefined;
        });
      },
    })
    .on("li.FormField .form_question_label", {
      element(element) {
        currentParts = currentField?.labelParts;
        element.onEndTag(() => {
          currentParts = undefined;
        });
      },
      text(text) {
        appendText(currentParts, text);
      },
    })
    .on("li.FormField .form_answer", {
      element(element) {
        currentParts = currentField?.answerParts;
        element.onEndTag(() => {
          currentParts = undefined;
        });
      },
      text(text) {
        appendText(currentParts, text);
      },
    })
    .transform(response);
  await transformed.arrayBuffer();

  const pageTitle = normalizedText(titleParts?.join(""));
  if (!pageTitle || !/^Project:\s.+\s\(BEIS\)$/i.test(pageTitle)) {
    throw new SourceScanError(
      "invalid_response",
      `DEZNZ Jaggaer returned an unexpected detail page for opportunity ${opportunityId}.`,
      true,
    );
  }
  const required = [
    "Project Code",
    "Project Title",
    "Project Description",
    "Work Category",
    "Procurement Route",
    "Listing Deadline",
    "Buyer Organisation",
  ] as const;
  const missing = required.filter((label) => !fields.get(label));
  if (missing.length > 0) {
    throw new SourceScanError(
      "invalid_record",
      `DEZNZ Jaggaer opportunity ${opportunityId} is missing required detail fields.`,
      true,
    );
  }
  if (!/^prj_\d+$/i.test(fields.get("Project Code") as string)) {
    throw new SourceScanError(
      "invalid_record",
      `DEZNZ Jaggaer opportunity ${opportunityId} contains an invalid project code.`,
      true,
    );
  }
  return {
    projectCode: fields.get("Project Code") as string,
    projectTitle: fields.get("Project Title") as string,
    projectDescription: fields.get("Project Description") as string,
    workCategory: fields.get("Work Category") as string,
    procurementRoute: fields.get("Procurement Route") as string,
    listingDeadline: fields.get("Listing Deadline") as string,
    buyerOrganisation: fields.get("Buyer Organisation") as string,
    contractStartDate: fields.get("Contract Start Date"),
    contractDuration: fields.get("Contract Duration"),
    estimatedValue: fields.get("Estimated Value of Contract"),
    webLink: fields.get("Web Link"),
  };
}

function londonDate(value: string, opportunityId: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new SourceScanError(
      "invalid_record",
      `DEZNZ Jaggaer opportunity ${opportunityId} contains an invalid listing deadline.`,
      true,
    );
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (
    month < 1 || month > 12 || day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59
  ) {
    throw new SourceScanError(
      "invalid_record",
      `DEZNZ Jaggaer opportunity ${opportunityId} contains an invalid listing deadline.`,
      true,
    );
  }

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const expectedWallTime = Date.UTC(year, month - 1, day, hour, minute);
  let instant = expectedWallTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant)
        .filter(({ type }) => type !== "literal")
        .map(({ type, value: part }) => [type, Number(part)]),
    );
    const displayedWallTime = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    instant += expectedWallTime - displayedWallTime;
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(instant)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, Number(part)]),
  );
  if (
    parts.year !== year || parts.month !== month || parts.day !== day ||
    parts.hour !== hour || parts.minute !== minute
  ) {
    throw new SourceScanError(
      "invalid_record",
      `DEZNZ Jaggaer opportunity ${opportunityId} contains an invalid listing deadline.`,
      true,
    );
  }
  return new Date(instant).toISOString();
}

const POUND_AMOUNT_PATTERN =
  /£\s*(\d+(?:,\d{3})*(?:\.\d+)?|\d*\.\d+)\s*(m(?:illion)?|k|thousand)?\b/gi;

function amountFromMatch(amountText: string, scaleText: string | undefined): number | undefined {
  const amount = Number(amountText.replaceAll(",", ""));
  const scale = scaleText?.toLocaleLowerCase();
  const multiplier = scale?.startsWith("m") ? 1_000_000 : scale === "k" || scale === "thousand"
    ? 1_000
    : 1;
  const value = amount * multiplier;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parsedValue(value: string | undefined): ParsedValue | undefined {
  if (!value) return undefined;
  const matches = [...value.matchAll(POUND_AMOUNT_PATTERN)];
  const amounts = matches
    .map((match) => amountFromMatch(match[1], match[2]))
    .filter((amount): amount is number => amount !== undefined);
  if (amounts.length !== matches.length || amounts.length === 0) return undefined;
  if (amounts.length === 1) {
    return { amount: amounts[0], basis: "estimated-value-of-contract" };
  }
  const lotMatches = [...value.matchAll(
    /\bLot\s+[A-Za-z0-9]+\s+£\s*(\d+(?:,\d{3})*(?:\.\d+)?|\d*\.\d+)\s*(m(?:illion)?|k|thousand)?\b/gi,
  )];
  const lotAmounts = lotMatches
    .map((match) => amountFromMatch(match[1], match[2]))
    .filter((amount): amount is number => amount !== undefined);
  if (lotAmounts.length !== amounts.length) return undefined;
  return {
    amount: lotAmounts.reduce((sum, amount) => sum + amount, 0),
    basis: "sum-of-lot-estimates",
  };
}

function clientMappingBasis(detail: DetailRecord): string | undefined {
  const buyer = detail.buyerOrganisation.toLocaleLowerCase();
  if (buyer === "department for energy security and net zero") return "exact-buyer";
  if (/^desnz\b/i.test(detail.buyerOrganisation) && !/\bdsit\b/i.test(detail.buyerOrganisation)) {
    return "buyer-acronym";
  }
  if (/\bDESNZ\b/i.test(detail.projectDescription) ||
    /Department for Energy Security and Net Zero/i.test(detail.projectDescription)) {
    return "project-description";
  }
  return undefined;
}

function assertListDetailConsistency(list: ListRecord, detail: DetailRecord): void {
  if (
    detail.projectTitle !== list.projectTitle ||
    detail.workCategory !== list.workCategory ||
    detail.procurementRoute !== list.procurementRoute ||
    detail.listingDeadline !== list.listingDeadline ||
    detail.buyerOrganisation !== list.buyerOrganisation
  ) {
    throw new SourceScanError(
      "invalid_record",
      `DEZNZ Jaggaer opportunity ${list.opportunityId} has inconsistent list and detail fields.`,
      true,
    );
  }
}

function candidateFromRecord(
  list: ListRecord,
  detail: DetailRecord,
  discoveredAt: string,
): SourceCandidate | undefined {
  assertListDetailConsistency(list, detail);
  const mappingBasis = clientMappingBasis(detail);
  if (!mappingBasis) return undefined;
  const value = parsedValue(detail.estimatedValue);
  const webLink = detail.webLink && /^https:\/\//i.test(detail.webLink)
    ? detail.webLink
    : undefined;
  return {
    sourceId: deznzJaggaerSourceDefinition.id,
    sourceEventId: list.opportunityId,
    sourceOpportunityId: detail.projectCode,
    canonicalUrl: CURRENT_OPPORTUNITIES_URL,
    originalEventType: detail.procurementRoute,
    eventType: "tender",
    discoveredAt,
    opportunityName: detail.projectTitle,
    description: detail.projectDescription,
    clientName: CLIENT_NAME,
    procuringEntityName: detail.buyerOrganisation,
    value: value ? { amount: value.amount, currency: "GBP" } : undefined,
    dueDate: londonDate(detail.listingDeadline, list.opportunityId),
    sourceStatus: "current",
    documents: [
      {
        id: `deznz-jaggaer-${list.opportunityId}`,
        title: "DEZNZ Jaggaer current opportunities",
        url: CURRENT_OPPORTUNITIES_URL,
        documentType: detail.procurementRoute,
      },
      ...(webLink
        ? [{
            id: `deznz-jaggaer-${list.opportunityId}-external-notice`,
            title: "External procurement notice",
            url: webLink,
            documentType: "procurement-notice",
          }]
        : []),
    ],
    sourceData: {
      jaggaerOpportunityId: list.opportunityId,
      projectCode: detail.projectCode,
      procurementRoute: detail.procurementRoute,
      workCategory: detail.workCategory,
      buyerOrganisation: detail.buyerOrganisation,
      clientMappingBasis: mappingBasis,
      rawEstimatedValue: detail.estimatedValue,
      valueBasis: value?.basis,
      contractStartDate: detail.contractStartDate,
      contractDuration: detail.contractDuration,
      deadlineBasis: "listing-deadline-europe-london",
    },
  };
}

function sourceErrorForStatus(status: number): SourceScanError {
  if (status >= 300 && status < 400) {
    return new SourceScanError(
      "invalid_session",
      "DEZNZ Jaggaer's public visitor session expired during the scan.",
      true,
    );
  }
  if (status === 429) {
    return new SourceScanError(
      "rate_limited",
      "DEZNZ Jaggaer rejected the scan because its request limit was reached.",
      true,
    );
  }
  if (status === 401 || status === 403) {
    return new SourceScanError(
      "access_denied",
      "DEZNZ Jaggaer denied access to its public opportunity pages.",
      false,
    );
  }
  return new SourceScanError(
    status >= 500 ? "source_unavailable" : "request_rejected",
    `DEZNZ Jaggaer request failed with HTTP ${status}.`,
    status >= 500,
  );
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

export function createDeznzJaggaerAdapter(
  options: DeznzJaggaerAdapterOptions = {},
): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  const requestDelayMs = options.requestDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isInteger(requestDelayMs) || requestDelayMs < 0 || requestDelayMs > 5_000) {
    throw new Error("DEZNZ Jaggaer requestDelayMs must be between 0 and 5,000 milliseconds");
  }

  return {
    definition: deznzJaggaerSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      let requestCount = 0;
      const request = async (url: string | URL, redirect: RequestRedirect): Promise<Response> => {
        if (requestCount > 0) await sleep(requestDelayMs, context.signal);
        requestCount += 1;
        let response: Response;
        try {
          response = await fetcher(url, {
            headers: {
              Accept: "text/html",
              "User-Agent": USER_AGENT,
            },
            redirect,
            signal: context.signal,
          });
        } catch {
          throw new SourceScanError(
            "source_unavailable",
            "DEZNZ Jaggaer request failed before a response was received.",
            true,
          );
        }
        return response;
      };

      const entryResponse = await request(CURRENT_OPPORTUNITIES_URL, "manual");
      if (![301, 302, 303, 307, 308].includes(entryResponse.status)) {
        if (!entryResponse.ok) throw sourceErrorForStatus(entryResponse.status);
        throw new SourceScanError(
          "invalid_session",
          "DEZNZ Jaggaer did not establish a public visitor session.",
          true,
        );
      }
      const location = entryResponse.headers.get("location");
      let listUrl: URL;
      try {
        listUrl = new URL(location ?? "", CURRENT_OPPORTUNITIES_URL);
      } catch {
        throw new SourceScanError(
          "invalid_session",
          "DEZNZ Jaggaer returned an invalid public visitor redirect.",
          true,
        );
      }
      const visitorId = listUrl.searchParams.get("VISITORID");
      if (listUrl.origin !== BASE_URL || listUrl.pathname !== CURRENT_LIST_PATH || !visitorId) {
        throw new SourceScanError(
          "invalid_session",
          "DEZNZ Jaggaer returned an unexpected public visitor redirect.",
          true,
        );
      }

      const listResponse = await request(listUrl, "manual");
      if (!listResponse.ok) throw sourceErrorForStatus(listResponse.status);
      if (!listResponse.headers.get("content-type")?.toLocaleLowerCase().includes("text/html")) {
        throw new SourceScanError(
          "invalid_response",
          "DEZNZ Jaggaer returned a non-HTML opportunity list.",
          true,
        );
      }
      const listPage = await parseListPage(listResponse);
      const serviceRecords = listPage.records.filter(({ workCategory }) =>
        workCategory.toLocaleLowerCase() === "services"
      );
      const discoveredAt = context.now.toISOString();
      const candidates: SourceCandidate[] = [];
      for (const listRecord of serviceRecords) {
        const detailUrl = new URL(
          `/esop/toolkit/opportunity/current/${listRecord.opportunityId}/detail.si`,
          BASE_URL,
        );
        detailUrl.searchParams.set("VISITORID", visitorId);
        const detailResponse = await request(detailUrl, "manual");
        if (!detailResponse.ok) throw sourceErrorForStatus(detailResponse.status);
        if (!detailResponse.headers.get("content-type")?.toLocaleLowerCase().includes("text/html")) {
          throw new SourceScanError(
            "invalid_response",
            `DEZNZ Jaggaer returned a non-HTML detail response for opportunity ${listRecord.opportunityId}.`,
            true,
          );
        }
        const candidate = candidateFromRecord(
          listRecord,
          await parseDetailPage(detailResponse, listRecord.opportunityId),
          discoveredAt,
        );
        if (candidate) candidates.push(candidate);
      }

      return {
        candidates: candidates.sort((a, b) =>
          (a.dueDate ?? "").localeCompare(b.dueDate ?? "") ||
          (a.sourceEventId ?? "").localeCompare(b.sourceEventId ?? ""),
        ),
        nextCursor: { value: discoveredAt },
      };
    },
  };
}
