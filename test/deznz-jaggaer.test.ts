import { describe, expect, it } from "vitest";
import detailFixture from "./fixtures/deznz-jaggaer-detail.html?raw";
import listFixture from "./fixtures/deznz-jaggaer-list.html?raw";
import { assertValidSourceAdapter } from "../src/sources/adapter";
import { createDeznzJaggaerAdapter } from "../src/sources/deznz-jaggaer";

const baseUrl = "https://beisgroup.ukp.app.jaggaer.com";
const entryUrl = `${baseUrl}/esop/guest/go/public/opportunity/current`;
const visitorId = "fixture-visitor";
const listUrl =
  `${baseUrl}/esop/toolkit/opportunity/current/list.si?reset=true&VISITORID=${visitorId}&_ncp=fixture`;
const now = new Date("2026-09-02T10:00:00.000Z");

interface DetailFields {
  projectCode: string;
  projectTitle: string;
  projectDescription: string;
  workCategory?: string;
  procurementRoute: string;
  listingDeadline: string;
  buyerOrganisation: string;
  estimatedValue?: string;
}

function scanContext() {
  return {
    signal: new AbortController().signal,
    now,
  };
}

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=UTF-8");
  return new Response(html, { ...init, headers });
}

function field(label: string, value: string | undefined): string {
  return value === undefined
    ? ""
    : `<li class="FormField FormField-large">
        <div class="form_question"><div class="form_question_label">${label}</div></div>
        <div class="form_answer">${value}</div>
      </li>`;
}

function detailHtml(fields: DetailFields): string {
  return `<!doctype html><html lang="en-GB">
    <head><title>Project: ${fields.projectCode} - ${fields.projectTitle} (BEIS)</title></head><body><ul>
      ${field("Project Code", fields.projectCode)}
      ${field("Project Title", fields.projectTitle)}
      ${field("Project Description", fields.projectDescription)}
      ${field("Work Category", fields.workCategory ?? "Services")}
      ${field("Procurement Route", fields.procurementRoute)}
      ${field("Listing Deadline", fields.listingDeadline)}
      ${field("Contract Start Date", "01/12/2026")}
      ${field("Contract Duration", "24 months")}
      ${field("Estimated Value of Contract", fields.estimatedValue)}
      ${field("Buyer Organisation", fields.buyerOrganisation)}
    </ul></body></html>`;
}

const details: Record<string, string> = {
  "60694": detailFixture,
  "60672": detailHtml({
    projectCode: "prj_5038",
    projectTitle: "Biomass Research Programme",
    projectDescription: "DESNZ requires research and technical advisory services for biomass policy.",
    procurementRoute: "Procurement Act – Open",
    listingDeadline: "13/10/2026 17:00",
    buyerOrganisation: "DESNZ &amp; DSIT Group Commercial",
    estimatedValue: "£4,080,000 plus VAT",
  }),
  "60920": detailHtml({
    projectCode: "prj_6766",
    projectTitle: "Consumer protection reform",
    projectDescription: "Research and advisory services to support consumer protection reform.",
    procurementRoute: "Procurement Act – Competitive Flexible",
    listingDeadline: "01/03/2027 23:00",
    buyerOrganisation: "Department for Energy Security and Net Zero",
    estimatedValue: "60000000",
  }),
  "55805": detailHtml({
    projectCode: "prj_1220",
    projectTitle: "Government Office for Technology Transfer DPS",
    projectDescription: "A DSIT commercial vehicle for technology transfer services.",
    procurementRoute: "Dynamic Purchasing System (DPS)",
    listingDeadline: "31/03/2027 23:59",
    buyerOrganisation: "DESNZ &amp; DSIT Group Commercial",
    estimatedValue: "£10,000,000",
  }),
};

function mockSource(options: {
  entryResponse?: Response;
  listResponse?: Response;
  detailOverrides?: Record<string, Response>;
} = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    requests.push({ url, init });
    if (url === entryUrl) {
      return options.entryResponse ?? new Response(null, {
        status: 302,
        headers: { Location: listUrl },
      });
    }
    if (new URL(url).pathname === "/esop/toolkit/opportunity/current/list.si") {
      return options.listResponse ?? htmlResponse(listFixture);
    }
    const opportunityId = /\/opportunity\/current\/(\d+)\/detail\.si/.exec(url)?.[1];
    if (!opportunityId || !details[opportunityId]) throw new Error(`Unexpected request: ${url}`);
    return options.detailOverrides?.[opportunityId] ?? htmlResponse(details[opportunityId]);
  }) as typeof fetch;
  return { fetcher, requests };
}

describe("DEZNZ Jaggaer Source adapter", () => {
  it("maps the complete public service-opportunity snapshot and excludes non-DEZNZ buyers", async () => {
    const source = mockSource();
    const adapter = createDeznzJaggaerAdapter({
      fetch: source.fetcher,
      requestDelayMs: 0,
    });
    assertValidSourceAdapter(adapter);

    const result = await adapter.scan(scanContext());

    expect(source.requests).toHaveLength(6);
    expect(source.requests[0].url).toBe(entryUrl);
    expect(source.requests[0].init?.redirect).toBe("manual");
    expect(new Headers(source.requests[0].init?.headers).get("User-Agent"))
      .toContain("proc-scan/1.0");
    expect(source.requests[1].url).toBe(listUrl);
    expect(source.requests.slice(2).map(({ url }) => new URL(url).pathname)).toEqual([
      "/esop/toolkit/opportunity/current/60694/detail.si",
      "/esop/toolkit/opportunity/current/60672/detail.si",
      "/esop/toolkit/opportunity/current/60920/detail.si",
      "/esop/toolkit/opportunity/current/55805/detail.si",
    ]);
    expect(result.nextCursor).toEqual({ value: now.toISOString() });
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId)).toEqual([
      "60694",
      "60672",
      "60920",
    ]);
    expect(result.candidates[0]).toMatchObject({
      sourceId: "deznz-jaggaer",
      sourceOpportunityId: "prj_5040",
      canonicalUrl: entryUrl,
      originalEventType: "Procurement Act – Open",
      eventType: "tender",
      opportunityName: "Greenhouse Gas Inventory Improvement Programme 2",
      description: expect.stringContaining("specialist technical research and advisory support"),
      clientName: "DEZNZ",
      procuringEntityName: "DESNZ & DSIT Group Commercial",
      value: { amount: 4_300_000, currency: "GBP" },
      dueDate: "2026-09-27T15:00:00.000Z",
      sourceStatus: "current",
      sourceData: {
        jaggaerOpportunityId: "60694",
        projectCode: "prj_5040",
        procurementRoute: "Procurement Act – Open",
        workCategory: "Services",
        buyerOrganisation: "DESNZ & DSIT Group Commercial",
        clientMappingBasis: "project-description",
        rawEstimatedValue: "Lot A £3.01m (excl VAT) Lot B £1.29m (excl VAT)",
        valueBasis: "sum-of-lot-estimates",
        contractStartDate: "07/12/2026",
        contractDuration: "3 years 4 months",
        deadlineBasis: "listing-deadline-europe-london",
      },
    });
    expect(result.candidates[0].documents).toHaveLength(2);
    expect(result.candidates[1]).toMatchObject({
      sourceOpportunityId: "prj_5038",
      value: { amount: 4_080_000, currency: "GBP" },
      dueDate: "2026-10-13T16:00:00.000Z",
      sourceData: { valueBasis: "estimated-value-of-contract" },
    });
    expect(result.candidates[2]).toMatchObject({
      sourceOpportunityId: "prj_6766",
      value: undefined,
      dueDate: "2027-03-01T23:00:00.000Z",
      sourceData: {
        clientMappingBasis: "exact-buyer",
        rawEstimatedValue: "60000000",
        valueBasis: undefined,
      },
    });
    expect(JSON.stringify(result)).not.toContain(visitorId);
    expect(JSON.stringify(result)).not.toContain("61000");
    expect(JSON.stringify(result)).not.toContain("55805");
  });

  it("requires a same-origin public visitor redirect with no persistent credentials", async () => {
    const missingRedirect = mockSource({ entryResponse: htmlResponse("<p>Login</p>") });
    await expect(createDeznzJaggaerAdapter({
      fetch: missingRedirect.fetcher,
      requestDelayMs: 0,
    }).scan(scanContext())).rejects.toMatchObject({ code: "invalid_session" });

    const externalRedirect = mockSource({
      entryResponse: new Response(null, {
        status: 302,
        headers: { Location: "https://example.com/session?VISITORID=secret" },
      }),
    });
    await expect(createDeznzJaggaerAdapter({
      fetch: externalRedirect.fetcher,
      requestDelayMs: 0,
    }).scan(scanContext())).rejects.toMatchObject({ code: "invalid_session" });

    const expiredDetailSession = mockSource({
      detailOverrides: {
        "60694": new Response(null, { status: 302, headers: { Location: entryUrl } }),
      },
    });
    await expect(createDeznzJaggaerAdapter({
      fetch: expiredDetailSession.fetcher,
      requestDelayMs: 0,
    }).scan(scanContext())).rejects.toMatchObject({
      code: "invalid_session",
      retryable: true,
    });
  });

  it("fails closed on incomplete snapshots and inconsistent detail fields", async () => {
    const incomplete = mockSource({
      listResponse: htmlResponse(listFixture.replace(
        'class="textB js-fullsize-cnt">5',
        'class="textB js-fullsize-cnt">6',
      )),
    });
    await expect(createDeznzJaggaerAdapter({
      fetch: incomplete.fetcher,
      requestDelayMs: 0,
    }).scan(scanContext())).rejects.toMatchObject({ code: "invalid_pagination" });

    const inconsistent = mockSource({
      detailOverrides: {
        "60694": htmlResponse(detailFixture.replaceAll(
          "Greenhouse Gas Inventory Improvement Programme 2",
          "Unexpected project title",
        )),
      },
    });
    await expect(createDeznzJaggaerAdapter({
      fetch: inconsistent.fetcher,
      requestDelayMs: 0,
    }).scan(scanContext())).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("rejects missing fields and invalid UK-local deadlines", async () => {
    const missing = mockSource({
      detailOverrides: {
        "60694": htmlResponse(detailFixture.replace("Project Code", "Unknown Field")),
      },
    });
    await expect(createDeznzJaggaerAdapter({
      fetch: missing.fetcher,
      requestDelayMs: 0,
    }).scan(scanContext())).rejects.toMatchObject({ code: "invalid_record" });

    const invalidDate = mockSource({
      detailOverrides: {
        "60694": htmlResponse(detailFixture.replaceAll("27/09/2026 16:00", "31/02/2027 16:00")),
      },
    });
    await expect(createDeznzJaggaerAdapter({
      fetch: invalidDate.fetcher,
      requestDelayMs: 0,
    }).scan(scanContext())).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("classifies HTTP and content-type failures without reflecting response content", async () => {
    const unavailable = mockSource({
      entryResponse: new Response("internal-do-not-reflect", { status: 503 }),
    });
    const error = await createDeznzJaggaerAdapter({
      fetch: unavailable.fetcher,
      requestDelayMs: 0,
    }).scan(scanContext()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source_unavailable", retryable: true });
    expect(String(error)).not.toContain("internal-do-not-reflect");

    const nonHtml = mockSource({ listResponse: Response.json({ opportunities: [] }) });
    await expect(createDeznzJaggaerAdapter({
      fetch: nonHtml.fetcher,
      requestDelayMs: 0,
    }).scan(scanContext())).rejects.toMatchObject({ code: "invalid_response" });
  });
});
