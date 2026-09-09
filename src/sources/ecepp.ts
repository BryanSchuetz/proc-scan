import type {
  SourceAdapter,
  SourceCandidate,
  SourceDefinition,
  SourceScanContext,
  SourceScanResult,
} from "./adapter";
import { SourceScanError } from "./adapter";

const SEARCH_URL = "https://ecepp.ebrd.com/delta/noticeSearchResults.html";
const DETAIL_URL = "https://ecepp.ebrd.com/delta/viewNotice.html";
const USER_AGENT = "proc-scan/1.0 (+https://github.com/BryanSchuetz/proc-scan)";
const MAX_RECORDS = 5_000;
const MAX_ENRICHMENTS = 250;
const ENRICHMENT_CONCURRENCY = 5;
const RETAINED_NOTICE_TYPES = [
  "general procurement notice",
  "invitation for expression interest",
  "invitation for prequalification",
  "invitation for tenders single",
  "invitation for tenders two stage",
  "request for proposals",
  "ebrd contract notice addendum",
];

interface CellBuffer {
  text: string[];
  href?: string;
}

interface RowBuffer {
  cells: CellBuffer[];
}

interface EceppListing {
  displayNoticeId: string;
  title: string;
  noticeType: string;
  exerciseTitle?: string;
  published: string;
  closing?: string;
  state: string;
  metadata: string;
}

interface EceppDetail {
  fields: Map<string, string>;
  bodyText: string;
}

export const eceppSourceDefinition: SourceDefinition = {
  id: "ecepp",
  name: "EBRD ECEPP",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface EceppAdapterOptions {
  fetch?: typeof fetch;
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function append(parts: string[] | undefined, text: { text: string; lastInTextNode: boolean }): void {
  if (!parts) return;
  parts.push(text.text);
  if (text.lastInTextNode) parts.push(" ");
}

async function parseSearchPage(response: Response): Promise<EceppListing[]> {
  const rows: RowBuffer[] = [];
  const headings: string[][] = [];
  let headingParts: string[] | undefined;
  let currentRow: RowBuffer | undefined;
  let currentCell: CellBuffer | undefined;

  const transformed = new HTMLRewriter()
    .on("h1, h2", {
      element(element) {
        headingParts = [];
        headings.push(headingParts);
        element.onEndTag(() => {
          headingParts = undefined;
        });
      },
      text(text) {
        append(headingParts, text);
      },
    })
    .on("table tr", {
      element(element) {
        const row = { cells: [] };
        currentRow = row;
        element.onEndTag(() => {
          rows.push(row);
          if (currentRow === row) currentRow = undefined;
        });
      },
    })
    .on("table th, table td", {
      element(element) {
        if (!currentRow) return;
        const cell = { text: [] };
        currentCell = cell;
        currentRow.cells.push(cell);
        element.onEndTag(() => {
          if (currentCell === cell) currentCell = undefined;
        });
      },
      text(text) {
        append(currentCell?.text, text);
      },
    })
    .on("table td a[href]", {
      element(element) {
        if (currentCell && !currentCell.href) currentCell.href = element.getAttribute("href") ?? undefined;
      },
    })
    .transform(response);
  await transformed.arrayBuffer();

  if (!headings.some((parts) =>
    normalizedText(parts.join(""))?.toLocaleLowerCase() === "search opportunities"
  )) {
    throw new SourceScanError("invalid_response", "ECEPP returned an unexpected search page.", true);
  }

  const headerIndex = rows.findIndex(({ cells }) =>
    cells.slice(0, 6).map(({ text }) => normalizedText(text.join(""))?.toLocaleLowerCase()).join("|") ===
      "title|notice type|procurement exercise title|published|closing date|current state"
  );
  if (headerIndex < 0) {
    throw new SourceScanError("invalid_response", "ECEPP search results are missing expected columns.", true);
  }

  const listings: EceppListing[] = [];
  for (const { cells } of rows.slice(headerIndex + 1)) {
    if (cells.length < 6) continue;
    const href = cells[0].href;
    const id = href && /[?&]displayNoticeId=(\d+)/.exec(href)?.[1];
    if (!id) continue;
    const values = cells.map(({ text }) => normalizedText(text.join("")) ?? "");
    listings.push({
      displayNoticeId: id,
      title: values[0],
      noticeType: values[1],
      exerciseTitle: values[2] === "N/A" ? undefined : values[2],
      published: values[3].replace(/\s*UK Time$/i, ""),
      closing: values[4] === "N/A" ? undefined : values[4].replace(/\s*UK Time$/i, ""),
      state: values[5],
      metadata: values.slice(6).join(" "),
    });
  }
  if (listings.length > MAX_RECORDS) {
    throw new SourceScanError("invalid_response", "ECEPP returned more notices than the supported snapshot limit.", true);
  }
  if (new Set(listings.map(({ displayNoticeId }) => displayNoticeId)).size !== listings.length) {
    throw new SourceScanError("invalid_response", "ECEPP returned duplicate notice identifiers.", true);
  }
  return listings;
}

async function parseDetailPage(response: Response): Promise<EceppDetail> {
  const fields = new Map<string, string>();
  let currentRow: { cells: string[][] } | undefined;
  let currentCell: string[] | undefined;
  const bodyParts: string[] = [];
  const transformed = new HTMLRewriter()
    .on("body", { text(text) { append(bodyParts, text); } })
    .on("table tr", {
      element(element) {
        const row = { cells: [] as string[][] };
        currentRow = row;
        element.onEndTag(() => {
          const label = normalizedText(row.cells[0]?.join(""))?.replace(/:\s*$/, "");
          const value = normalizedText(row.cells.slice(1).flat().join(""));
          if (label && value) fields.set(label.toLocaleLowerCase(), value);
          if (currentRow === row) currentRow = undefined;
        });
      },
    })
    .on("table th, table td", {
      element(element) {
        if (!currentRow) return;
        const cell: string[] = [];
        currentCell = cell;
        currentRow.cells.push(cell);
        element.onEndTag(() => {
          if (currentCell === cell) currentCell = undefined;
        });
      },
      text(text) { append(currentCell, text); },
    })
    .transform(response);
  await transformed.arrayBuffer();
  if (!fields.has("project name") || !fields.has("notice type")) {
    throw new SourceScanError("invalid_response", "ECEPP returned an unexpected notice page.", true);
  }
  return { fields, bodyText: normalizedText(bodyParts.join("")) ?? "" };
}

function londonDate(value: string | undefined, noticeId: string, label: string): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new SourceScanError("invalid_record", `ECEPP notice ${noticeId} contains an invalid ${label}.`, true);
  const [day, month, year, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59) {
    throw new SourceScanError("invalid_record", `ECEPP notice ${noticeId} contains an invalid ${label}.`, true);
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const wallTime = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(instant)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, Number(part)]));
    instant += wallTime - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  }
  return new Date(instant).toISOString();
}

function parsedProjectValue(detail: EceppDetail): { amount: number; currency: string } | undefined {
  const match = /Estimated Total Project Value\s+([\d,.]+)\s+Currency\s+([A-Z]{3})\b/i.exec(detail.bodyText);
  if (!match) return undefined;
  const amount = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return { amount, currency: match[2].toUpperCase() };
}

function isInScope(listing: EceppListing, now: Date): boolean {
  const state = listing.state.toLocaleLowerCase();
  const noticeType = listing.noticeType.toLocaleLowerCase();
  const searchable = `${listing.title} ${listing.exerciseTitle ?? ""} ${listing.metadata}`.toLocaleLowerCase();
  const closing = londonDate(listing.closing, listing.displayNoticeId, "closing date");
  return closing !== undefined && closing > now.toISOString() &&
    state !== "closed" && RETAINED_NOTICE_TYPES.includes(noticeType) &&
    (/\bconsultancy\b/.test(searchable) || /\b(?:advisory|consultant|consulting)\b/.test(searchable));
}

function candidateFromDetail(listing: EceppListing, detail: EceppDetail, discoveredAt: string): SourceCandidate | undefined {
  const field = (name: string) => detail.fields.get(name);
  const procurementType = field("type of procurement");
  const description = field("procurement exercise description");
  const title = field("procurement exercise name") ?? listing.exerciseTitle ?? listing.title;
  if (procurementType?.toLocaleLowerCase() !== "consultancy" &&
      !/\b(?:advisory|consultancy|consultant|consulting)\b/i.test(`${title} ${description ?? ""}`)) return undefined;
  const projectValue = parsedProjectValue(detail);
  const opportunityId = field("ecepp id") ?? field("ebrd project id") ?? listing.displayNoticeId;
  const eventType = /addendum/i.test(listing.noticeType) ? "modification" : "tender";
  const canonicalUrl = `${DETAIL_URL}?displayNoticeId=${listing.displayNoticeId}`;
  return {
    sourceId: eceppSourceDefinition.id,
    sourceEventId: listing.displayNoticeId,
    sourceOpportunityId: opportunityId,
    canonicalUrl,
    originalEventType: listing.noticeType,
    eventType,
    isFormalAmendment: eventType === "modification",
    publishedAt: londonDate(field("publication date") ?? listing.published, listing.displayNoticeId, "publication date"),
    discoveredAt,
    opportunityName: title,
    description,
    clientName: "EBRD",
    funderNames: ["European Bank for Reconstruction and Development"],
    procuringEntityName: field("client name"),
    dueDate: londonDate(field("closing date") ?? listing.closing, listing.displayNoticeId, "closing date"),
    placeOfPerformance: field("country") ? { description: field("country") } : undefined,
    sourceStatus: listing.state,
    documents: [{ id: `ecepp-notice-${listing.displayNoticeId}`, title: listing.title, url: canonicalUrl, documentType: listing.noticeType }],
    sourceData: {
      ebrdProjectId: field("ebrd project id"),
      eceppId: field("ecepp id"),
      projectName: field("project name"),
      procurementType,
      procurementMethod: field("procurement method"),
      businessSector: field("business sector"),
      projectValue,
    },
  };
}

function errorForStatus(status: number): SourceScanError {
  if (status === 429) return new SourceScanError("rate_limited", "ECEPP rejected the scan because its request limit was reached.", true);
  if (status === 401 || status === 403) return new SourceScanError("access_denied", "ECEPP denied access to its public procurement notices.", false);
  return new SourceScanError(status >= 500 ? "source_unavailable" : "request_rejected", `ECEPP request failed with HTTP ${status}.`, status >= 500);
}

export function createEceppAdapter(options: EceppAdapterOptions = {}): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  const get = async (url: string, signal: AbortSignal) => {
    let response: Response;
    try {
      response = await fetcher(url, { headers: { Accept: "text/html", "User-Agent": USER_AGENT }, redirect: "follow", signal });
    } catch {
      throw new SourceScanError("source_unavailable", "ECEPP request failed before a response was received.", true);
    }
    if (!response.ok) throw errorForStatus(response.status);
    if (!response.headers.get("content-type")?.toLocaleLowerCase().includes("text/html")) {
      throw new SourceScanError("invalid_response", "ECEPP returned a non-HTML response.", true);
    }
    return response;
  };

  return {
    definition: eceppSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      const scoped = (await parseSearchPage(await get(SEARCH_URL, context.signal)))
        .filter((listing) => isInScope(listing, context.now));
      if (scoped.length > MAX_ENRICHMENTS) {
        throw new SourceScanError("invalid_response", "ECEPP returned more in-scope notices than the supported enrichment limit.", true);
      }
      const candidates: SourceCandidate[] = [];
      for (let offset = 0; offset < scoped.length; offset += ENRICHMENT_CONCURRENCY) {
        const batch = scoped.slice(offset, offset + ENRICHMENT_CONCURRENCY);
        const details = await Promise.all(batch.map(({ displayNoticeId }) =>
          get(`${DETAIL_URL}?displayNoticeId=${displayNoticeId}`, context.signal).then(parseDetailPage)
        ));
        batch.forEach((listing, index) => {
          const candidate = candidateFromDetail(listing, details[index], context.now.toISOString());
          if (candidate) candidates.push(candidate);
        });
      }
      candidates.sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "") || (a.sourceEventId ?? "").localeCompare(b.sourceEventId ?? ""));
      return { candidates, nextCursor: { value: context.now.toISOString() } };
    },
  };
}
