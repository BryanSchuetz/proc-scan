import type { PreparedDigest, DigestEvent } from "../db/digests";
import type { DigestMessage } from "./campaign-monitor";

const TIME_ZONE = "America/New_York";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function formatDate(value: string, includeTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" } : {}),
  }).format(date);
}

function formatValue(event: DigestEvent): string {
  if (event.valueAmount === undefined) return "Not stated";
  if (!event.valueCurrency) return new Intl.NumberFormat("en-US").format(event.valueAmount);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: event.valueCurrency,
      maximumFractionDigits: 0,
    }).format(event.valueAmount);
  } catch {
    return `${new Intl.NumberFormat("en-US").format(event.valueAmount)} ${event.valueCurrency}`;
  }
}

function eventTypeLabel(type: DigestEvent["eventType"]): string {
  return type === "tender" ? "Tender" : type === "modification" ? "Modification" : "Cancellation";
}

function eventHtml(event: DigestEvent): string {
  const areas = event.technicalAreaLabels.length > 0
    ? event.technicalAreaLabels.map(escapeHtml).join(" · ")
    : "Unclassified";
  const borderColor = event.eventType === "modification"
    ? "#F9CC73"
    : event.eventType === "cancellation"
      ? "#C93549"
      : "#9BCE36";
  return `<tr><td style="padding:0 0 8px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#FFFFFF;border:1px solid #E4E5E6;border-left:4px solid ${borderColor}">
      <tr><td style="padding:13px 16px 14px">
        <div style="font:600 11px/1.4 Arial,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#56687B">${escapeHtml(eventTypeLabel(event.eventType))} · ${escapeHtml(event.sourceName)}</div>
        <h3 style="margin:4px 0 10px;font:700 17px/1.3 Arial,sans-serif"><a href="${escapeHtml(event.sourceUrl)}" style="color:#1E7AB3;text-decoration:underline">${escapeHtml(event.opportunityName)}</a></h3>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font:13px/1.4 Arial,sans-serif;color:#404D59">
          <tr>
            <td style="width:38%;padding:0 12px 7px 0;vertical-align:top"><span style="font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#56687B">Location</span><br>${escapeHtml(event.placeOfPerformance ?? "Not stated")}</td>
            <td style="width:62%;padding:0 0 7px;vertical-align:top"><span style="font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#56687B">Due</span><br>${escapeHtml(event.dueDate ? formatDate(event.dueDate, true) : "Not stated")}</td>
          </tr>
          <tr>
            <td style="padding:0 12px 0 0;vertical-align:top"><span style="font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#56687B">Value</span><br>${escapeHtml(formatValue(event))}</td>
            <td style="padding:0;vertical-align:top"><span style="font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#56687B">Technical areas</span><br>${areas}</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>`;
}

function groupedHtml(events: DigestEvent[]): string {
  const clients = new Map<string, DigestEvent[]>();
  for (const event of events) {
    const client = event.clientName ?? "Client not stated";
    const clientEvents = clients.get(client) ?? [];
    clientEvents.push(event);
    clients.set(client, clientEvents);
  }

  return [...clients.entries()].map(([client, clientEvents]) => `
    <tr><td style="padding:22px 0 8px"><h2 style="margin:0;font:700 23px/1.25 Arial,sans-serif;color:#2D3943">${escapeHtml(client)}</h2></td></tr>
    ${clientEvents.map(eventHtml).join("")}`).join("");
}

function plainText(digest: PreparedDigest, appUrl?: string): string {
  const failed = digest.sourceRuns.filter((source) => source.status !== "completed");
  const lines = [
    "PROCUREMENT OPPORTUNITY DIGEST",
    `${digest.events.length} new marked ${digest.events.length === 1 ? "event" : "events"}`,
    `Scan: ${formatDate(digest.scheduledFor, true)}`,
    failed.length > 0
      ? `Coverage: Partial. Failed Sources: ${failed.map((source) => source.sourceName).join(", ")}`
      : `Coverage: ${digest.sourceRuns.length} Sources scanned successfully`,
    "",
  ];
  let currentClient = "";
  for (const event of digest.events) {
    const client = event.clientName ?? "Client not stated";
    if (client !== currentClient) {
      lines.push(client.toUpperCase(), "");
      currentClient = client;
    }
    lines.push(
      event.opportunityName,
      `${eventTypeLabel(event.eventType)} · ${event.sourceName}`,
      `Location: ${event.placeOfPerformance ?? "Not stated"}`,
      `Value: ${formatValue(event)}`,
      `Due: ${event.dueDate ? formatDate(event.dueDate, true) : "Not stated"}`,
      `Technical areas: ${event.technicalAreaLabels.join(", ") || "Unclassified"}`,
      event.sourceUrl,
      "",
    );
  }
  if (appUrl) lines.push(`Open the registry: ${appUrl}`, "");
  return lines.join("\n");
}

export function renderDigest(digest: PreparedDigest, appUrl?: string): DigestMessage {
  const failed = digest.sourceRuns.filter((source) => source.status !== "completed");
  const date = formatDate(digest.scheduledFor);
  const subject = `${digest.events.length} new procurement ${digest.events.length === 1 ? "opportunity" : "opportunities"} | ${date}`;
  const coverage = failed.length > 0
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-collapse:collapse;background:#FCF7F1;border:1px solid #F9CC73"><tr><td style="padding:12px 14px;font:14px/1.5 Arial,sans-serif;color:#404D59"><strong>Partial coverage:</strong> ${escapeHtml(failed.map((source) => source.sourceName).join(", "))} did not complete. Results from successful Sources are included.</td></tr></table>`
    : `<p style="margin:10px 0 0;font:14px/1.5 Arial,sans-serif;color:#56687B">${digest.sourceRuns.length} Sources scanned successfully</p>`;
  const registryButton = appUrl
    ? `<tr><td align="center" style="padding:26px 0 8px"><a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:12px 20px;background:#404D59;color:#FFFFFF;font:600 15px/1.4 Arial,sans-serif;text-decoration:none">Open the registry</a></td></tr>`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(subject)}</title></head>
  <body style="margin:0;padding:0;background:#F3F4F5">
    <div style="display:none;max-height:0;overflow:hidden">New marked procurement opportunities from the latest registry scan.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#F3F4F5"><tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:680px;border-collapse:collapse">
        <tr><td style="height:7px;background:#9BCE36"></td></tr>
        <tr><td style="padding:28px 30px;background:#404D59">
          <div style="font:700 13px/1.4 Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#A1C7E3">DAI</div>
          <h1 style="margin:8px 0 0;font:700 30px/1.2 Arial,sans-serif;color:#FFFFFF">Procurement Scan Digest</h1>
          <p style="margin:10px 0 0;font:16px/1.5 Arial,sans-serif;color:#E4E5E6">${digest.events.length} new marked ${digest.events.length === 1 ? "event" : "events"} · ${escapeHtml(date)}</p>
        </td></tr>
        <tr><td style="padding:22px 30px;background:#FFFFFF">
          <p style="margin:0;font:15px/1.55 Arial,sans-serif;color:#404D59">This digest contains newly discovered opportunities from the latest 12-hour scan.</p>
          ${coverage}
        </td></tr>
        <tr><td style="padding:0 30px 24px;background:#FFFFFF"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${groupedHtml(digest.events)}${registryButton}</table></td></tr>
        <tr><td style="padding:18px 30px;background:#D3E3F0;font:13px/1.5 Arial,sans-serif;color:#404D59">Generated by the DAI Procurement Registry after the ${escapeHtml(formatDate(digest.scheduledFor, true))} scan.</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  return { subject, html, text: plainText(digest, appUrl) };
}
