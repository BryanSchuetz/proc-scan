import type { NormalizedBiddingEvent } from "./types";

const textEncoder = new TextEncoder();

function normalizedText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "string") return normalizedText(value)?.toLowerCase();
  if (Array.isArray(value)) {
    return value.map(canonicalValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  const sorted = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
  );
  url.search = "";
  for (const [key, entry] of sorted) url.searchParams.append(key, entry);

  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export async function buildEventIdentity(event: NormalizedBiddingEvent): Promise<string> {
  if (normalizedText(event.sourceEventId)) return `id:${event.sourceEventId!.trim()}`;
  if (normalizedText(event.canonicalUrl)) return `url:${canonicalizeUrl(event.canonicalUrl)}`;

  const fallback = await sha256Hex(
    canonicalJson({
      opportunityName: event.opportunityName,
      clientName: event.clientName,
      originalEventType: event.originalEventType,
      publishedAt: event.publishedAt,
      dueDate: event.dueDate,
    }),
  );
  return `fingerprint:${fallback}`;
}

export async function buildMaterialFingerprint(event: NormalizedBiddingEvent): Promise<string> {
  return sha256Hex(
    canonicalJson({
      eventType: event.eventType,
      originalEventType: event.originalEventType,
      opportunityName: event.opportunityName,
      description: event.description,
      clientName: event.clientName,
      funderNames: event.funderNames,
      procuringEntityName: event.procuringEntityName,
      implementingEntityNames: event.implementingEntityNames,
      value: event.value,
      dueDate: event.dueDate,
      placeOfPerformance: event.placeOfPerformance,
      eligibility: event.eligibility,
      sourceStatus: event.sourceStatus,
      documents: event.documents?.map(({ id, title, url, documentType }) => ({
        id,
        title,
        url: canonicalizeUrl(url),
        documentType,
      })),
    }),
  );
}

export async function buildBiddingEventId(
  sourceId: string,
  eventIdentity: string,
  contentFingerprint: string,
): Promise<string> {
  const digest = await sha256Hex(`${sourceId}\u0000${eventIdentity}\u0000${contentFingerprint}`);
  return `evt_${digest.slice(0, 24)}`;
}
