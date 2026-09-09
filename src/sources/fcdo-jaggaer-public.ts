import type {
  SourceAdapter,
  SourceCandidate,
  SourceDefinition,
  SourceScanContext,
  SourceScanResult,
} from "./adapter";
import { SourceScanError } from "./adapter";

const BASE_URL = "https://fcdo.bravosolution.co.uk";
const ENTRY_URL = `${BASE_URL}/esop/guest/go/public/opportunity/current`;
const LIST_PATH = "/esop/toolkit/opportunity/current/list.si";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 " +
  "proc-scan/1.0 (+https://github.com/BryanSchuetz/proc-scan)";
const MAX_RECORDS = 250;
const ALLOWED_COOKIE = /^(?:VISITORID|CLUSTER-NODE|AWSALBAPP-\d|JSESSIONID)$/;

interface ListRecord {
  opportunityId: string;
  procurementRoute: string;
  buyerOrganisation: string;
  projectTitle: string;
  workCategory: string;
  listingDeadline: string;
}

interface DetailRecord {
  projectCode: string;
  projectTitle: string;
  projectDescription: string;
  notes?: string;
  workCategory: string;
  procurementRoute: string;
  listingDeadline: string;
  buyerOrganisation: string;
  contractStartDate?: string;
  contractDuration?: string;
  estimatedValue?: string;
}

export const fcdoJaggaerPublicSourceDefinition: SourceDefinition = {
  id: "fcdo-jaggaer-public",
  name: "FCDO Jaggaer Public",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface FcdoJaggaerPublicAdapterOptions {
  fetch?: typeof fetch;
  requestDelayMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function text(value: string | undefined): string | undefined {
  const normalized = value
    ?.normalize("NFKC")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function append(parts: string[] | undefined, value: { text: string; lastInTextNode: boolean }): void {
  if (!parts) return;
  parts.push(value.text);
  if (value.lastInTextNode) parts.push(" ");
}

async function parseList(response: Response): Promise<ListRecord[]> {
  const records: ListRecord[] = [];
  let title: string[] | undefined;
  let caption: string[] | undefined;
  let counter: string[] | undefined;
  let cells: string[][] | undefined;
  let cell: string[] | undefined;
  let opportunityId: string | undefined;
  const transformed = new HTMLRewriter()
    .on("title", { element() { title = []; }, text(value) { append(title, value); } })
    .on("table.list-table caption", {
      element() { if (!caption) caption = []; },
      text(value) { append(caption, value); },
    })
    .on(".pagination-counter", { element() { counter = []; }, text(value) { append(counter, value); } })
    .on("table.list-table tr.table_cnt_body_a, table.list-table tr.table_cnt_body_b", {
      element(element) {
        cells = [];
        opportunityId = undefined;
        element.onEndTag(() => {
          const values = cells?.map((parts) => text(parts.join("")));
          const id = opportunityId;
          cells = undefined;
          cell = undefined;
          opportunityId = undefined;
          if (!values || values.length !== 5 || values.some((value) => !value) || !id) {
            throw new SourceScanError(
              "invalid_record",
              `FCDO Jaggaer returned an incomplete opportunity row (${values?.length ?? 0} fields; identifier ${id ? "present" : "missing"}).`,
              true,
            );
          }
          records.push({
            opportunityId: id,
            procurementRoute: values[0] as string,
            buyerOrganisation: values[1] as string,
            projectTitle: values[2] as string,
            workCategory: values[3] as string,
            listingDeadline: values[4] as string,
          });
        });
      },
    })
    .on("table.list-table tr.table_cnt_body_a td, table.list-table tr.table_cnt_body_b td", {
      element(element) {
        if (!cells) return;
        cell = [];
        cells.push(cell);
        element.onEndTag(() => { cell = undefined; });
      },
      text(value) { append(cell, value); },
    })
    .on("table.list-table a.detailLink", {
      element(element) {
        if (!cells) return;
        opportunityId = /goToDetail\(\s*['"](\d+)['"]/.exec(text(element.getAttribute("onclick") ?? undefined) ?? "")?.[1];
      },
    })
    .transform(response);
  await transformed.arrayBuffer();

  if (text(title?.join(""))?.toLocaleLowerCase() !==
      "current opportunities (foreign and commonwealth office esourcing portal)" ||
    text(caption?.join(""))?.toLocaleLowerCase() !== "current opportunities") {
    throw new SourceScanError("invalid_response", "FCDO Jaggaer returned an unexpected opportunity list.", true);
  }
  const match = /^Showing Result\s*(\d+)\s*-\s*(\d+)\s+of\s+(\d+)$/i.exec(text(counter?.join("")) ?? "");
  if (!match) throw new SourceScanError("invalid_pagination", "FCDO Jaggaer did not report a valid opportunity count.", true);
  const [first, last, total] = match.slice(1).map(Number);
  if (total > MAX_RECORDS ||
      (total === 0 && (first !== 0 || last !== 0 || records.length !== 0)) ||
      (total > 0 && (first !== 1 || last !== total || records.length !== total))) {
    throw new SourceScanError(
      total > MAX_RECORDS ? "result_set_too_large" : "invalid_pagination",
      total > MAX_RECORDS
        ? "FCDO Jaggaer returned more opportunities than the configured scan limit."
        : "FCDO Jaggaer returned an incomplete opportunity snapshot.",
      total <= MAX_RECORDS,
    );
  }
  if (new Set(records.map(({ opportunityId: id }) => id)).size !== records.length) {
    throw new SourceScanError("invalid_response", "FCDO Jaggaer returned duplicate opportunity identifiers.", true);
  }
  return records;
}

async function parseDetail(response: Response, id: string): Promise<DetailRecord> {
  const fields = new Map<string, string>();
  let title: string[] | undefined;
  let field: { label: string[]; answer: string[] } | undefined;
  let parts: string[] | undefined;
  const transformed = new HTMLRewriter()
    .on("title", { element() { title = []; }, text(value) { append(title, value); } })
    .on("li.FormField", {
      element(element) {
        const current = { label: [], answer: [] };
        field = current;
        element.onEndTag(() => {
          const label = text(current.label.join(""));
          const answer = text(current.answer.join(""));
          if (label && answer) fields.set(label, answer);
          if (field === current) field = undefined;
        });
      },
    })
    .on("li.FormField .form_question_label", {
      element(element) { parts = field?.label; element.onEndTag(() => { parts = undefined; }); },
      text(value) { append(parts, value); },
    })
    .on("li.FormField .form_answer", {
      element(element) { parts = field?.answer; element.onEndTag(() => { parts = undefined; }); },
      text(value) { append(parts, value); },
    })
    .transform(response);
  await transformed.arrayBuffer();
  if (!/^Project:\s.+\s\(Foreign and Commonwealth Office eSourcing Portal\)$/i.test(text(title?.join("")) ?? "")) {
    throw new SourceScanError("invalid_response", `FCDO Jaggaer returned an unexpected detail page for opportunity ${id}.`, true);
  }
  const required = ["Project Code", "Project Title", "Project Description", "Work Category", "Procurement Route", "Listing Deadline", "Buyer Organisation"];
  if (required.some((label) => !fields.get(label)) || !/^project_\d+$/i.test(fields.get("Project Code") ?? "")) {
    throw new SourceScanError("invalid_record", `FCDO Jaggaer opportunity ${id} is missing required detail fields.`, true);
  }
  return {
    projectCode: fields.get("Project Code")!,
    projectTitle: fields.get("Project Title")!,
    projectDescription: fields.get("Project Description")!,
    notes: fields.get("Notes"),
    workCategory: fields.get("Work Category")!,
    procurementRoute: fields.get("Procurement Route")!,
    listingDeadline: fields.get("Listing Deadline")!,
    buyerOrganisation: fields.get("Buyer Organisation")!,
    contractStartDate: fields.get("Contract Start Date"),
    contractDuration: fields.get("Contract Duration"),
    estimatedValue: fields.get("Estimated Value of Contract"),
  };
}

function londonDate(value: string, id: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new SourceScanError("invalid_record", `FCDO Jaggaer opportunity ${id} has an invalid deadline.`, true);
  const [day, month, year, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59) {
    throw new SourceScanError("invalid_record", `FCDO Jaggaer opportunity ${id} has an invalid deadline.`, true);
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dateParts = Object.fromEntries(formatter.formatToParts(instant)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, Number(part)]));
    instant += wall - Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, dateParts.hour, dateParts.minute, dateParts.second);
  }
  return new Date(instant).toISOString();
}

function valueFrom(raw: string | undefined): { amount: number; currency: string } | undefined {
  const match = raw && /£\s*(\d+(?:,\d{3})*(?:\.\d+)?|\d*\.\d+)\s*(m(?:illion)?|k|thousand)?\b/i.exec(raw);
  if (!match) return undefined;
  const scale = match[2]?.toLocaleLowerCase();
  const multiplier = scale?.startsWith("m") ? 1_000_000 : scale === "k" || scale === "thousand" ? 1_000 : 1;
  const amount = Number(match[1].replaceAll(",", "")) * multiplier;
  return Number.isFinite(amount) && amount > 0 ? { amount, currency: "GBP" } : undefined;
}

function isFcdoBuyer(value: string): boolean {
  return /^(?:foreign,?\s+commonwealth\s+(?:and|&)\s+development office|foreign and commonwealth office)$/i.test(value);
}

function candidate(list: ListRecord, detail: DetailRecord, discoveredAt: string): SourceCandidate | undefined {
  if ([list.projectTitle, list.workCategory, list.procurementRoute, list.listingDeadline]
      .some((value, index) => value !== [detail.projectTitle, detail.workCategory, detail.procurementRoute, detail.listingDeadline][index])) {
    throw new SourceScanError("invalid_record", `FCDO Jaggaer opportunity ${list.opportunityId} has inconsistent list and detail fields.`, true);
  }
  const scopeText = `${detail.projectTitle} ${detail.projectDescription} ${detail.notes ?? ""}`;
  if (detail.workCategory.toLocaleLowerCase() !== "services" || !isFcdoBuyer(detail.buyerOrganisation) ||
      /\b(?:framework|call[- ]?down|GDD|EACDS2?|GEMFA|ISF)\b/i.test(scopeText)) return undefined;
  const marketEngagement = /\b(?:early market engagement|market engagement event)\b/i.test(scopeText) ||
    /not a call to competition/i.test(detail.notes ?? "");
  const value = valueFrom(detail.estimatedValue);
  return {
    sourceId: fcdoJaggaerPublicSourceDefinition.id,
    sourceEventId: list.opportunityId,
    sourceOpportunityId: detail.projectCode,
    canonicalUrl: ENTRY_URL,
    originalEventType: detail.procurementRoute,
    eventType: "tender",
    discoveredAt,
    opportunityName: detail.projectTitle,
    description: detail.projectDescription,
    clientName: "FCDO",
    procuringEntityName: detail.buyerOrganisation,
    value,
    dueDate: londonDate(detail.listingDeadline, list.opportunityId),
    sourceStatus: marketEngagement ? "early-market-engagement" : "current-public",
    documents: [{ id: `fcdo-jaggaer-public-${list.opportunityId}`, title: detail.projectTitle, url: ENTRY_URL, documentType: detail.procurementRoute }],
    sourceData: {
      jaggaerOpportunityId: list.opportunityId,
      projectCode: detail.projectCode,
      procurementRoute: detail.procurementRoute,
      workCategory: detail.workCategory,
      buyerOrganisation: detail.buyerOrganisation,
      rawEstimatedValue: detail.estimatedValue,
      valueBasis: value ? "estimated-value-of-contract" : undefined,
      notes: detail.notes,
      contractStartDate: detail.contractStartDate,
      contractDuration: detail.contractDuration,
      deadlineBasis: "listing-deadline-europe-london",
      coverage: "public-non-framework",
      activityType: marketEngagement ? "early-market-engagement" : "competition",
    },
  };
}

function sourceError(status: number): SourceScanError {
  if (status === 429) return new SourceScanError("rate_limited", "FCDO Jaggaer rate-limited the public scan.", true);
  if (status === 401 || status === 403) return new SourceScanError("access_denied", "FCDO Jaggaer denied access to its public opportunities.", false);
  return new SourceScanError(status >= 500 ? "source_unavailable" : "request_rejected", `FCDO Jaggaer request failed with HTTP ${status}.`, status >= 500);
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timeout); reject(signal.reason); }, { once: true });
  });
}

export function createFcdoJaggaerPublicAdapter(options: FcdoJaggaerPublicAdapterOptions = {}): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const delay = options.requestDelayMs ?? 250;
  if (!Number.isInteger(delay) || delay < 0 || delay > 5_000) throw new Error("FCDO Jaggaer requestDelayMs must be between 0 and 5,000 milliseconds");
  return {
    definition: fcdoJaggaerPublicSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      const cookies = new Map<string, string>();
      let requestCount = 0;
      const request = async (url: string | URL) => {
        if (requestCount++) await sleep(delay, context.signal);
        let response: Response;
        try {
          response = await fetcher(url, {
            headers: { Accept: "text/html", "User-Agent": USER_AGENT, ...(cookies.size ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") } : {}) },
            redirect: "manual",
            signal: context.signal,
          });
        } catch {
          throw new SourceScanError("source_unavailable", "FCDO Jaggaer request failed before a response was received.", true);
        }
        const setCookie = response.headers.get("set-cookie") ?? "";
        for (const match of setCookie.matchAll(/(?:^|,\s*)([A-Za-z0-9_-]+)=([^;,]*)/g)) {
          if (ALLOWED_COOKIE.test(match[1]) && match[2]) cookies.set(match[1], match[2]);
        }
        return response;
      };

      const entry = await request(ENTRY_URL);
      if (![301, 302, 303, 307, 308].includes(entry.status)) {
        if (!entry.ok) throw sourceError(entry.status);
        throw new SourceScanError("invalid_session", "FCDO Jaggaer did not establish a public visitor session.", true);
      }
      const listUrl = new URL(entry.headers.get("location") ?? "", ENTRY_URL);
      if (listUrl.origin !== BASE_URL || listUrl.pathname !== LIST_PATH || !cookies.has("VISITORID")) {
        throw new SourceScanError("invalid_session", "FCDO Jaggaer returned an invalid public visitor session.", true);
      }
      const listResponse = await request(listUrl);
      if (!listResponse.ok) throw sourceError(listResponse.status);
      const records = (await parseList(listResponse)).filter(({ workCategory }) => workCategory.toLocaleLowerCase() === "services");
      const discoveredAt = context.now.toISOString();
      const candidates: SourceCandidate[] = [];
      for (const record of records) {
        const detailUrl = new URL(`/esop/toolkit/opportunity/current/${record.opportunityId}/detail.si`, BASE_URL);
        const detailResponse = await request(detailUrl);
        if (!detailResponse.ok) throw sourceError(detailResponse.status);
        const mapped = candidate(record, await parseDetail(detailResponse, record.opportunityId), discoveredAt);
        if (mapped) candidates.push(mapped);
      }
      return { candidates, nextCursor: { value: discoveredAt } };
    },
  };
}
