import type {
  SourceAdapter,
  SourceCandidate,
  SourceDefinition,
  SourceScanContext,
  SourceScanResult,
} from "./adapter";
import { SourceScanError } from "./adapter";

const CSV_ENDPOINT = "https://atamis-9529.my.salesforce-sites.com/ProSpend__CS_DownloadCSV?SearchType=Projects&searchStr=&sortStr=Recently+Published&page=1&filters=&County=";
const CATALOGUE_URL = "https://atamis-9529.my.salesforce-sites.com/";
const USER_AGENT = "proc-scan/1.0 (+https://github.com/BryanSchuetz/proc-scan)";
const CLIENT_NAME = "DEFRA";
const MAX_RECORDS = 5_000;
const MAX_RESPONSE_CHARACTERS = 4_000_000;
const EXPECTED_HEADERS = [
  "Name",
  "Ref",
  "Description",
  "Category",
  "Open On (dd/mm/yyyy)",
  "Response Deadline (dd/mm/yyyy)",
  "Published Date (dd/mm/yyyy)",
  "Time Remaining",
] as const;

interface AtamisRecord {
  name: string;
  reference: string;
  description?: string;
  category?: string;
  opensOn?: string;
  responseDeadline: string;
  publishedDate: string;
  timeRemaining: string;
}

interface ParsedDate {
  date: string;
  instant: string;
}

export const atamisDefraSourceDefinition: SourceDefinition = {
  id: "atamis-defra",
  name: "DEFRA Atamis",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface AtamisDefraAdapterOptions {
  fetch?: typeof fetch;
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function invalidCsv(message: string): SourceScanError {
  return new SourceScanError("invalid_response", message, true);
}

function parseCsv(raw: string): string[][] {
  const text = raw.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;

  const finishField = () => {
    row.push(field);
    field = "";
    quoteClosed = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') {
        field += character;
        continue;
      }
      if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
        quoteClosed = true;
      }
      continue;
    }

    if (character === '"') {
      if (field || quoteClosed) throw invalidCsv("DEFRA Atamis returned malformed CSV quoting.");
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n" || character === "\r") {
      finishRow();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      if (quoteClosed) throw invalidCsv("DEFRA Atamis returned characters after a quoted CSV field.");
      field += character;
    }
  }

  if (quoted) throw invalidCsv("DEFRA Atamis returned an unterminated quoted CSV field.");
  if (field || quoteClosed || row.length > 0) finishRow();
  while (rows.at(-1)?.every((value) => value === "")) rows.pop();
  return rows;
}

function parsedDate(value: string, reference: string, label: string): ParsedDate {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) {
    throw new SourceScanError(
      "invalid_record",
      `DEFRA Atamis opportunity ${reference} contains an invalid ${label}.`,
      true,
    );
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    month < 1 || month > 12 || day < 1 ||
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
  ) {
    throw new SourceScanError(
      "invalid_record",
      `DEFRA Atamis opportunity ${reference} contains an invalid ${label}.`,
      true,
    );
  }
  const datePart = `${match[3]}-${match[2]}-${match[1]}`;
  return { date: datePart, instant: `${datePart}T00:00:00.000Z` };
}

function ukCalendarDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function recordsFromCsv(raw: string, now: Date): AtamisRecord[] {
  if (raw.length > MAX_RESPONSE_CHARACTERS) {
    throw invalidCsv("DEFRA Atamis returned a CSV response above the supported size limit.");
  }
  const rows = parseCsv(raw);
  const headers = rows.shift();
  if (!headers || headers.length !== EXPECTED_HEADERS.length ||
    headers.some((header, index) => header !== EXPECTED_HEADERS[index])) {
    throw invalidCsv("DEFRA Atamis returned unexpected CSV columns.");
  }
  if (rows.length > MAX_RECORDS) {
    throw invalidCsv("DEFRA Atamis returned more opportunities than the supported snapshot limit.");
  }

  const records: AtamisRecord[] = [];
  const references = new Set<string>();
  const today = ukCalendarDate(now);
  rows.forEach((values, index) => {
    if (values.length !== EXPECTED_HEADERS.length) {
      throw invalidCsv(`DEFRA Atamis returned an invalid CSV row at record ${index + 1}.`);
    }
    const [nameRaw, referenceRaw, descriptionRaw, categoryRaw, opensOnRaw, deadlineRaw, publishedRaw, timeRemainingRaw] = values;
    const name = normalizedText(nameRaw);
    const reference = normalizedText(referenceRaw);
    const timeRemaining = normalizedText(timeRemainingRaw);
    if (!name || !reference?.match(/^C\d+$/) || !timeRemaining) {
      throw invalidCsv(`DEFRA Atamis returned an incomplete opportunity at record ${index + 1}.`);
    }
    if (references.has(reference)) {
      throw invalidCsv(`DEFRA Atamis returned duplicate opportunity reference ${reference}.`);
    }
    references.add(reference);

    if (timeRemaining.toLocaleLowerCase() === "closed") return;
    const responseDeadline = normalizedText(deadlineRaw);
    const publishedDate = normalizedText(publishedRaw);
    if (!responseDeadline || !publishedDate) return;
    if (parsedDate(responseDeadline, reference, "response deadline").date < today) return;
    parsedDate(publishedDate, reference, "published date");
    const opensOn = normalizedText(opensOnRaw);
    if (opensOn) parsedDate(opensOn, reference, "opening date");

    records.push({
      name,
      reference,
      description: normalizedText(descriptionRaw),
      category: normalizedText(categoryRaw),
      opensOn,
      responseDeadline,
      publishedDate,
      timeRemaining,
    });
  });
  return records;
}

function opportunityUrl(reference: string): string {
  const url = new URL(CATALOGUE_URL);
  url.searchParams.set("SearchType", "Projects");
  url.searchParams.set("searchStr", reference);
  url.searchParams.set("sortStr", "Recently Published");
  return url.toString();
}

function candidateFromRecord(record: AtamisRecord, discoveredAt: string): SourceCandidate {
  const canonicalUrl = opportunityUrl(record.reference);
  const published = parsedDate(record.publishedDate, record.reference, "published date");
  const deadline = parsedDate(record.responseDeadline, record.reference, "response deadline");
  return {
    sourceId: atamisDefraSourceDefinition.id,
    sourceEventId: record.reference,
    sourceOpportunityId: record.reference,
    canonicalUrl,
    originalEventType: "Atamis opportunity",
    eventType: "tender",
    publishedAt: published.instant,
    discoveredAt,
    opportunityName: record.name,
    description: record.description,
    clientName: CLIENT_NAME,
    dueDate: deadline.instant,
    sourceStatus: record.timeRemaining,
    documents: [{
      id: `atamis-defra-${record.reference}`,
      title: "DEFRA Atamis opportunity",
      url: canonicalUrl,
      documentType: "opportunity",
    }],
    sourceData: {
      reference: record.reference,
      category: record.category,
      opensOn: record.opensOn,
      responseDeadline: record.responseDeadline,
      publishedDate: record.publishedDate,
      timeRemaining: record.timeRemaining,
      clientMappingBasis: "defra-atamis-catalogue",
      publicationDateBasis: "published-date",
      deadlineBasis: "response-deadline-date",
    },
  };
}

function sourceErrorForStatus(status: number): SourceScanError {
  if (status === 429) {
    return new SourceScanError(
      "rate_limited",
      "DEFRA Atamis rejected the scan because its request limit was reached.",
      true,
    );
  }
  if (status === 401 || status === 403) {
    return new SourceScanError(
      "access_denied",
      "DEFRA Atamis denied access to its public opportunity catalogue.",
      false,
    );
  }
  return new SourceScanError(
    status >= 500 ? "source_unavailable" : "request_rejected",
    `DEFRA Atamis catalogue request failed with HTTP ${status}.`,
    status >= 500,
  );
}

export function createAtamisDefraAdapter(options: AtamisDefraAdapterOptions = {}): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  return {
    definition: atamisDefraSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      let response: Response;
      try {
        response = await fetcher(CSV_ENDPOINT, {
          headers: {
            Accept: "text/csv, application/vnd.ms-excel",
            "User-Agent": USER_AGENT,
          },
          redirect: "follow",
          signal: context.signal,
        });
      } catch {
        throw new SourceScanError(
          "source_unavailable",
          "DEFRA Atamis catalogue request failed before a response was received.",
          true,
        );
      }
      if (!response.ok) throw sourceErrorForStatus(response.status);
      const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
      if (!contentType.includes("text/csv") && !contentType.includes("application/vnd.ms-excel")) {
        throw invalidCsv("DEFRA Atamis returned a non-CSV catalogue response.");
      }

      const discoveredAt = context.now.toISOString();
      const csv = new TextDecoder().decode(await response.arrayBuffer());
      const candidates = recordsFromCsv(csv, context.now)
        .map((record) => candidateFromRecord(record, discoveredAt))
        .sort((a, b) =>
          (a.publishedAt ?? discoveredAt).localeCompare(b.publishedAt ?? discoveredAt) ||
          (a.sourceEventId ?? "").localeCompare(b.sourceEventId ?? ""),
        );
      return {
        candidates,
        nextCursor: { value: discoveredAt },
      };
    },
  };
}
