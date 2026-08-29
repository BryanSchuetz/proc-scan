import { describe, expect, it } from "vitest";
import taxonomyRaw from "../tech-area-classification.yaml?raw";
import classificationRaw from "../config/technical-classification.yaml?raw";
import euFundingTendersRaw from "../config/eu-funding-tenders.yaml?raw";
import grantsGovRaw from "../config/grants-gov.yaml?raw";
import samGovRaw from "../config/sam-gov.yaml?raw";
import tedRaw from "../config/ted.yaml?raw";
import {
  classifyTechnicalAreas,
  flattenTaxonomy,
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
  validateTechnicalClassification,
} from "../src/classification/taxonomy";
import {
  parseEuFundingTendersConfig,
  validateEuFundingTendersClientScope,
} from "../src/sources/eu-funding-tenders";
import { parseGrantsGovConfig, validateGrantsGovScope } from "../src/sources/grants-gov";
import { parseSamGovConfig } from "../src/sources/sam-gov";
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
  it("loads the active external-aid search with the approved DG clients", () => {
    expect(parseTedConfig(tedRaw)).toEqual({
      schema_version: 1,
      funding: "external-aid-program",
      clients: [
        "DG AGRI",
        "DG CLIMA",
        "DG ECHO",
        "DG CINEA",
        "DG GROW",
        "DG IDEA",
        "DG REA",
        "DG INTPA",
        "DG DEV",
        "DG ENEST",
        "DG MENA",
        "DG TRADE",
      ],
      sort: "publication-number DESC",
      scope: "ACTIVE",
      only_latest_versions: false,
      pursuable_form_types: ["planning", "competition"],
      page_size: 250,
    });
  });

  it("rejects duplicate clients", () => {
    expect(() => parseTedConfig(`
schema_version: 1
funding: external-aid-program
clients: [DG INTPA, DG INTPA]
sort: publication-number DESC
scope: ACTIVE
only_latest_versions: false
pursuable_form_types: [competition]
page_size: 250
`)).toThrow("Duplicate TED client");
  });

  it("rejects duplicate pursuable form types", () => {
    expect(() => parseTedConfig(`
schema_version: 1
funding: external-aid-program
clients: [DG INTPA]
sort: publication-number DESC
scope: ACTIVE
only_latest_versions: false
pursuable_form_types: [competition, competition]
page_size: 250
`)).toThrow("Duplicate TED pursuable form type");
  });
});

describe("EU Funding & Tenders configuration", () => {
  it("loads open tender calls with the same approved clients as TED", () => {
    const portal = parseEuFundingTendersConfig(euFundingTendersRaw);
    const ted = parseTedConfig(tedRaw);

    expect(() => validateEuFundingTendersClientScope(portal, ted.clients)).not.toThrow();
    expect(portal).toEqual({
      schema_version: 1,
      opportunity_type: "calls-for-tenders",
      pursuable_statuses: ["forthcoming", "open"],
      clients: ted.clients,
      language: "en",
      sort: "startDate DESC",
      page_size: 100,
    });
  });

  it("rejects duplicate clients and a client scope that drifts from TED", () => {
    expect(() => parseEuFundingTendersConfig(`
schema_version: 1
opportunity_type: calls-for-tenders
pursuable_statuses: [open]
clients: [DG INTPA, DG INTPA]
language: en
sort: startDate DESC
page_size: 100
`)).toThrow("Duplicate EU Funding & Tenders client");

    const portal = parseEuFundingTendersConfig(euFundingTendersRaw);
    expect(() => validateEuFundingTendersClientScope(portal, ["DG INTPA"])).toThrow(
      "EU Funding & Tenders clients must match the approved TED client scope",
    );
  });
});
