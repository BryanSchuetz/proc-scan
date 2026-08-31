import type {
  SourceAdapter,
  SourceCandidate,
  SourceDefinition,
  SourceScanContext,
  SourceScanResult,
} from "./adapter";
import { SourceScanError } from "./adapter";

const PAGE_URL = "https://www.fmo.nl/open-tenders";
const USER_AGENT = "proc-scan/1.0 (+https://github.com/BryanSchuetz/proc-scan)";
const CLIENT_NAME = "FMO";
const MONTHS = new Map([
  ["january", 0],
  ["february", 1],
  ["march", 2],
  ["april", 3],
  ["may", 4],
  ["june", 5],
  ["july", 6],
  ["august", 7],
  ["september", 8],
  ["october", 9],
  ["november", 10],
  ["december", 11],
]);
const FIELD_LABELS = [
  "Reference number",
  "Procurement method",
  "Contract name",
  "Publication date",
  "Submission deadline",
  "Original language",
] as const;

interface ArticleBuffer {
  headings: string[][];
  paragraphs: string[][];
}

interface FmoRecord {
  referenceNumber: string;
  procurementMethod?: string;
  contractName?: string;
  publicationDate?: string;
  submissionDeadline?: string;
  originalLanguage?: string;
  pageHeading: string;
  description?: string;
  rawText: string;
}

interface ParsedBudget {
  amount: number;
  currency: string;
  raw: string;
}

export const fmoSourceDefinition: SourceDefinition = {
  id: "fmo",
  name: "FMO Open Tenders",
  accessMode: "public",
  phase: 1,
  adapterVersion: "1.0.0",
};

export interface FmoAdapterOptions {
  fetch?: typeof fetch;
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&rsquo;/gi, "’")
    .replace(/&larr;/gi, "←")
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

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "\\s+");
}

function fieldValue(paragraphs: readonly string[], label: typeof FIELD_LABELS[number]): string | undefined {
  const pattern = new RegExp(`^${escapedPattern(label)}\\s*:\\s*(.+)$`, "i");
  for (const paragraph of paragraphs) {
    const value = normalizedText(pattern.exec(paragraph)?.[1]);
    if (value) return value;
  }
  return undefined;
}

function isFieldParagraph(paragraph: string): boolean {
  return FIELD_LABELS.some((label) =>
    new RegExp(`^${escapedPattern(label)}\\s*:`, "i").test(paragraph)
  );
}

function normalizedReference(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function recordFromArticle(article: ArticleBuffer): FmoRecord | undefined {
  const headings = article.headings
    .map((parts) => normalizedText(parts.join("")))
    .filter((value): value is string => value !== undefined);
  const paragraphs = article.paragraphs
    .map((parts) => normalizedText(parts.join("")))
    .filter((value): value is string => value !== undefined);
  const referenceNumber = fieldValue(paragraphs, "Reference number");
  const tenderLike = FIELD_LABELS.slice(1).some((label) => fieldValue(paragraphs, label));
  if (!referenceNumber) {
    if (tenderLike) {
      throw new SourceScanError(
        "invalid_record",
        "FMO returned a tender without a reference number.",
        true,
      );
    }
    return undefined;
  }
  if (!headings[0]) {
    throw new SourceScanError(
      "invalid_record",
      `FMO tender ${normalizedReference(referenceNumber)} is missing its heading.`,
      true,
    );
  }

  const description = paragraphs
    .filter((paragraph) => !isFieldParagraph(paragraph))
    .filter((paragraph) => !/^(?:all communication|q\s*&\s*a\b|answers to|access the contract award notice|back to\s*:)/i.test(paragraph))
    .filter((paragraph) => !/^(?:conr?act award notice|prior information notice)/i.test(paragraph))
    .join("\n");
  return {
    referenceNumber: normalizedReference(referenceNumber),
    procurementMethod: fieldValue(paragraphs, "Procurement method"),
    contractName: fieldValue(paragraphs, "Contract name"),
    publicationDate: fieldValue(paragraphs, "Publication date"),
    submissionDeadline: fieldValue(paragraphs, "Submission deadline"),
    originalLanguage: fieldValue(paragraphs, "Original language"),
    pageHeading: headings[0],
    description: normalizedText(description),
    rawText: paragraphs.join("\n"),
  };
}

async function parsePage(response: Response): Promise<FmoRecord[]> {
  const records: FmoRecord[] = [];
  let pageTitleParts: string[] | undefined;
  let currentArticle: ArticleBuffer | undefined;
  let currentHeadingParts: string[] | undefined;
  let currentParagraphParts: string[] | undefined;

  const transformed = new HTMLRewriter()
    .on("h1.page__title", {
      element() {
        pageTitleParts = [];
      },
      text(text) {
        appendText(pageTitleParts, text);
      },
    })
    .on(".at-asideArticle__content", {
      element(element) {
        const article: ArticleBuffer = { headings: [], paragraphs: [] };
        currentArticle = article;
        element.onEndTag(() => {
          const record = recordFromArticle(article);
          if (record) records.push(record);
          if (currentArticle === article) currentArticle = undefined;
        });
      },
    })
    .on(".at-asideArticle__content h2, .at-asideArticle__content h3", {
      element(element) {
        if (!currentArticle) return;
        currentHeadingParts = [];
        currentArticle.headings.push(currentHeadingParts);
        element.onEndTag(() => {
          currentHeadingParts = undefined;
        });
      },
      text(text) {
        appendText(currentHeadingParts, text);
      },
    })
    .on(".at-asideArticle__content p", {
      element(element) {
        if (!currentArticle) return;
        currentParagraphParts = [];
        currentArticle.paragraphs.push(currentParagraphParts);
        element.onEndTag(() => {
          currentParagraphParts = undefined;
        });
      },
      text(text) {
        appendText(currentParagraphParts, text);
      },
    })
    .transform(response);
  await transformed.arrayBuffer();

  if (normalizedText(pageTitleParts?.join(""))?.toLocaleLowerCase() !== "open tenders") {
    throw new SourceScanError(
      "invalid_response",
      "FMO returned an unexpected Open Tenders page.",
      true,
    );
  }
  const references = records.map(({ referenceNumber }) => referenceNumber.toLocaleLowerCase());
  if (new Set(references).size !== references.length) {
    throw new SourceScanError(
      "invalid_response",
      "FMO returned duplicate tender reference numbers.",
      true,
    );
  }
  return records;
}

function parsedDate(value: string | undefined, referenceNumber: string, label: string): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2})\s*(CET|CEST|UTC))?$/.exec(value);
  const month = match ? MONTHS.get(match[2].toLocaleLowerCase()) : undefined;
  if (!match || month === undefined) {
    throw new SourceScanError(
      "invalid_record",
      `FMO tender ${referenceNumber} contains an invalid ${label}.`,
      true,
    );
  }
  const day = Number(match[1]);
  const year = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const offsetHours = match[6] === "CEST" ? 2 : match[6] === "CET" ? 1 : 0;
  const date = new Date(Date.UTC(year, month, day, hour - offsetHours, minute));
  if (
    day < 1 || day > new Date(Date.UTC(year, month + 1, 0)).getUTCDate() ||
    hour > 23 || minute > 59
  ) {
    throw new SourceScanError(
      "invalid_record",
      `FMO tender ${referenceNumber} contains an invalid ${label}.`,
      true,
    );
  }
  return date.toISOString();
}

function parsedAmount(value: string): number | undefined {
  const compact = value.replace(/\s+/g, "");
  if (/^\d{1,3}(?:[,.]\d{3})+$/.test(compact)) {
    return Number(compact.replace(/[,.]/g, ""));
  }
  const normalized = compact.includes(",") && !compact.includes(".")
    ? compact.replace(",", ".")
    : compact.replaceAll(",", "");
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function budgetFromRecord(record: FmoRecord): ParsedBudget | undefined {
  const budgetStart = record.rawText.search(/(?:total\s+)?maximum budget/i);
  if (budgetStart < 0) return undefined;
  const budgetText = record.rawText.slice(budgetStart, budgetStart + 180);
  const currencyFirst = /\b(EUR|USD|GBP)\s*([\d](?:[\d.,\s]*\d)?)/i.exec(budgetText);
  const amountFirst = /([\d](?:[\d.,\s]*\d)?)\s*(EUR|USD|GBP)\b/i.exec(budgetText);
  const rawAmount = currencyFirst?.[2] ?? amountFirst?.[1];
  const currency = (currencyFirst?.[1] ?? amountFirst?.[2])?.toUpperCase();
  const amount = rawAmount ? parsedAmount(rawAmount) : undefined;
  if (amount === undefined || !currency) return undefined;
  if (amount === 0) return undefined;
  return {
    amount,
    currency,
    raw: normalizedText(currencyFirst?.[0] ?? amountFirst?.[0]) as string,
  };
}

function candidateFromRecord(record: FmoRecord, discoveredAt: string): SourceCandidate {
  const budget = budgetFromRecord(record);
  const publishedAt = parsedDate(record.publicationDate, record.referenceNumber, "publication date");
  const dueDate = parsedDate(record.submissionDeadline, record.referenceNumber, "submission deadline");
  return {
    sourceId: fmoSourceDefinition.id,
    sourceEventId: record.referenceNumber,
    sourceOpportunityId: record.referenceNumber,
    canonicalUrl: PAGE_URL,
    originalEventType: record.procurementMethod,
    eventType: "tender",
    publishedAt,
    discoveredAt,
    opportunityName: record.contractName ?? record.pageHeading,
    description: record.description,
    clientName: CLIENT_NAME,
    procuringEntityName: CLIENT_NAME,
    value: budget ? { amount: budget.amount, currency: budget.currency } : undefined,
    dueDate,
    sourceStatus: "listed-open",
    documents: [{
      id: `fmo-open-tenders-${record.referenceNumber}`,
      title: record.pageHeading,
      url: PAGE_URL,
      documentType: record.procurementMethod,
    }],
    sourceData: {
      referenceNumber: record.referenceNumber,
      pageHeading: record.pageHeading,
      contractName: record.contractName,
      procurementMethod: record.procurementMethod,
      originalLanguage: record.originalLanguage,
      rawMaximumBudget: budget?.raw,
      valueBasis: budget ? "maximum-budget" : undefined,
      publicationDateBasis: publishedAt ? "publication-date" : undefined,
      deadlineBasis: dueDate ? "submission-deadline" : undefined,
    },
  };
}

function sourceErrorForStatus(status: number): SourceScanError {
  if (status === 429) {
    return new SourceScanError(
      "rate_limited",
      "FMO rejected the scan because its request limit was reached.",
      true,
    );
  }
  if (status === 401 || status === 403) {
    return new SourceScanError(
      "access_denied",
      "FMO denied access to its public Open Tenders page.",
      false,
    );
  }
  return new SourceScanError(
    status >= 500 ? "source_unavailable" : "request_rejected",
    `FMO Open Tenders request failed with HTTP ${status}.`,
    status >= 500,
  );
}

export function createFmoAdapter(options: FmoAdapterOptions = {}): SourceAdapter {
  const fetcher = options.fetch ?? fetch;
  return {
    definition: fmoSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      let response: Response;
      try {
        response = await fetcher(PAGE_URL, {
          headers: {
            Accept: "text/html",
            "User-Agent": USER_AGENT,
          },
          redirect: "follow",
          signal: context.signal,
        });
      } catch {
        throw new SourceScanError(
          "source_unavailable",
          "FMO Open Tenders request failed before a response was received.",
          true,
        );
      }
      if (!response.ok) throw sourceErrorForStatus(response.status);
      if (!response.headers.get("content-type")?.toLocaleLowerCase().includes("text/html")) {
        throw new SourceScanError(
          "invalid_response",
          "FMO returned a non-HTML Open Tenders response.",
          true,
        );
      }

      const discoveredAt = context.now.toISOString();
      const candidates = (await parsePage(response))
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
