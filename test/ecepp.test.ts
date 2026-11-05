import { describe, expect, it } from "vitest";
import list from "./fixtures/ecepp-list.json";
import details from "./fixtures/ecepp-details.json";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createEceppAdapter } from "../src/sources/ecepp";
import { createRegisteredSourceAdapter } from "../src/sources";
import type { SourceConfigurations } from "../src/sources";

const now = new Date("2026-11-05T12:00:00.000Z");
const context = { signal: new AbortController().signal, now };
const username = "supplier-user";
const password = "correct horse/battery";
const workspace = "https://eu.smart.gep.com/Smart?oloc=200&c=NzAwMjE4Njk1&dd=YnBjPTcwMDIxODY5JmNjPTU0NzEwMzA0MDAwMDA00";
const returnUrl = "/connect/authorize/callback?client_id=mvc&state=fixture";

interface FakeGepOptions {
  login?: Record<string, unknown>;
  listResponse?: () => Response;
}

// Simulates GEP's identity-provider chain. Each hop requires the cookies set by
// the previous hops, and the server decrypts the password the way GEP does.
function fakeGep(options: FakeGepOptions = {}) {
  const requested: string[] = [];
  const json = (body: unknown, headers: HeadersInit = {}) =>
    Response.json(body, { headers });
  const html = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { headers: { "Content-Type": "text/html", ...headers } });
  const redirect = (location: string, cookie?: string) => {
    const headers = new Headers({ Location: location });
    if (cookie) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  };

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const headers = new Headers(init?.headers);
    const cookies = headers.get("Cookie") ?? "";
    const route = `${init?.method ?? "GET"} ${url.origin}${url.pathname}`;
    requested.push(route);
    expect(init?.redirect).toBe("manual");

    switch (route) {
      case "GET https://eu.smart.gep.com/Smart":
        return html("<title>Working.....</title>", { "Set-Cookie": "ASP.NET_SessionId=s1; path=/; HttpOnly" });
      case "GET https://smart-sts.gep.com/default.aspx":
        expect(url.searchParams.get("wreply")).toBe(workspace);
        return redirect(`https://idplogin.gep.com/Login?ReturnUrl=${encodeURIComponent(returnUrl)}`, "fedstate=f1; path=/; secure");
      case "GET https://idplogin.gep.com/Login":
        return html("<app-root></app-root>", { "Set-Cookie": "XSRF-TOKEN=first-token-value-123; path=/" });
      case "POST https://idplogin.gep.com/Account/Logon":
        expect(headers.get("X-XSRF-TOKEN")).toBe("first-token-value-123");
        expect(JSON.parse(String(init?.body))).toEqual({ username, returnUrl });
        return json({ userType: "Supplier" }, { "Set-Cookie": "XSRF-TOKEN=rotated-token-abcdefgh; path=/" });
      case "POST https://idplogin.gep.com/Account/Login": {
        expect(headers.get("X-XSRF-TOKEN")).toBe("rotated-token-abcdefgh");
        const body = JSON.parse(String(init?.body));
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode("supplier-user0000000000000000000"), "AES-CBC", false, ["decrypt"]);
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-CBC", iv: encoder.encode("rotated-token-ab") },
          key,
          Uint8Array.from(atob(body.password.replace(/\*/g, "/")), (character) => character.charCodeAt(0)),
        );
        const loggedIn = new TextDecoder().decode(decrypted) === password;
        return json(options.login ?? { isLoggedIn: loggedIn, isInvalidCredentials: !loggedIn, requiresTwoFactor: false },
          { "Set-Cookie": "idsrv=signed-in; path=/; HttpOnly" });
      }
      case "GET https://idplogin.gep.com/connect/authorize/callback":
        expect(cookies).toContain("idsrv=signed-in");
        return html("<form method='post' action='https://smart-sts.gep.com/signin-oidc'><input type='hidden' name='code' value='c1' /><input type='hidden' name='iss' value='https://smart-auth.gep.com' /></form>");
      case "POST https://smart-sts.gep.com/signin-oidc":
        expect(String(init?.body)).toBe("code=c1&iss=https%3A%2F%2Fsmart-auth.gep.com");
        expect(cookies).toContain("fedstate=f1");
        return redirect("/Default?gepoa=OASignIn", "stsauth=a1; path=/");
      case "GET https://smart-sts.gep.com/Default":
        expect(cookies).toContain("stsauth=a1");
        return html(`<form method="POST" action="${workspace.replaceAll("&", "&amp;")}"><input type="hidden" name="smartauthtoken" value="t&amp;1" /></form>`);
      case "POST https://eu.smart.gep.com/Smart":
        expect(String(init?.body)).toBe("smartauthtoken=t%261");
        expect(cookies).toContain("ASP.NET_SessionId=s1");
        return html("<title>WORKSPACE</title>", { "Set-Cookie": "SmartAuth0=w1; domain=.smart.gep.com; path=/" });
      case "POST https://eu.smart.gep.com/api/ManageData": {
        expect(cookies).toContain("SmartAuth0=w1");
        if (options.listResponse) return options.listResponse();
        const filters: string[] = JSON.parse(String(init?.body)).Filters;
        const page = Number(filters.find((filter) => filter.startsWith("pageNumber:"))!.split(":")[1]);
        // Return two records per page to exercise pagination.
        return json({ DataSearchResult: { ...list.DataSearchResult, Value: list.DataSearchResult.Value.slice((page - 1) * 2, page * 2) } });
      }
      case "GET https://eu.smart.gep.com/api/SourcingService/BasicDetails/Get": {
        expect(cookies).toContain("SmartAuth0=w1");
        const code = /dc=(\d+)/.exec(atob(headers.get("dd")!.slice(0, -1)))![1];
        requested.push(`detail ${code}`);
        return json(details[code as keyof typeof details]);
      }
      default:
        throw new Error(`Unexpected request ${route}`);
    }
  }) as typeof fetch;
  return { fetcher, requested };
}

describe("EBRD GEP SMART Source adapter", () => {
  it("is registered for production scans with its credentials", () => {
    const adapter = createRegisteredSourceAdapter("ecepp", { NEW_EBRD_USER: username, NEW_EBRD_PW: password }, {} as SourceConfigurations);
    expect(adapter.definition).toMatchObject({ id: "ecepp", accessMode: "login", phase: 2 });
  });

  it("signs in, reads every page, and retains open consultancy events", async () => {
    const gep = fakeGep();
    const adapter = createEceppAdapter({ username, password, fetch: gep.fetcher });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(context);

    expect(gep.requested.filter((route) => route.endsWith("/api/ManageData"))).toHaveLength(3);
    // Withdrawn, past-closing, and awarded events are not enriched.
    expect(gep.requested.filter((route) => route.startsWith("detail "))).toEqual(["detail 200001", "detail 200002", "detail 200003"]);
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId)).toEqual(["200003", "200001"]);
    expect(result.candidates[1]).toMatchObject({
      sourceId: "ecepp",
      sourceEventId: "200001",
      sourceOpportunityId: "009001-Oct2026",
      canonicalUrl: "https://eu.smart.gep.com/Sourcing/Rfx?oloc=219&dd=ZGM9MjAwMDAxJmJwYz03MDAyMTg2OQ2&c=NzAwMjE4Njk1",
      eventType: "tender",
      originalEventType: "Request for Proposal",
      publishedAt: "2026-11-02T15:00:00.000Z",
      dueDate: "2026-11-24T10:59:00.000Z",
      opportunityName: "PR 030001 - Moldova - Energy Efficiency Expert",
      description: "Procurement of an expert to strengthen the national energy centre. Event Cost Estimate: EUR 175,000.00 (exclusive of VAT) Clarification questions can be submitted via the discussion forum.",
      clientName: "EBRD",
      procuringEntityName: "EBRD",
      value: { amount: 175_000, currency: "EUR" },
      placeOfPerformance: { description: "Moldova" },
      sourceStatus: "ResponseInProgress",
      sourceData: { procurementReference: "PR 030001", procurementMethod: "Competitive (Single-stage)", categories: ["Legal Reform & Policy"] },
    });
    // A consultancy category qualifies without a PR reference; an undetermined estimate stays unknown.
    expect(result.candidates[0]).toMatchObject({ sourceEventId: "200003", placeOfPerformance: { description: "Armenia, Georgia" } });
    expect(result.candidates[0].value).toBeUndefined();
  });

  it("fails without retrying on missing, rejected, or second-factor sign-ins", async () => {
    const unconfigured = fakeGep();
    await expect(createEceppAdapter({ fetch: unconfigured.fetcher }).scan(context))
      .rejects.toMatchObject({ code: "credentials_missing", retryable: false });
    expect(unconfigured.requested).toEqual([]);

    const rejected = await createEceppAdapter({ username, password: "wrong", fetch: fakeGep().fetcher })
      .scan(context).catch((caught: unknown) => caught);
    expect(rejected).toMatchObject({ code: "access_denied", retryable: false });
    expect(String(rejected)).not.toContain("wrong");

    const mfa = fakeGep({ login: { isLoggedIn: false, requiresTwoFactor: true } });
    await expect(createEceppAdapter({ username, password, fetch: mfa.fetcher }).scan(context))
      .rejects.toMatchObject({ code: "two_factor_required", retryable: false });
    expect(mfa.requested.some((route) => route.includes("ManageData"))).toBe(false);
  });

  it("fails safely when the session is not accepted or the list drifts", async () => {
    const expired = fakeGep({ listResponse: () => new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }) });
    await expect(createEceppAdapter({ username, password, fetch: expired.fetcher }).scan(context))
      .rejects.toMatchObject({ code: "access_denied" });

    const incomplete = fakeGep({ listResponse: () => Response.json({ DataSearchResult: { ...list.DataSearchResult, GroupTotal: { rfx: 7 } } }) });
    await expect(createEceppAdapter({ username, password, fetch: incomplete.fetcher }).scan(context))
      .rejects.toMatchObject({ code: "invalid_response", retryable: true });
  });
});
