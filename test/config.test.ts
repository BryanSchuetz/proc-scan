import { describe, expect, it } from "vitest";
import taxonomyRaw from "../tech-area-classification.yaml?raw";
import classificationRaw from "../config/technical-classification.yaml?raw";
import dgMarketRaw from "../config/dg-market.yaml?raw";
import euFundingTendersRaw from "../config/eu-funding-tenders.yaml?raw";
import grantsGovRaw from "../config/grants-gov.yaml?raw";
import mccDgMarketRaw from "../config/mcc-dg-market.yaml?raw";
import samGovRaw from "../config/sam-gov.yaml?raw";
import simapRaw from "../config/simap.yaml?raw";
import tedRaw from "../config/ted.yaml?raw";
import {
  classifyTechnicalAreas,
  flattenTaxonomy,
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
  validateTechnicalClassification,
} from "../src/classification/taxonomy";
import { parseDgMarketConfig } from "../src/sources/dg-market";
import { parseEuFundingTendersConfig } from "../src/sources/eu-funding-tenders";
import { parseGrantsGovConfig, validateGrantsGovScope } from "../src/sources/grants-gov";
import { parseMccDgMarketConfig } from "../src/sources/mcc-dg-market";
import { parseSamGovConfig } from "../src/sources/sam-gov";
import { parseSimapConfig } from "../src/sources/simap";
import { parseTedConfig } from "../src/sources/ted";

const taxonomy = parseTaxonomyYaml(taxonomyRaw);
const config = parseTechnicalClassificationYaml(classificationRaw);

describe("Technical Area configuration", () => {
  it("loads all unique taxonomy labels and resolves every alias collision", () => {
    expect(flattenTaxonomy(taxonomy)).toHaveLength(39);
    expect(() => validateTechnicalClassification(taxonomy, config)).not.toThrow();
  });

  it("assigns specific multi-word labels deterministically", () => {
    const result = classifyTechnicalAreas(
      "The work includes a digital ecosystem assessment and digital transformation advisory.",
      taxonomy,
      config,
    );
    expect(result.map((area) => area.id)).toContain("digital-strategy-and-advisory");
    expect(result.map((area) => area.id)).not.toContain("digital");
  });

  it("does not classify a generic one-word match without support", () => {
    expect(classifyTechnicalAreas("The programme is digital.", taxonomy, config)).toEqual([]);
  });

  it("uses context to resolve overlapping aliases", () => {
    const result = classifyTechnicalAreas(
      "Biodiversity conservation focused on marine conservation and protected areas.",
      taxonomy,
      config,
    );
    expect(result.map((area) => area.id)).toContain("nature-oceans-and-biodiversity");
    expect(result.map((area) => area.id)).not.toContain("climate-and-environment");
  });
});

describe("SAM.gov configuration", () => {
  it("loads the four approved federal organizations", () => {
    expect(parseSamGovConfig(samGovRaw).organizations).toEqual([
      { code: "524", name: "Millennium Challenge Corporation" },
      { code: "077", name: "United States International Development Finance Corporation" },
      { code: "011", name: "United States Trade and Development Agency" },
      { code: "019", name: "State, Department of" },
    ]);
  });

  it("rejects duplicate organization codes", () => {
    expect(() => parseSamGovConfig(`
schema_version: 1
organizations:
  - code: "524"
    name: First
  - code: "524"
    name: Duplicate
`)).toThrow("Duplicate SAM.gov organization code: 524");
  });
});

describe("Grants.gov configuration", () => {
  it("uses the same four approved federal organizations as SAM.gov", () => {
    const grantsGov = parseGrantsGovConfig(grantsGovRaw);
    const samGov = parseSamGovConfig(samGovRaw);

    expect(() => validateGrantsGovScope(grantsGov, samGov.organizations)).not.toThrow();
    expect(grantsGov.organizations.map(({ code, agency_code: agencyCode }) => ({
      code,
      agencyCode,
    }))).toEqual([
      { code: "524", agencyCode: "MCC" },
      { code: "077", agencyCode: null },
      { code: "011", agencyCode: null },
      { code: "019", agencyCode: "DOS" },
    ]);
  });

  it("rejects a federal scope that drifts from SAM.gov", () => {
    const grantsGov = parseGrantsGovConfig(grantsGovRaw);
    expect(() => validateGrantsGovScope(grantsGov, [{ code: "524" }])).toThrow(
      "Grants.gov federal organization codes must match the approved SAM.gov scope",
    );
  });
});

describe("TED configuration", () => {
  it("loads the active external-aid services search for the selected business opportunities", () => {
    expect(parseTedConfig(tedRaw)).toEqual({
      schema_version: 1,
      funding: "external-aid-program",
      contract_nature: "services",
      sort: "publication-number DESC",
      scope: "ACTIVE",
      only_latest_versions: false,
      pursuable_form_types: ["result", "competition", "planning"],
      page_size: 250,
    });
  });

  it("rejects duplicate pursuable form types", () => {
    expect(() => parseTedConfig(`
schema_version: 1
funding: external-aid-program
contract_nature: services
sort: publication-number DESC
scope: ACTIVE
only_latest_versions: false
pursuable_form_types: [competition, competition]
page_size: 250
`)).toThrow("Duplicate TED pursuable form type");
  });
});

describe("EU Funding & Tenders configuration", () => {
  it("loads open tender calls without a client filter", () => {
    const portal = parseEuFundingTendersConfig(euFundingTendersRaw);

    expect(portal).toEqual({
      schema_version: 1,
      opportunity_type: "calls-for-tenders",
      pursuable_statuses: ["forthcoming", "open"],
      language: "en",
      sort: "startDate DESC",
      page_size: 100,
    });
  });

  it("rejects duplicate pursuable statuses", () => {
    expect(() => parseEuFundingTendersConfig(`
schema_version: 1
opportunity_type: calls-for-tenders
pursuable_statuses: [open, open]
language: en
sort: startDate DESC
page_size: 100
`)).toThrow("Duplicate EU Funding & Tenders pursuable status");
  });
});

describe("SIMAP configuration", () => {
  it("loads public service-tender searches for SDC and SECO", () => {
    const simap = parseSimapConfig(simapRaw);
    expect(simap.client).toBe("Swiss-SDC/SECO");
    expect(simap.organizations.map(({ id, search }) => ({ id, search }))).toEqual([
      { id: "sdc", search: "SDC" },
      { id: "seco", search: "SECO" },
    ]);
  });

  it("rejects duplicate organization IDs", () => {
    expect(() => parseSimapConfig(simapRaw.replace("id: seco", "id: sdc"))).toThrow(
      "Duplicate SIMAP organization ID",
    );
  });
});

describe("dgMarket configuration", () => {
  it("loads the MCC and MCA client scope", () => {
    const dgMarket = parseDgMarketConfig(dgMarketRaw);
    expect(dgMarket.clients).toEqual(["MCC", "MCA"]);
    expect(dgMarket.funding_agency).toEqual({
      funding_agency_id: "1385098",
      funding_agency_name: "Millennium Challenge Corporation (MCC)",
    });
    expect(dgMarket.notice_category).toEqual({ code: "2", name: "Consultancy" });
  });

  it("rejects a duplicate client", () => {
    expect(() => parseDgMarketConfig(dgMarketRaw.replace("  - MCA", "  - MCC"))).toThrow(
      "dgMarket client scope must contain MCC and MCA exactly once",
    );
  });
});

describe("MCCDGMarket configuration", () => {
  it("loads the MCC and MCA client scope", () => {
    const mccDgMarket = parseMccDgMarketConfig(mccDgMarketRaw);
    expect(mccDgMarket.clients).toEqual(["MCC", "MCA"]);
    expect(mccDgMarket.pursuable_notice_types).toEqual(["spn", "gpn", "rei", "pp"]);
  });

  it("rejects a duplicate client", () => {
    expect(() => parseMccDgMarketConfig(mccDgMarketRaw.replace("  - MCA", "  - MCC"))).toThrow(
      "MCCDGMarket client scope must contain MCC and MCA exactly once",
    );
  });
});
