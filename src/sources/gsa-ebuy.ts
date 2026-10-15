import { z } from "zod";
import type { SourceAdapter, SourceCandidate, SourceDefinition } from "./adapter";
import { SourceScanError } from "./adapter";

const API = "https://www.ebuy.gsa.gov/ebuy/api/services/ebuyservices/";
const optionalText = z.string().nullish();
const timestamp = z.number().finite().nonnegative().nullish();
const recordSchema = z.object({
  rfqId: z.string().regex(/^(RFQ|RFI|RFP)\d+$/),
  title: z.string().trim().min(1),
  issueTime: timestamp,
  closeTime: timestamp,
  lastRfqModVersion: z.number().int().nonnegative(),
  lastRfqModDate: timestamp,
  rfqCancelled: z.boolean(),
  cancelTime: timestamp,
  userAgency: optionalText,
  agencyCode: optionalText,
  userEmail: optionalText,
});
const detailSchema = z.object({
  rfqInfo: z.object({
    rfqId: z.string(),
    description: optionalText,
    referenceNum: optionalText,
    rfqOpen: z.boolean(),
    lastModTime: timestamp,
    issueTime: timestamp,
    closeTime: timestamp,
  }),
  rfqProps: z.object({
    userAgencyCode: optionalText,
    userAgency: optionalText,
    userBureau: optionalText,
    userEmail: optionalText,
  }),
  rfqCategories: z.array(z.object({ schedule: z.string(), sin: z.string() })),
});

export interface GsaEbuySession {
  token: string;
  contractNumber: string;
}

export const gsaEbuySourceDefinition: SourceDefinition = {
  id: "gsa-ebuy",
  name: "GSA eBuy",
  accessMode: "two-factor",
  phase: 3,
  adapterVersion: "1.0.0",
};

export function gsaEbuyReauthenticationRequired(): SourceScanError {
  return new SourceScanError(
    "reauthentication_required",
    "GSA eBuy requires a fresh manual FAS ID login and session handoff. Other Sources are unaffected.",
    false,
  );
}

// Used only to avoid sending an already expired credential. GSA validates the
// token itself on every request; these unverified claims do not authorize access.
export function gsaEbuyTokenExpiry(token: string): number {
  try {
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) return claims.exp * 1000;
  } catch {
    // Never reflect token contents or decoding errors.
  }
  throw gsaEbuyReauthenticationRequired();
}

export async function requestGsaEbuy(
  path: string,
  token: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  body?: object,
): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetcher(`${API}${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      if (!signal.aborted && attempt < 2) continue;
      throw new SourceScanError("network_error", "GSA eBuy could not be reached.", true);
    }
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
      throw gsaEbuyReauthenticationRequired();
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        signal.throwIfAborted();
        continue;
      }
      throw new SourceScanError("service_unavailable", "GSA eBuy is temporarily unavailable.", true);
    }
    if (!response.ok) {
      throw new SourceScanError("request_failed", "GSA eBuy rejected the request.", false);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw gsaEbuyReauthenticationRequired();
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new SourceScanError("invalid_response", "GSA eBuy returned invalid JSON.", false);
    }
    const envelope = z.object({ header: z.object({ status: z.literal(0) }), response: z.unknown() })
      .safeParse(data);
    if (!envelope.success) {
      throw new SourceScanError("invalid_response", "GSA eBuy returned an unsuccessful or changed response.", false);
    }
    return envelope.data.response;
  }
  throw new SourceScanError("service_unavailable", "GSA eBuy is temporarily unavailable.", true);
}

function clientFor(props: z.infer<typeof detailSchema>["rfqProps"]): string | undefined {
  const agency = props.userAgency?.trim().toLowerCase();
  const bureau = props.userBureau?.trim().toLowerCase() ?? "";
  if (/millennium challenge account|\bmca\b/.test(bureau)) return undefined;
  if (agency === "department of state" && props.userAgencyCode === "19") return "DOS";
  // eBuy groups MCC (including its misspelled bureau label) under agency 95.
  // Use the exact official buyer contact domain, not title keywords or a guessed
  // hierarchy-code crosswalk for DFC and USTDA.
  const domain = props.userEmail?.trim().toLowerCase().split("@");
  if (domain?.length !== 2) return undefined;
  return ({ "mcc.gov": "MCC", "dfc.gov": "DFC", "ustda.gov": "USTDA" } as Record<string, string>)[domain[1]];
}

async function plainText(html: string | null | undefined): Promise<string | undefined> {
  if (!html) return undefined;
  const parts: string[] = [];
  await new HTMLRewriter()
    .on("script, style", { element(element) { element.remove(); } })
    .on("*", { text(chunk) { parts.push(chunk.text); }, element() { parts.push(" "); } })
    .transform(new Response(`<div>${html}</div>`)).text();
  return parts.join("")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim() || undefined;
}

export function createGsaEbuyAdapter(options: {
  session: () => Promise<GsaEbuySession>;
  fetch?: typeof fetch;
}): SourceAdapter {
  return {
    definition: gsaEbuySourceDefinition,
    async scan(context) {
      const session = await options.session();
      if (gsaEbuyTokenExpiry(session.token) <= Date.now()) throw gsaEbuyReauthenticationRequired();
      const data = await requestGsaEbuy(
        `seller/activerfqs/${encodeURIComponent(session.contractNumber)}`,
        session.token, context.signal, options.fetch,
      );
      const snapshot = z.record(z.string(), z.array(recordSchema).nullable()).safeParse(data);
      if (!snapshot.success || !Object.hasOwn(snapshot.data, session.contractNumber)) {
        throw new SourceScanError("invalid_response", "GSA eBuy did not return the complete contract snapshot.", false);
      }
      const candidates = new Map<string, SourceCandidate>();
      for (const [contractNumber, records] of Object.entries(snapshot.data)) {
        for (const record of records ?? []) {
          if (!clientFor({ ...record, userAgencyCode: record.agencyCode })) continue;
          const detail = detailSchema.safeParse(await requestGsaEbuy(
            `seller/rfq/${record.rfqId}/${encodeURIComponent(contractNumber)}`,
            session.token, context.signal, options.fetch,
          ));
          if (!detail.success) {
            throw new SourceScanError("invalid_record", "GSA eBuy returned changed request details.", false);
          }
          const { rfqInfo, rfqProps, rfqCategories } = detail.data;
          if (record.rfqId !== rfqInfo.rfqId) {
            throw new SourceScanError("invalid_record", "GSA eBuy returned inconsistent request identifiers.", false);
          }
          const clientName = clientFor(rfqProps);
          if (!clientName || (!rfqInfo.rfqOpen && !record.rfqCancelled)) continue;
          const cancelled = record.rfqCancelled;
          const amendment = !cancelled && record.lastRfqModVersion > 0;
          const publicationTime = cancelled ? record.cancelTime : amendment
            ? rfqInfo.lastModTime ?? record.lastRfqModDate : rfqInfo.issueTime ?? record.issueTime;
          if (amendment && !publicationTime) {
            throw new SourceScanError("invalid_record", "GSA eBuy returned an amendment without its publication time.", false);
          }
          const sourceEventId = cancelled ? `${record.rfqId}:cancelled` : amendment
            ? `${record.rfqId}:amendment:${record.lastRfqModVersion}` : record.rfqId;
          // Owner-confirmed framework contracts; do not infer a vehicle from a
          // generic GS- or 47QRCA number prefix.
          const frameworkName = ({
            "GS-00F-063DA": "GSA PSS MAS",
            "47QRCA25DU699": "GSA OASIS+",
          } as Record<string, string | undefined>)[contractNumber];
          const url = new URL(`https://www.ebuy.gsa.gov/ebuy/seller/prepare-quote/${record.rfqId}`);
          url.searchParams.set("contractNumber", contractNumber);
          candidates.set(sourceEventId, {
            sourceId: gsaEbuySourceDefinition.id,
            sourceOpportunityId: record.rfqId,
            sourceEventId,
            canonicalUrl: url.toString(),
            eventType: cancelled ? "cancellation" : amendment ? "modification" : "tender",
            isFormalAmendment: amendment,
            originalEventType: record.rfqId.match(/^[A-Z]+/)![0],
            opportunityName: frameworkName ? `${frameworkName} — ${record.title}` : record.title,
            description: await plainText(rfqInfo.description),
            clientName,
            procuringEntityName: rfqProps.userBureau || rfqProps.userAgency || undefined,
            dueDate: (rfqInfo.closeTime ?? record.closeTime)
              ? new Date((rfqInfo.closeTime ?? record.closeTime)!).toISOString() : undefined,
            publishedAt: publicationTime ? new Date(publicationTime).toISOString() : undefined,
            sourceStatus: cancelled ? "Cancelled" : record.rfqId.startsWith("RFI") ? "Open — Request for Information" : "Open",
            // The observed pre-award API has no authoritative contract estimate.
            // Do not substitute line-item prices, quote totals, or attachment numbers.
            sourceData: {
              contractNumber,
              frameworkName,
              referenceNumber: rfqInfo.referenceNum,
              amendmentVersion: record.lastRfqModVersion,
              categories: rfqCategories,
              valueBasis: "not published in the active-request API",
            },
          });
        }
      }
      return { candidates: [...candidates.values()], nextCursor: { value: context.now.toISOString() } };
    },
  };
}
