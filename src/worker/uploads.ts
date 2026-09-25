import type { UploadsResponse } from "../api/types";
import { listUploads, queueUpload } from "../db/uploads";
import { sha256Hex } from "../domain/identity";
import { MAX_FILE_BYTES, parseSpreadsheet, spreadsheetTemplate, UploadValidationError } from "../uploads/spreadsheet";
import type { AuthorizedUser } from "./access";

async function boundedFormData(request: Request): Promise<FormData> {
  const reader = request.body?.getReader();
  if (!reader) throw new UploadValidationError("Choose an .xls, .xlsx, or .csv file.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FILE_BYTES + 65536) {
      await reader.cancel();
      throw new UploadValidationError("Choose an .xls, .xlsx, or .csv file up to 2 MB.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  try {
    return await new Response(body, { headers: request.headers }).formData();
  } catch {
    throw new UploadValidationError("Send the file and source as multipart form data.");
  }
}

export async function handleUploads(request: Request, db: D1Database, user: AuthorizedUser): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/uploads/template" && request.method === "GET") {
    return new Response(spreadsheetTemplate(), { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="opportunities-template.xlsx"',
    } });
  }
  if (url.pathname !== "/api/uploads") return Response.json({ error: { code: "not_found", message: "Upload route not found." } }, { status: 404 });
  if (request.method === "GET") {
    const sources = await db.prepare("SELECT id, display_name AS name, enabled FROM sources ORDER BY display_name")
      .all<UploadsResponse["sources"][number]>();
    return Response.json({ sources: sources.results, uploads: await listUploads(db) } satisfies UploadsResponse);
  }
  if (request.method !== "POST") return Response.json({ error: { code: "method_not_allowed", message: "Use GET or POST for uploads." } }, { status: 405 });
  if (request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return Response.json({ error: { code: "invalid_origin", message: "Upload files from the registry page." } }, { status: 403 });
  }
  try {
    const form = await boundedFormData(request);
    const sourceId = form.get("sourceId");
    const file = form.get("file");
    if (typeof sourceId !== "string" || !await db.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first()) {
      throw new UploadValidationError("Choose a valid Source.");
    }
    if (!(file instanceof File) || !/\.(xls|xlsx|csv)$/i.test(file.name) || file.name.length > 200) {
      throw new UploadValidationError("Choose an .xls, .xlsx, or .csv file with a filename of at most 200 characters.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const candidates = parseSpreadsheet(bytes, sourceId, file.name);
    // Identical opportunity data is idempotent even if Excel rewrites workbook metadata.
    const id = `upload_${await sha256Hex(`${sourceId}\0${JSON.stringify(candidates)}`)}`;
    const created = await queueUpload(db, { id, sourceId, filename: file.name, candidates, uploadedBy: user.email ?? user.subject });
    return Response.json({ id, rowCount: candidates.length, duplicate: !created }, { status: created ? 201 : 200 });
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return Response.json({ error: { code: "invalid_upload", message: error.message } }, { status: 400 });
    }
    throw error;
  }
}
