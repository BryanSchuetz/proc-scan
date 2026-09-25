import { unzipSync } from "fflate";
import { read, SSF, utils, write } from "xlsx";
import { biddingEventTypes } from "../domain/types";
import type { SourceCandidate } from "../sources/adapter";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 500;
export const uploadColumns = [
  "Title", "URL", "Opportunity ID", "Event ID", "Client", "Description",
  "Due date", "Published date", "Amount", "Currency", "Place", "Country code", "Event type",
] as const;

export class UploadValidationError extends Error {}

function fail(message: string): never {
  throw new UploadValidationError(message);
}

export function spreadsheetTemplate(): Uint8Array<ArrayBuffer> {
  const workbook = utils.book_new();
  const sheet = utils.aoa_to_sheet([[...uploadColumns]]);
  sheet["!cols"] = uploadColumns.map((name) => ({ wch: name === "Description" ? 50 : 24 }));
  utils.book_append_sheet(workbook, sheet, "Opportunities");
  return new Uint8Array(write(workbook, { type: "array", bookType: "xlsx" }));
}

function dateValue(value: unknown, label: string, date1904: boolean): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "number") {
    const excel = SSF.parse_date_code(value, { date1904 });
    if (!excel || excel.d < 1 || (excel.y === 1900 && excel.m === 2 && excel.d === 29)) fail(`${label}: invalid date.`);
    return new Date(Date.UTC(excel.y, excel.m - 1, excel.d, excel.H, excel.M, excel.S, Math.round(excel.u * 1000))).toISOString();
  }
  const text = String(value).trim();
  const iso = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/i.exec(text);
  if (iso) {
    const midnight = new Date(`${iso[1]}T00:00:00.000Z`);
    const parsed = new Date(text.length === 10 ? `${text}T00:00:00.000Z` : iso[2] ? text : `${text}Z`);
    if (!Number.isFinite(parsed.getTime()) || !Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== iso[1]) {
      fail(`${label}: invalid date.`);
    }
    return parsed.toISOString();
  }
  // Spreadsheet exports commonly store displayed dates as text. JavaScript's
  // parser treats ambiguous numeric dates as month/day/year, matching this UI's locale.
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) fail(`${label}: use a recognizable date.`);
  return parsed.toISOString();
}

export function parseSpreadsheet(bytes: Uint8Array, sourceId: string, filename = "opportunities.xlsx"): SourceCandidate[] {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) fail("Choose an .xls, .xlsx, or .csv file up to 2 MB.");
  const extension = filename.split(".").pop()?.toLowerCase();
  let workbook;
  try {
    if (extension === "csv") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) fail("Save CSV files as UTF-8 text.");
      // Keep IDs and dates as text: automatic coercion loses leading zeros and
      // guesses ambiguous date formats. Parse all rows so limits cannot truncate silently.
      workbook = read(text, { type: "string", raw: true, FS: "," });
    } else {
      if (extension === "xlsx") {
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail("Choose a valid .xlsx workbook, not a renamed CSV or .xls file.");
        let expandedSize = 0;
        // Inspect ZIP entry sizes without inflating them before handing the file to the parser.
        unzipSync(bytes, { filter: (entry) => {
          expandedSize += entry.originalSize;
          if (expandedSize > 20 * 1024 * 1024) fail("The expanded workbook exceeds 20 MB. Remove unused sheets and formatting.");
          return false;
        } });
      } else if (extension === "xls") {
        const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
        if (!signature.every((byte, index) => bytes[index] === byte)) fail("Choose a valid Excel .xls workbook, not a renamed text or HTML file.");
      } else {
        fail("Choose an .xls, .xlsx, or .csv file.");
      }
      workbook = read(bytes, { type: "array", cellDates: true, sheetRows: MAX_ROWS + 2 });
    }
  } catch (error) {
    if (error instanceof UploadValidationError) throw error;
    fail("The file could not be read. Save an unencrypted Excel workbook or a UTF-8 CSV file and try again.");
  }
  if (workbook.SheetNames.length !== 1) fail("Use one worksheet per upload. Copy the opportunity table into the template.");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  const range = utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1");
  if (range.s.r !== 0 || range.s.c !== 0) fail("Start the table in cell A1, with column headers in the first row.");
  if (range.e.r > MAX_ROWS || range.e.c >= uploadColumns.length) {
    fail(`Use at most ${MAX_ROWS} opportunity rows and the template columns only. Remove unused rows and columns.`);
  }
  const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: true, defval: "" });
  const headers = (rows[0] ?? []).map((value) => String(value).trim().toLowerCase());
  const allowed = new Set(uploadColumns.map((name) => name.toLowerCase()));
  if (!headers.includes("title") || !headers.includes("url")) fail("The first row must contain Title and URL column headers. Download the template.");
  if (headers.some((name) => !allowed.has(name)) || new Set(headers).size !== headers.length) {
    fail("Use unique column headers from the template. Unknown or blank column headers are not accepted.");
  }
  const candidates: SourceCandidate[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const label = `Row ${index + 1}`;
    for (let column = 0; column < headers.length; column += 1) {
      const cell = sheet[utils.encode_cell({ r: index, c: column })];
      if (cell?.f) fail(`${label}: replace formulas with their values before uploading.`);
      if (cell?.t === "e") fail(`${label}: correct Excel cell errors before uploading.`);
    }
    if (row.every((cell) => cell === "" || cell === null || cell === undefined)) continue;
    const value = (name: string) => {
      const column = headers.indexOf(name.toLowerCase());
      const hyperlink = name === "URL"
        ? sheet[utils.encode_cell({ r: index, c: column })]?.l?.Target
        : undefined;
      return typeof hyperlink === "string" ? hyperlink : row[column];
    };
    const text = (name: string) => {
      const cell = value(name);
      if (cell === undefined || cell === "") return undefined;
      if (typeof cell !== "string" && typeof cell !== "number") fail(`${label}, ${name}: use text or a number.`);
      const result = String(cell).trim();
      if (result.length > (name === "Description" ? 10000 : 2000)) fail(`${label}, ${name}: text is too long.`);
      return result || undefined;
    };
    const opportunityName = text("Title");
    const canonicalUrl = text("URL");
    if (!opportunityName || !canonicalUrl) fail(`${label}: Title and URL are required.`);
    try {
      const url = new URL(canonicalUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      fail(`${label}, URL: use a complete http or https link without credentials.`);
    }
    const eventType = text("Event type")?.toLowerCase() ?? "tender";
    if (!biddingEventTypes.includes(eventType as typeof biddingEventTypes[number])) fail(`${label}, Event type: use tender, modification, award, or cancellation.`);
    const amountText = text("Amount");
    const amount = amountText === undefined ? undefined : Number(amountText);
    if (amount !== undefined && (!Number.isFinite(amount) || amount < 0 || !/^\d+(?:\.\d+)?$/.test(amountText!))) {
      fail(`${label}, Amount: use a non-negative number without currency symbols or separators.`);
    }
    const currency = text("Currency")?.toUpperCase();
    if ((currency && !/^[A-Z]{3}$/.test(currency)) || (amount !== undefined && !currency)) fail(`${label}, Currency: provide a three-letter currency code when Amount is present.`);
    const countryCode = text("Country code")?.toUpperCase();
    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) fail(`${label}, Country code: use a two-letter code.`);
    const place = text("Place");
    candidates.push({
      sourceId,
      opportunityName,
      canonicalUrl,
      sourceOpportunityId: text("Opportunity ID"),
      sourceEventId: text("Event ID"),
      clientName: text("Client"),
      description: text("Description"),
      dueDate: dateValue(value("Due date"), `${label}, Due date`, date1904),
      publishedAt: dateValue(value("Published date"), `${label}, Published date`, date1904),
      value: amount !== undefined || currency ? { amount, currency } : undefined,
      placeOfPerformance: place || countryCode ? { description: place, countryCode } : undefined,
      eventType: eventType as typeof biddingEventTypes[number],
      sourceData: { uploadRow: index + 1 },
    });
  }
  if (!candidates.length) fail("The workbook has no opportunities. Add at least one row below the headers.");
  if (new TextEncoder().encode(JSON.stringify(candidates)).length > 1024 * 1024) fail("The opportunity data exceeds 1 MB. Split it into smaller uploads.");
  return candidates;
}
