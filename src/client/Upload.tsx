import { CaretDownIcon, FileXlsIcon, InfoIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ApiError, UploadsResponse } from "../api/types";

interface UploadProps {
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>, path: "/" | "/unmarked" | "/how-it-works" | "/upload") => void;
}

async function checkedJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as ApiError | undefined;
    throw new Error(body?.error?.message ?? "The request failed. Please try again.");
  }
  return response.json() as Promise<T>;
}

export default function Upload({ onNavigate }: UploadProps) {
  const [data, setData] = useState<UploadsResponse>();
  const [sourceId, setSourceId] = useState("");
  const [file, setFile] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [success, setSuccess] = useState("");
  const [reload, setReload] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    fetch("/api/uploads", { signal: controller.signal })
      .then(checkedJson<UploadsResponse>)
      .then(setData)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Uploads could not be loaded.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  function chooseFiles(files: FileList | null) {
    if (busy) return;
    setSuccess("");
    setError("");
    setFile(undefined);
    if (!files?.length) return;
    if (files.length !== 1) { setError("Choose one file at a time."); return; }
    const selected = files[0];
    if (!/\.(xls|xlsx|csv)$/i.test(selected.name) || selected.size > 2 * 1024 * 1024 || selected.size === 0) {
      setError("Choose a non-empty .xls, .xlsx, or .csv file up to 2 MB.");
      return;
    }
    setFile(selected);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !sourceId || busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    const body = new FormData();
    body.set("sourceId", sourceId);
    body.set("file", file);
    try {
      const result = await checkedJson<{ rowCount: number; duplicate: boolean }>(await fetch("/api/uploads", { method: "POST", body }));
      setSuccess(result.duplicate
        ? "This opportunity data has already been uploaded for this Source. No duplicate upload was created."
        : `${file.name}: ${result.rowCount} ${result.rowCount === 1 ? "opportunity" : "opportunities"} queued for the next scan.`);
      setFile(undefined);
      if (input.current) input.current.value = "";
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="upload-page">
      <section className="registry-heading" aria-labelledby="upload-title">
        <div>
          <p className="section-kicker">Bidding Events</p>
          <h2 id="upload-title">Upload Opportunities</h2>
          <p className="registry-description">Add a table of non-public opportunity records for a given source.</p>
          <nav className="view-tabs" aria-label="Registry views">
            <a href="/" onClick={(event) => onNavigate(event, "/")}>Marked</a>
            <a href="/unmarked" onClick={(event) => onNavigate(event, "/unmarked")}>Unmarked</a>
            <a className="view-tabs__info" href="/how-it-works" onClick={(event) => onNavigate(event, "/how-it-works")}>
              How it works
              <InfoIcon aria-hidden="true" size={16} weight="bold" />
            </a>
          </nav>
        </div>
      </section>

      <div className="upload-layout">
        <form className="upload-form" onSubmit={submit} aria-busy={busy}>
          <label className="upload-source" htmlFor="upload-source">Source</label>
          <div className="upload-select">
            <select id="upload-source" value={sourceId} required disabled={busy || !data}
              onChange={(event) => { setSourceId(event.target.value); setSuccess(""); }}>
              <option value="">{loading && !data ? "Loading Sources…" : "Choose a Source"}</option>
              {data?.sources.map((source) => <option key={source.id} value={source.id}>
                {source.name}{source.enabled ? "" : " (manual uploads only)"}
              </option>)}
            </select>
            <CaretDownIcon aria-hidden="true" size={18} weight="bold" />
          </div>
          <p className="upload-help">All rows in this file will belong to this Source.</p>

          <label className={`upload-dropzone${dragging ? " upload-dropzone--active" : ""}`} htmlFor="upload-file"
            onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
            onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFiles(event.dataTransfer.files); }}>
            {file ? <FileXlsIcon size={36} aria-hidden="true" /> : <UploadSimpleIcon size={36} aria-hidden="true" />}
            <strong>{file ? file.name : "Drop your file here"}</strong>
            <span>{file ? `${Math.ceil(file.size / 1024)} KB · Click to choose another file` : "or click to browse"}</span>
            <small>.xls, .xlsx, or .csv · Up to 2 MB and 500 opportunities</small>
            <input ref={input} id="upload-file" type="file" accept=".xls,.xlsx,.csv" aria-label="Opportunity file"
              disabled={busy} onChange={(event) => chooseFiles(event.target.files)} />
          </label>

          {error && <p className="upload-error" role="alert">{error}</p>}
          {success && <p className="upload-success" role="status">{success}</p>}
          <div className="upload-actions">
            <button className="upload-submit" type="submit" disabled={!file || !sourceId || busy}>
              {busy ? "Validating and uploading…" : "Upload"}
            </button>
            <span>Queued files are included in the next scan.</span>
          </div>
        </form>

        <aside className="upload-guide" aria-labelledby="spreadsheet-title">
          <h3 id="spreadsheet-title">Prepare your Table</h3>
          <p>Use one worksheet or a UTF-8, comma-separated CSV file, with column headers in the first row and one opportunity per row.</p>
          <a className="upload-template" href="/api/uploads/template" download>Download Excel template</a>
          <dl>
            <dt>Required Columns</dt><dd>Title and URL. Use the full link to the opportunity.</dd>
            <dt>Recommended</dt><dd>Client, Description, Opportunity ID, Amount, and Due date.</dd>
          </dl>
          <p>Blank event types default to Tender. Include the Opportunity ID when available to link related notices. Replace formulas with values.</p>
          <p className="upload-guide__note">Only upload opportunities within the Source’s approved scope. The next scan applies the usual duplicate checks, value thresholds, and classification. Uploading does not guarantee inclusion in the registry or email digest.</p>
        </aside>
      </div>

      <section className="upload-history" aria-labelledby="upload-history-title">
        <div className="upload-history__heading">
          <div><h3 id="upload-history-title">Recent uploads</h3><p>Latest 30 uploads across the team.</p></div>
          <button type="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>Refresh</button>
        </div>
        {loadError && <p className="upload-error" role="alert">{loadError} Use Refresh to try again.</p>}
        {loading && !data ? <p role="status">Loading uploads…</p> : data?.uploads.length === 0 ?
          <p className="upload-empty">No uploads yet. Choose a Source and add your first spreadsheet above.</p> : data && (
            <div className="upload-history__scroll" role="region" aria-label="Recent uploads table" tabIndex={0}>
              <table>
                <thead><tr><th scope="col">File</th><th scope="col">Source</th><th scope="col">Uploaded</th><th scope="col">Rows</th><th scope="col">Status</th></tr></thead>
                <tbody>{data.uploads.map((upload) => <tr key={upload.id}>
                  <td>{upload.filename}</td><td>{upload.sourceName}</td>
                  <td><time dateTime={upload.createdAt}>{new Date(upload.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</time></td>
                  <td>{upload.rowCount}</td>
                  <td><strong>{upload.status === "queued" ? "Queued for next scan" : upload.status === "processing" ? "Processing" : "Processed"}</strong>
                    {upload.status === "processed" && <span className="upload-result">{upload.retainedCount} retained, {upload.excludedCount} excluded, {upload.duplicateCount} duplicates</span>}
                  </td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
      </section>
    </main>
  );
}
