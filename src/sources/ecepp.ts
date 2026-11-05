import { z } from "zod";
import type {
  SourceAdapter,
  SourceCandidate,
  SourceDefinition,
  SourceScanContext,
  SourceScanResult,
} from "./adapter";
import { SourceScanError } from "./adapter";

// EBRD publishes its procurement on GEP SMART. The Source ID stays "ecepp" so
// existing events, uploads, and addressability rules carry over.
const SMART = "https://eu.smart.gep.com";
const CLIENT_PARAM = "NzAwMjE4Njk1";
const WORKSPACE_URL = `${SMART}/Smart?oloc=200&c=${CLIENT_PARAM}&dd=YnBjPTcwMDIxODY5JmNjPTU0NzEwMzA0MDAwMDA00`;
const STS_URL = "https://smart-sts.gep.com/default.aspx?" + new URLSearchParams({
  gepoa: "OASignIn",
  wtrealm: `${SMART}/`,
  ru: new URL(WORKSPACE_URL).pathname + new URL(WORKSPACE_URL).search,
  wreply: WORKSPACE_URL,
});
const IDP = "https://idplogin.gep.com";
const USER_AGENT = "Mozilla/5.0 (compatible; proc-scan/2.0; +https://github.com/BryanSchuetz/proc-scan)";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_ENRICHMENTS = 250;
const ENRICHMENT_CONCURRENCY = 5;
const CLOSED_STATUS = /withdrawn|cancel|award|complet|closed/i;
const CONSULTANCY_TEXT = /\b(?:advisory|consultancy|consultant|consulting)\b/i;
// EBRD numbers consultant selections "PR 0nnnnn"; corporate purchasing uses "PUR".
const CONSULTANCY_REFERENCE = /\bPR\s*(\d{4,})/;
const COST_ESTIMATE = /\bCost Estimate\s*:\s*([A-Z]{3})\s*([\d,]+(?:\.\d+)?)/i;

const listSchema = z.object({
  DataSearchResult: z.object({
    GroupTotal: z.object({ rfx: z.number().int().nonnegative() }),
    Value: z.array(z.object({
      DocumentCode: z.string().regex(/^\d+$/),
      Name: z.string(),
      Number: z.string().nullish(),
      DocumentDetails: z.object({ DocumentStatusInfo: z.string() }),
      DocumentSearchOutput: z.object({
        QueryString: z.string().min(1),
        DocumentAdditionalFieldList: z.array(z.object({
          FieldName: z.string(),
          FieldValue: z.string().nullable(),
        })),
      }),
    })).nullable(),
  }),
});
const detailSchema = z.object({
  DocumentCode: z.number().int(),
  EventName: z.string(),
  EventDescription: z.string().nullish(),
  EventValue: z.number().nullish(),
  EventCurrency: z.string().nullish(),
  CustomField: z.array(z.object({
    customFieldName: z.string(),
    customFieldValue: z.string().nullish(),
  })).nullish(),
  Doc: z.object({
    DocumentPASList: z.array(z.object({ PasName: z.string() })).nullish(),
    DocumentRegionList: z.array(z.object({ RegionName: z.string() })).nullish(),
    DocumentBUList: z.array(z.object({ BusinessUnitName: z.string() })).nullish(),
    DocumentLOBDetails: z.array(z.object({ EntityDisplayName: z.string() })).nullish(),
  }),
});
const loginSchema = z.object({
  isLoggedIn: z.boolean(),
  isLockedOut: z.boolean().nullish(),
  isInvalidCredentials: z.boolean().nullish(),
  mustChangePassword: z.boolean().nullish(),
  requiresTwoFactor: z.boolean().nullish(),
});

type GepListing = NonNullable<z.infer<typeof listSchema>["DataSearchResult"]["Value"]>[number];
type GepDetail = z.infer<typeof detailSchema>;

export const eceppSourceDefinition: SourceDefinition = {
  id: "ecepp",
  name: "EBRD GEP SMART",
  accessMode: "login",
  phase: 2,
  adapterVersion: "2.0.0",
};

export interface EceppAdapterOptions {
  username?: string;
  password?: string;
  fetch?: typeof fetch;
}

interface Cookie {
  domain: string;
  hostOnly: boolean;
  value: string;
}

// A minimal per-scan cookie jar for GEP's chain of identity providers. Cookies
// are never logged, persisted, or included in errors.
class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  store(url: string, response: Response): void {
    const host = new URL(url).hostname;
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      let domain = host;
      let hostOnly = true;
      let expired = value === "";
      for (const attribute of attributes) {
        const [key, attributeValue = ""] = attribute.split("=").map((part) => part.trim());
        if (/^domain$/i.test(key) && attributeValue) {
          domain = attributeValue.replace(/^\./, "").toLowerCase();
          hostOnly = false;
        }
        if (/^max-age$/i.test(key) && Number(attributeValue) <= 0) expired = true;
        if (/^expires$/i.test(key) && Date.parse(attributeValue) <= Date.now()) expired = true;
      }
      if (expired) this.cookies.delete(`${domain}|${name}`);
      else this.cookies.set(`${domain}|${name}`, { domain, hostOnly, value });
    }
  }

  header(url: string): string {
    const host = new URL(url).hostname;
    return [...this.cookies]
      .filter(([, cookie]) => cookie.hostOnly
        ? cookie.domain === host
        : host === cookie.domain || host.endsWith(`.${cookie.domain}`))
      .map(([key, cookie]) => `${key.slice(key.indexOf("|") + 1)}=${cookie.value}`)
      .join("; ");
  }

  value(domain: string, name: string): string | undefined {
    return this.cookies.get(`${domain}|${name}`)?.value;
  }
}

function errorForStatus(status: number): SourceScanError {
  if (status === 429) return new SourceScanError("rate_limited", "GEP SMART rejected the scan because its request limit was reached.", true);
  if (status === 401 || status === 403) return new SourceScanError("access_denied", "GEP SMART denied access to EBRD events.", false);
  return new SourceScanError(status >= 500 ? "source_unavailable" : "request_rejected", `GEP SMART request failed with HTTP ${status}.`, status >= 500);
}

function htmlDecoded(value: string): string {
  return value
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Identity providers hand off with auto-submitting POST forms.
function autoSubmitForm(html: string, base: string): { action: string; body: URLSearchParams } | undefined {
  const form = /<form[^>]*action=["']([^"']*)["'][^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return undefined;
  const body = new URLSearchParams();
  for (const [input] of form[2].matchAll(/<input[^>]*>/gi)) {
    const name = /name=["']([^"']*)["']/i.exec(input)?.[1];
    if (name) body.set(name, htmlDecoded(/value=["']([^"']*)["']/i.exec(input)?.[1] ?? ""));
  }
  return { action: new URL(htmlDecoded(form[1]), base).toString(), body };
}

// GEP's login page encrypts the password with AES-CBC, keyed by the username
// and the anti-forgery token, each zero-padded.
async function encryptedPassword(username: string, password: string, xsrfToken: string): Promise<string> {
  const padded = (value: string, size: number) => (value + "0".repeat(size)).slice(0, size);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(padded(username, 32)), "AES-CBC", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: encoder.encode(padded(xsrfToken, 16)) }, key, encoder.encode(password),
  );
  return btoa(String.fromCharCode(...new Uint8Array(encrypted))).replace("/", "*");
}

function isoInstant(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? new Date(time).toISOString() : undefined;
}

function plainText(value: string | null | undefined): string | undefined {
  return value?.replace(/\s+/g, " ").trim() || undefined;
}

function estimatedValue(detail: GepDetail, description: string | undefined): { amount: number; currency: string } | undefined {
  if (detail.EventValue && detail.EventValue > 0 && detail.EventCurrency) {
    return { amount: detail.EventValue, currency: detail.EventCurrency.toUpperCase() };
  }
  const match = description && COST_ESTIMATE.exec(description);
  if (!match) return undefined;
  const amount = Number(match[2].replaceAll(",", ""));
  return Number.isFinite(amount) && amount > 0 ? { amount, currency: match[1].toUpperCase() } : undefined;
}

function candidateFrom(listing: GepListing, detail: GepDetail, discoveredAt: string): SourceCandidate | undefined {
  const fields = new Map(listing.DocumentSearchOutput.DocumentAdditionalFieldList.map(({ FieldName, FieldValue }) => [FieldName, FieldValue]));
  const title = plainText(detail.EventName) ?? plainText(listing.Name)!;
  const description = plainText(detail.EventDescription);
  const categories = (detail.Doc.DocumentPASList ?? []).map(({ PasName }) => PasName.trim());
  const reference = CONSULTANCY_REFERENCE.exec(title)?.[1];
  if (!reference && !categories.some((name) => /consultancy/i.test(name)) &&
      !CONSULTANCY_TEXT.test(`${title} ${description ?? ""}`)) return undefined;
  const regions = (detail.Doc.DocumentRegionList ?? []).map(({ RegionName }) => RegionName.trim()).filter(Boolean);
  const canonicalUrl = `${SMART}/Sourcing/Rfx?oloc=219&dd=${encodeURIComponent(listing.DocumentSearchOutput.QueryString)}&c=${CLIENT_PARAM}`;
  return {
    sourceId: eceppSourceDefinition.id,
    sourceEventId: listing.DocumentCode,
    sourceOpportunityId: listing.Number ?? listing.DocumentCode,
    canonicalUrl,
    originalEventType: fields.get("RfxEventType") ?? undefined,
    eventType: "tender",
    publishedAt: isoInstant(fields.get("FormatedResponseStart")),
    discoveredAt,
    opportunityName: title,
    description,
    clientName: "EBRD",
    funderNames: ["European Bank for Reconstruction and Development"],
    procuringEntityName: detail.Doc.DocumentLOBDetails?.[0]?.EntityDisplayName,
    value: estimatedValue(detail, description),
    dueDate: isoInstant(fields.get("FormatedResponseEnd")),
    placeOfPerformance: regions.length ? { description: regions.join(", ") } : undefined,
    sourceStatus: listing.DocumentDetails.DocumentStatusInfo,
    sourceData: {
      gepDocumentNumber: listing.Number,
      procurementReference: reference ? `PR ${reference}` : undefined,
      procurementMethod: detail.CustomField?.find(({ customFieldName }) => customFieldName === "Procurement Method")?.customFieldValue,
      categories,
      businessUnits: (detail.Doc.DocumentBUList ?? []).map(({ BusinessUnitName }) => BusinessUnitName),
      valueBasis: "GEP event value, else the stated Event Cost Estimate",
    },
  };
}

export function createEceppAdapter(options: EceppAdapterOptions = {}): SourceAdapter {
  const fetcher = options.fetch ?? fetch;

  return {
    definition: eceppSourceDefinition,
    async scan(context: SourceScanContext): Promise<SourceScanResult> {
      const { username, password } = options;
      if (!username || !password) {
        throw new SourceScanError("credentials_missing", "GEP SMART credentials are not configured.", false);
      }
      const jar = new CookieJar();
      const request = async (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("User-Agent", USER_AGENT);
        const cookie = jar.header(url);
        if (cookie) headers.set("Cookie", cookie);
        let response: Response;
        try {
          response = await fetcher(url, { ...init, headers, redirect: "manual", signal: context.signal });
        } catch {
          throw new SourceScanError("source_unavailable", "GEP SMART request failed before a response was received.", true);
        }
        jar.store(url, response);
        if (response.status >= 400) throw errorForStatus(response.status);
        return response;
      };
      const follow = async (url: string, init?: RequestInit) => {
        let response = await request(url, init);
        for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
          const location = response.headers.get("location");
          if (!location || hop >= 20) {
            throw new SourceScanError("invalid_response", "GEP SMART returned an unexpected sign-in redirect.", true);
          }
          url = new URL(location, url).toString();
          response = await request(url);
        }
        return { url, response };
      };
      const json = async (response: Response) => {
        if (!response.headers.get("content-type")?.includes("application/json")) {
          throw new SourceScanError("access_denied", "GEP SMART did not accept the scanner's session.", false);
        }
        try {
          return await response.json();
        } catch {
          throw new SourceScanError("invalid_response", "GEP SMART returned invalid JSON.", true);
        }
      };

      // Sign in: workspace -> STS -> GEP identity provider login page.
      await (await request(WORKSPACE_URL)).body?.cancel();
      const loginPage = await follow(STS_URL);
      await loginPage.response.body?.cancel();
      const returnUrl = new URL(loginPage.url).searchParams.get("ReturnUrl");
      if (new URL(loginPage.url).origin !== IDP || !returnUrl) {
        throw new SourceScanError("invalid_response", "GEP SMART did not present its expected login page.", true);
      }
      const idpHeaders = () => {
        const xsrf = jar.value("idplogin.gep.com", "XSRF-TOKEN");
        if (!xsrf) throw new SourceScanError("invalid_response", "GEP SMART did not issue a login token.", true);
        return { xsrf, headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": xsrf, Referer: loginPage.url } };
      };
      await (await request(`${IDP}/Account/Logon`, {
        method: "POST", headers: idpHeaders().headers, body: JSON.stringify({ username, returnUrl }),
      })).body?.cancel();
      const { xsrf, headers } = idpHeaders();
      const login = loginSchema.safeParse(await json(await request(`${IDP}/Account/Login`, {
        method: "POST",
        headers,
        body: JSON.stringify({ username, password: await encryptedPassword(username, password, xsrf), returnUrl, culture: "en-US" }),
      })));
      if (!login.success) throw new SourceScanError("invalid_response", "GEP SMART returned an unexpected login response.", true);
      if (login.data.requiresTwoFactor) {
        throw new SourceScanError("two_factor_required", "GEP SMART now requires a verification code for the scanner account.", false);
      }
      if (login.data.isLockedOut) throw new SourceScanError("account_locked", "The GEP SMART scanner account is locked.", false);
      if (login.data.mustChangePassword) {
        throw new SourceScanError("password_change_required", "The GEP SMART scanner account must change its password.", false);
      }
      if (!login.data.isLoggedIn) throw new SourceScanError("access_denied", "GEP SMART rejected the scanner credentials.", false);

      // Follow the OIDC and WS-Federation hand-offs back to the workspace.
      let page = await follow(new URL(returnUrl, IDP).toString());
      for (let hop = 0; new URL(page.url).origin !== SMART || new URL(page.url).pathname !== "/Smart"; hop++) {
        const form = hop < 5 ? autoSubmitForm(await page.response.text(), page.url) : undefined;
        if (!form) throw new SourceScanError("invalid_response", "GEP SMART did not complete its sign-in hand-off.", true);
        page = await follow(form.action, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.body,
        });
      }
      await page.response.body?.cancel();

      // Read the complete RFx catalogue visible to the account.
      const listings: GepListing[] = [];
      let total = 0;
      for (let pageNumber = 1; pageNumber === 1 || listings.length < total; pageNumber++) {
        if (pageNumber > MAX_PAGES) {
          throw new SourceScanError("invalid_response", "GEP SMART returned more events than the supported snapshot limit.", true);
        }
        const parsed = listSchema.safeParse(await json(await request(`${SMART}/api/ManageData?oloc=281`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            searchKeyword: "", globalSearchText: "", AdvanceSearchInput: [],
            Filters: ["moduleScope:rfx", `pageNumber:${pageNumber}`, `noOfRecords:${PAGE_SIZE}`, "isSeeAllResult:true", "sortField:SORT_DateModified|DESC", "fieldkey:"],
          }),
        })));
        if (!parsed.success) throw new SourceScanError("invalid_response", "GEP SMART returned an unexpected event list.", true);
        const records = parsed.data.DataSearchResult.Value ?? [];
        total = parsed.data.DataSearchResult.GroupTotal.rfx;
        listings.push(...records);
        if (records.length === 0) break;
      }
      if (listings.length !== total || new Set(listings.map(({ DocumentCode }) => DocumentCode)).size !== total) {
        throw new SourceScanError("invalid_response", "GEP SMART returned an incomplete or shifting event list.", true);
      }

      const now = context.now.toISOString();
      const scoped = listings.filter((listing) => {
        const closing = isoInstant(listing.DocumentSearchOutput.DocumentAdditionalFieldList
          .find(({ FieldName }) => FieldName === "FormatedResponseEnd")?.FieldValue);
        return closing !== undefined && closing > now && !CLOSED_STATUS.test(listing.DocumentDetails.DocumentStatusInfo);
      });
      if (scoped.length > MAX_ENRICHMENTS) {
        throw new SourceScanError("invalid_response", "GEP SMART returned more open events than the supported enrichment limit.", true);
      }
      const candidates: SourceCandidate[] = [];
      for (let offset = 0; offset < scoped.length; offset += ENRICHMENT_CONCURRENCY) {
        const batch = scoped.slice(offset, offset + ENRICHMENT_CONCURRENCY);
        const details = await Promise.all(batch.map(async (listing) => {
          const detail = detailSchema.safeParse(await json(await request(
            `${SMART}/api/SourcingService/BasicDetails/Get?oloc=219&c=${CLIENT_PARAM}`,
            { headers: { Accept: "application/json", dd: listing.DocumentSearchOutput.QueryString } },
          )));
          if (!detail.success || String(detail.data.DocumentCode) !== listing.DocumentCode) {
            throw new SourceScanError("invalid_record", `GEP SMART returned unexpected details for event ${listing.DocumentCode}.`, true);
          }
          return detail.data;
        }));
        batch.forEach((listing, index) => {
          const candidate = candidateFrom(listing, details[index], now);
          if (candidate) candidates.push(candidate);
        });
      }
      candidates.sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "") || (a.sourceEventId ?? "").localeCompare(b.sourceEventId ?? ""));
      return { candidates, nextCursor: { value: now } };
    },
  };
}
