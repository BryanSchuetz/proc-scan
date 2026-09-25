import { env } from "cloudflare:workers";
import { SELF, introspectWorkflowInstance } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { utils, write } from "xlsx";
import { zipSync } from "fflate";
import taxonomyRaw from "../tech-area-classification.yaml?raw";
import classificationRaw from "../config/technical-classification.yaml?raw";
import addressabilityRaw from "../config/addressability.yaml?raw";
import { parseTaxonomyYaml, parseTechnicalClassificationYaml } from "../src/classification/taxonomy";
import { parseAddressabilityYaml } from "../src/classification/addressability";
import { parseSpreadsheet, spreadsheetTemplate } from "../src/uploads/spreadsheet";
import { claimUploadsForScan, listUploads, queueUpload } from "../src/db/uploads";
import { claimScanRun, completeScanRun, completeSourceRun, failSourceRun, startSourceRun } from "../src/db/scan-runs";
import { syncTechnicalAreas } from "../src/db/taxonomy";
import { runQueuedUploads } from "../src/pipeline/run-uploads";
import { runSourceAdapter } from "../src/pipeline/run-source";
import { prepareDigest } from "../src/db/digests";
import type { EventsResponse, UploadsResponse } from "../src/api/types";

function workbook(rows: unknown[][], bookType: "xlsx" | "biff8" = "xlsx"): Uint8Array<ArrayBuffer> {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "Opportunities");
  return new Uint8Array(write(book, { type: "array", bookType }));
}

describe("Excel upload validation", () => {
  it("reads binary XLS with native dates and Unicode text", () => {
    const bytes = workbook([["Title", "URL", "Opportunity ID", "Due date"],
      ["Conseil climatique à Dakar", "https://example.org/xls", "00073", new Date("2099-04-03T14:30:00Z")]], "biff8");
    expect(parseSpreadsheet(bytes, "ted", "table.XLS")[0]).toMatchObject({
      opportunityName: "Conseil climatique à Dakar", sourceOpportunityId: "00073", dueDate: "2099-04-03T14:30:00.000Z",
    });
    expect(() => parseSpreadsheet(new TextEncoder().encode("Title,URL"), "ted", "table.xls")).toThrow("valid Excel .xls");
  });

  it("reads UTF-8 CSV with quoted commas, newlines and IDs without date coercion", () => {
    const csv = '\uFEFFTitle,URL,Opportunity ID,Description,Due date,Amount,Currency\r\n"Climate, conseil",https://example.org/csv,00073,"First line\nSecond line: café",2099-04-03,712345.67,eur';
    expect(parseSpreadsheet(new TextEncoder().encode(csv), "ted", "table.csv")[0]).toMatchObject({
      opportunityName: "Climate, conseil", sourceOpportunityId: "00073", description: "First line\nSecond line: café",
      dueDate: "2099-04-03T00:00:00.000Z", value: { amount: 712345.67, currency: "EUR" },
    });
    expect(parseSpreadsheet(new TextEncoder().encode(csv.replace("2099-04-03", "03/04/2099")), "ted", "table.csv")[0].dueDate)
      .toBe("2099-03-04T00:00:00.000Z");
    const rows = Array.from({ length: 501 }, (_, i) => `Opportunity ${i},https://example.org/${i}`);
    expect(() => parseSpreadsheet(new TextEncoder().encode(`Title,URL\n${rows.join("\n")}`), "ted", "table.csv")).toThrow("at most 500");
  });

  it("normalizes reordered columns, native Excel dates, IDs, currency, and event type", () => {
    const result = parseSpreadsheet(workbook([
      ["URL", "Title", "Amount", "Currency", "Due date", "Published date", "Opportunity ID", "Event type", "Country code"],
      ["https://example.org/notice/73", "Climate advisory", 712345.67, "eur", new Date("2099-04-03T14:30:00Z"), "2099-03-02T10:00:00+02:00", "00073", "Award", "ke"],
    ]), "ted");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourceId: "ted", canonicalUrl: "https://example.org/notice/73", opportunityName: "Climate advisory",
      value: { amount: 712345.67, currency: "EUR" }, dueDate: "2099-04-03T14:30:00.000Z",
      publishedAt: "2099-03-02T08:00:00.000Z", sourceOpportunityId: "00073", eventType: "award",
      placeOfPerformance: { countryCode: "KE" },
    });
    expect(result[0].discoveredAt).toBeUndefined();
  });

  it("reads numeric Excel date serials using the workbook date system", () => {
    const standard = parseSpreadsheet(workbook([
      ["Title", "URL", "Published date"],
      ["Standard date system", "https://example.org/standard-date", 45925],
    ]), "ted");
    expect(standard[0].publishedAt).toBe("2025-09-25T00:00:00.000Z");

    const book1904 = utils.book_new();
    const sheet = utils.aoa_to_sheet([
      ["Title", "URL", "Published date"],
      ["1904 date system", "https://example.org/1904-date", 1.5],
    ]);
    utils.book_append_sheet(book1904, sheet, "Opportunities");
    book1904.Workbook = { WBProps: { date1904: true } };
    const bytes1904 = new Uint8Array(write(book1904, { type: "array", bookType: "xlsx" }));
    expect(parseSpreadsheet(bytes1904, "ted")[0].publishedAt).toBe("1904-01-02T12:00:00.000Z");
  });

  it("normalizes recognizable dates stored as spreadsheet text", () => {
    const result = parseSpreadsheet(workbook([
      ["Title", "URL", "Due date", "Published date"],
      ["Text dates", "https://example.org/text-dates", "11/2/26", "September 14 2026"],
    ]), "ted");
    expect(result[0]).toMatchObject({
      dueDate: "2026-11-02T00:00:00.000Z",
      publishedAt: "2026-09-14T00:00:00.000Z",
    });
  });

  it("allows missing optional fields and skips empty rows without changing error row numbers", () => {
    expect(parseSpreadsheet(workbook([["Title", "URL"], ["Advisory", "https://example.org/1"], [], ["Other", "https://example.org/2"]]), "fmo"))
      .toMatchObject([{ eventType: "tender", sourceData: { uploadRow: 2 } }, { sourceData: { uploadRow: 4 } }]);
    expect(() => parseSpreadsheet(workbook([["Title", "URL"], [], ["Missing URL"]]), "fmo"))
      .toThrow("Row 3: Title and URL are required");
  });

  it("uses Excel hyperlink targets instead of their display text", () => {
    const urls = [
      "https://fcdo.bravosolution.co.uk/esop/toolkit/negotiation/rfq/detailRfqResponse.do?_ncp=1790350402816.161411-1#fh",
      "https://fcdo.bravosolution.co.uk/esop/ect/filesharing/flist/9939526/12464570/foldersFilesList.si#fh",
    ];
    const book = utils.book_new();
    const sheet = utils.aoa_to_sheet([["Title", "URL"], ["Framework", "Open RFQ"], ["Files", "Open files"]]);
    sheet.B2.l = { Target: urls[0] };
    sheet.B3.l = { Target: urls[1] };
    utils.book_append_sheet(book, sheet, "Opportunities");
    const bytes = new Uint8Array(write(book, { type: "array", bookType: "xlsx" }));

    expect(parseSpreadsheet(bytes, "fcdo-jaggaer-public").map((candidate) => candidate.canonicalUrl)).toEqual(urls);

    sheet.B2.l = { Target: "https://user:password@example.org/notice" };
    const unsafe = new Uint8Array(write(book, { type: "array", bookType: "xlsx" }));
    expect(() => parseSpreadsheet(unsafe, "fcdo-jaggaer-public")).toThrow("without credentials");
  });

  it.each([
    ["URL", "javascript:alert(1)", "URL: use a complete"],
    ["URL", "https://user:password@example.org/notice", "URL: use a complete"],
    ["Due date", "not a date", "use a recognizable date"],
    ["Due date", "2099-02-30", "invalid date"],
    ["Amount", "1,000,000", "Amount: use a non-negative"],
    ["Amount", -1, "Amount: use a non-negative"],
    ["Amount", 500, "Currency: provide"],
    ["Event type", "procurement", "Event type: use"],
    ["Country code", "Kenya", "Country code: use"],
  ])("rejects invalid %s values (%s)", (column, value, message) => {
    const headers = column === "URL" ? ["Title", "URL"] : ["Title", "URL", column];
    const row = column === "URL" ? ["Advisory", value] : ["Advisory", "https://example.org/1", value];
    expect(() => parseSpreadsheet(workbook([headers, row]), "ted")).toThrow(message);
  });

  it("rejects formulas, unknown/duplicate headers, empty templates, and non-workbooks", () => {
    expect(() => parseSpreadsheet(workbook([["Title", "URL"], [{ t: "s", v: "cached", f: '"formula"' }, "https://example.org/1"]]), "ted")).toThrow("replace formulas");
    expect(() => parseSpreadsheet(workbook([["Title", "URL", "Amount"], ["Advisory", "https://example.org/1", { t: "e", v: 7 }]]), "ted")).toThrow("correct Excel cell errors");
    expect(() => parseSpreadsheet(workbook([["Title", "URL", "Bogus"], ["x", "https://example.org", "y"]]), "ted")).toThrow("unique column headers");
    expect(() => parseSpreadsheet(workbook([["Title", "URL", "Title"], ["x", "https://example.org", "y"]]), "ted")).toThrow("unique column headers");
    expect(() => parseSpreadsheet(spreadsheetTemplate(), "ted")).toThrow("no opportunities");
    expect(() => parseSpreadsheet(new TextEncoder().encode("Title,URL\nx,https://example.org"), "ted")).toThrow("valid .xlsx");
  });

  it("enforces row and compressed/expanded file boundaries", () => {
    const rows = Array.from({ length: 500 }, (_, index) => [`Opportunity ${index}`, `https://example.org/${index}`]);
    expect(parseSpreadsheet(workbook([["Title", "URL"], ...rows]), "ted")).toHaveLength(500);
    expect(() => parseSpreadsheet(workbook([["Title", "URL"], ...rows, ["extra", "https://example.org/extra"]]), "ted")).toThrow("at most 500");
    expect(() => parseSpreadsheet(new Uint8Array(2 * 1024 * 1024 + 1), "ted")).toThrow("up to 2 MB");
    const compressed = zipSync({ "huge.xml": new Uint8Array(20 * 1024 * 1024 + 1) });
    expect(() => parseSpreadsheet(compressed, "ted")).toThrow("expanded workbook exceeds");
  });
});

function postFile(bytes: Uint8Array<ArrayBuffer>, sourceId = "fmo", origin = "http://localhost", filename = "opportunities.xlsx") {
  const body = new FormData();
  body.set("sourceId", sourceId);
  body.set("file", new File([bytes], filename));
  return SELF.fetch("http://localhost/api/uploads", { method: "POST", body, headers: { Origin: origin } });
}

describe("authenticated upload API", () => {
  it.each(["xls", "csv"])("accepts %s through the upload endpoint", async (extension) => {
    const title = `API ${extension} format test`;
    const bytes = extension === "xls"
      ? workbook([["Title", "URL"], [title, `https://example.org/${extension}`]], "biff8")
      : new TextEncoder().encode(`Title,URL\n${title},https://example.org/${extension}`);
    const response = await postFile(bytes, "fmo", "http://localhost", `table.${extension}`);
    expect(response.status).toBe(201);
    const body = await response.json<{ id: string; rowCount: number }>();
    expect(body.rowCount).toBe(1);
    await env.DB.prepare("DELETE FROM opportunity_uploads WHERE id = ?").bind(body.id).run();
  });

  it("requires Access on production routes and same-origin writes", async () => {
    expect((await SELF.fetch("https://registry.example.org/api/uploads")).status).toBe(403);
    expect((await SELF.fetch("https://registry.example.org/api/uploads", { method: "POST" })).status).toBe(403);
    expect((await postFile(spreadsheetTemplate(), "fmo", "https://other.example.org")).status).toBe(403);
  });

  it("rejects invalid sources and whole files without persisting partial rows", async () => {
    const countBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM opportunity_uploads").first();
    expect((await postFile(workbook([["Title", "URL"], ["valid", "https://example.org/valid"], ["invalid"]]))).status).toBe(400);
    expect((await postFile(spreadsheetTemplate(), "not-a-source")).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM opportunity_uploads").first()).toEqual(countBefore);
  });

  it("queues valid rows without inserting events and deduplicates repeated submissions", async () => {
    const bytes = workbook([["Title", "URL"], ["API upload test", "https://example.org/api-upload"]]);
    const response = await postFile(bytes);
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const first = await response.json<{ id: string; rowCount: number }>();
    expect(first.rowCount).toBe(1);
    const repeated = await postFile(bytes);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ id: first.id, duplicate: true });
    expect(await env.DB.prepare("SELECT id FROM bidding_events WHERE opportunity_name = 'API upload test'").first()).toBeNull();
    const list = await (await SELF.fetch("http://localhost/api/uploads")).json<UploadsResponse>();
    expect(list.uploads.find((item) => item.id === first.id)).toMatchObject({ status: "queued", sourceId: "fmo", rowCount: 1 });
    expect(list.sources.some((source) => source.id === "eu-funding-tenders" && source.enabled === 0)).toBe(true);
    expect(JSON.stringify(list)).not.toContain("uploaded_by");
    await env.DB.prepare("DELETE FROM opportunity_uploads WHERE id = ?").bind(first.id).run();
  });

  it("serves a real downloadable workbook", async () => {
    const response = await SELF.fetch("http://localhost/api/uploads/template");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("opportunities-template.xlsx");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(() => parseSpreadsheet(bytes, "ted")).toThrow("no opportunities");
  });
});

const taxonomy = parseTaxonomyYaml(taxonomyRaw);
const technicalClassification = parseTechnicalClassificationYaml(classificationRaw);
const addressability = parseAddressabilityYaml(addressabilityRaw);
beforeAll(async () => { await syncTechnicalAreas(env.DB, taxonomy, technicalClassification.schema_version); });

async function scanContext(id: string, sourceId = "fmo") {
  const now = new Date("2098-01-01T06:00:00.000Z");
  await claimScanRun(env.DB, { id, cycleKey: id, scheduledFor: now.toISOString() });
  const sourceRunId = await startSourceRun(env.DB, id, sourceId);
  return { db: env.DB, sourceId, sourceRunId, scanRunId: id, now, taxonomy, technicalClassification, addressability };
}

describe("uploads in the scan pipeline", () => {
  it("applies classification, exclusions, deduplication and digest inclusion, including disabled Sources", async () => {
    const context = await scanContext("upload_scan_pipeline", "eu-funding-tenders");
    const candidates = parseSpreadsheet(workbook([
      ["Title", "URL", "Client", "Due date"],
      ["Climate advisory", "https://example.org/upload/marked", "Upload buyer", "2099-01-01"],
      ["Roof renovation", "https://example.org/upload/unmarked", "Upload buyer", "2099-01-01"],
      ["Expired consulting", "https://example.org/upload/expired", "Upload buyer", "2090-01-01"],
      ["Climate advisory", "https://example.org/upload/marked", "Upload buyer", "2099-01-01"],
    ]), context.sourceId);
    await queueUpload(env.DB, { id: "upload-pipeline", sourceId: context.sourceId, filename: "pipeline.xlsx", candidates });
    expect(await claimUploadsForScan(env.DB, context.scanRunId, context.now.toISOString())).toContain(context.sourceId);
    expect((await listUploads(env.DB)).find((u) => u.id === "upload-pipeline")?.status).toBe("processing");
    const counts = await runQueuedUploads(context);
    expect(counts).toEqual({ discoveredCount: 4, retainedCount: 2, excludedCount: 1, duplicateCount: 1 });
    expect(await runQueuedUploads(context)).toEqual(counts);
    await completeSourceRun(env.DB, context.sourceRunId, counts);
    await completeScanRun(env.DB, context.scanRunId);
    const stored = await env.DB.prepare("SELECT discovered_at, source_id, source_data_json FROM bidding_events WHERE scan_run_id = ?")
      .bind(context.scanRunId).all<{ discovered_at: string; source_id: string; source_data_json: string }>();
    expect(stored.results).toHaveLength(2);
    expect(stored.results.every((row) => row.discovered_at === context.now.toISOString() && row.source_id === context.sourceId)).toBe(true);
    expect(JSON.parse(stored.results[0].source_data_json).upload.id).toBe("upload-pipeline");
    const registry = await (await SELF.fetch(`http://localhost/api/opportunities?source=${context.sourceId}`)).json<EventsResponse>();
    expect(registry.items).toHaveLength(2);
    expect(registry.facets.clients).toContain("Upload buyer");
    expect(registry.facets.sources.some((s) => s.id === context.sourceId)).toBe(true);
    expect(registry.facets.technicalAreas.length).toBeGreaterThan(0);
    const digest = await prepareDigest(env.DB, context.scanRunId);
    expect(digest.events.map((item) => item.opportunityName)).toEqual(["Climate advisory"]);
    const next = await scanContext("upload_scan_next", context.sourceId);
    expect(await claimUploadsForScan(env.DB, next.scanRunId, next.now.toISOString())).not.toContain(context.sourceId);
    expect((await listUploads(env.DB)).find((u) => u.id === "upload-pipeline")).toMatchObject({ status: "processed", retainedCount: 2, excludedCount: 1, duplicateCount: 1 });
  });

  it("combines uploaded and automated counts, preserves source cursors and applies the source value floor", async () => {
    const context = await scanContext("upload_scan_combined");
    const candidates = parseSpreadsheet(workbook([
      ["Title", "URL", "Client", "Amount", "Currency"],
      ["Consulting low value", "https://example.org/upload/low", "FMO", 499999, "EUR"],
      ["Consulting retained", "https://example.org/upload/retained", "FMO", 500000, "EUR"],
    ]), "fmo");
    await queueUpload(env.DB, { id: "upload-combined", sourceId: "fmo", filename: "combined.xlsx", candidates });
    await claimUploadsForScan(env.DB, context.scanRunId, context.now.toISOString());
    const initialCounts = await runQueuedUploads(context);
    expect(initialCounts).toMatchObject({ discoveredCount: 2, retainedCount: 1, excludedCount: 1 });
    const result = await runSourceAdapter({ ...context, initialCounts, signal: new AbortController().signal,
      adapter: {
        definition: { id: "fmo", name: "FMO", phase: 1, accessMode: "public", adapterVersion: "test" },
        scan: async () => ({ candidates: [candidates[1], { ...candidates[1], canonicalUrl: "https://example.org/auto" }], nextCursor: { value: "next" } }),
      },
    });
    expect(result).toMatchObject({ discoveredCount: 4, retainedCount: 2, excludedCount: 1, duplicateCount: 1 });
    expect(await env.DB.prepare("SELECT cursor_json FROM sources WHERE id = 'fmo'").first()).toEqual({ cursor_json: '{"value":"next"}' });
  });

  it("keeps imported events and counts when automated discovery fails", async () => {
    const context = await scanContext("upload_scan_failed");
    await queueUpload(env.DB, { id: "upload-failed-source", sourceId: "fmo", filename: "failed.xlsx",
      candidates: parseSpreadsheet(workbook([["Title", "URL"], ["Advisory despite outage", "https://example.org/upload/outage"]]), "fmo"),
    });
    await claimUploadsForScan(env.DB, context.scanRunId, context.now.toISOString());
    const counts = await runQueuedUploads(context);
    await failSourceRun(env.DB, context.sourceRunId, "source_unavailable", "Source unavailable");
    expect(await completeScanRun(env.DB, context.scanRunId)).toMatchObject({ retainedCount: 1, discoveredCount: 1 });
    expect(counts.retainedCount).toBe(1);
    expect((await prepareDigest(env.DB, context.scanRunId)).events.map((event) => event.opportunityName)).toEqual(["Advisory despite outage"]);
  });

  it("claims only pre-scan files, prevents overlapping consumption, and retries unfinished failed scans", async () => {
    const first = await scanContext("upload_claim_first");
    const second = await scanContext("upload_claim_second");
    for (const id of ["upload-before", "upload-after"]) {
      await queueUpload(env.DB, { id, sourceId: "fmo", filename: "claims.xlsx",
        candidates: parseSpreadsheet(workbook([["Title", "URL"], [id, `https://example.org/${id}`]]), "fmo"),
      });
    }
    await env.DB.prepare("UPDATE opportunity_uploads SET created_at = '2098-01-01T06:00:00.001Z' WHERE id = 'upload-after'").run();
    expect(await claimUploadsForScan(env.DB, first.scanRunId, first.now.toISOString())).toEqual(["fmo"]);
    expect(await claimUploadsForScan(env.DB, second.scanRunId, second.now.toISOString())).toEqual([]);
    await failSourceRun(env.DB, first.sourceRunId, "fixture", "Fixture failure");
    await completeScanRun(env.DB, first.scanRunId);
    expect(await claimUploadsForScan(env.DB, second.scanRunId, second.now.toISOString())).toEqual(["fmo"]);
    const rows = await env.DB.prepare("SELECT id, scan_run_id FROM opportunity_uploads WHERE id IN ('upload-before', 'upload-after') ORDER BY id").all();
    expect(rows.results).toEqual([{ id: "upload-after", scan_run_id: null }, { id: "upload-before", scan_run_id: second.scanRunId }]);
  });

  it.each([false, true])("consumes uploads through the real Workflow (automated scan fails: %s)", async (automatedFailure) => {
    const sourceId = automatedFailure ? "fmo" : "eu-funding-tenders";
    const uploadId = `workflow-upload-${automatedFailure}`;
    await queueUpload(env.DB, { id: uploadId, sourceId, filename: "workflow.xlsx",
      candidates: parseSpreadsheet(workbook([["Title", "URL"], ["Workflow advisory", `https://example.org/${uploadId}`]]), sourceId),
    });
    const instance = await introspectWorkflowInstance(env.SCAN_WORKFLOW, uploadId);
    try {
      await instance.modify(async (m) => {
        await m.mockStepResult({ name: "load enabled Sources" }, automatedFailure ? [{ id: "fmo" }] : []);
        if (automatedFailure) {
          await m.mockStepResult({ name: "scan and process fmo" }, {
            ok: false, failure: { code: "fixture_failure", message: "Automated Source unavailable" },
          });
        }
      });
      await env.SCAN_WORKFLOW.create({ id: uploadId });
      await instance.waitForStatus("complete");
      expect(await instance.getOutput()).toMatchObject({
        sourceCount: 1, discoveredCount: 1, retainedCount: 1,
        status: automatedFailure ? "failed" : "completed",
      });
      expect((await listUploads(env.DB)).find((upload) => upload.id === uploadId)).toMatchObject({ status: "processed", retainedCount: 1 });
      const event = await env.DB.prepare("SELECT source_id, scan_run_id FROM bidding_events WHERE source_url = ?")
        .bind(`https://example.org/${uploadId}`).first<{ source_id: string; scan_run_id: string }>();
      expect(event?.source_id).toBe(sourceId);
      expect((await prepareDigest(env.DB, event!.scan_run_id)).events.map((item) => item.sourceUrl)).toEqual([`https://example.org/${uploadId}`]);
    } finally {
      await instance.dispose();
    }
  });
});
