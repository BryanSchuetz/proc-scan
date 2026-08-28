import { describe, expect, it } from "vitest";
import addressabilityRaw from "../config/addressability.yaml?raw";
import { assessAddressability, parseAddressabilityYaml } from "../src/classification/addressability";
import { biddingEvent } from "./fixtures";

const activeConfig = parseAddressabilityYaml(`
schema_version: 3
status: active
threshold: 8
hard_exclusions:
  - id: blocked-client
    description: Client is outside the addressable market
    conditions:
      all:
        - field: clientName
          operator: equals
          value: Blocked Agency
scoring_rules:
  - id: preferred-client
    description: Preferred Client
    points: 5
    conditions:
      all:
        - field: clientName
          operator: equals
          value: Development Agency
  - id: minimum-value
    description: Sufficient contract value
    points: 4
    conditions:
      all:
        - field: value.amount
          operator: gte
          value: 3000000
`);
const configuredRules = parseAddressabilityYaml(addressabilityRaw);

function federalEvent({
  amount,
  clientName = "Department of State",
  description = "Technical assistance and advisory services",
  federalOrganizationCode = "019",
  classificationCode = "R408",
  naicsCode = "541611",
  opportunityName = "Technical assistance opportunity",
  sourceId = "sam-gov",
}: {
  amount?: number;
  clientName?: string;
  description?: string;
  federalOrganizationCode?: string;
  classificationCode?: string;
  naicsCode?: string;
  opportunityName?: string;
  sourceId?: "sam-gov" | "grants-gov";
}) {
  return biddingEvent({
    sourceId,
    clientName,
    description,
    opportunityName,
    value: amount === undefined ? undefined : { amount, currency: "USD" },
    sourceData: {
      federalOrganizationCode,
      classificationCode,
      naicsCode,
      fullParentPathName: clientName,
    },
  });
}

function grantsEvent(overrides: Parameters<typeof federalEvent>[0]) {
  return federalEvent({ ...overrides, sourceId: "grants-gov" });
}

describe("Addressability Assessment", () => {
  it("applies hard exclusions before scoring", () => {
    const result = assessAddressability(biddingEvent({ clientName: "Blocked Agency" }), activeConfig);
    expect(result).toMatchObject({ status: "excluded", exclusionRuleId: "blocked-client", score: 0 });
  });

  it("retains events at or above the configured threshold as Addressable", () => {
    const result = assessAddressability(biddingEvent(), activeConfig);
    expect(result.status).toBe("addressable");
    expect(result.score).toBe(9);
  });

  it("gives missing fields no points without excluding the event", () => {
    const result = assessAddressability(biddingEvent({ clientName: undefined, value: undefined }), activeConfig);
    expect(result).toMatchObject({ status: "uncertain", score: 0 });
  });

  it("keeps every event Uncertain while configuration is draft", () => {
    const draft = { ...activeConfig, status: "draft" as const };
    expect(assessAddressability(biddingEvent(), draft).status).toBe("uncertain");
    expect(assessAddressability(biddingEvent({ clientName: "Blocked Agency" }), draft).status).toBe("uncertain");
  });

  it("applies the configured SAM.gov agency value bands", () => {
    expect(assessAddressability(federalEvent({ amount: 500_000 }), configuredRules).status).toBe("addressable");
    expect(assessAddressability(federalEvent({ amount: 499_999 }), configuredRules)).toMatchObject({
      status: "excluded",
      exclusionRuleId: "sam-dos-dfc-below-minimum-value",
    });
    expect(assessAddressability(federalEvent({
      amount: 250_000,
      federalOrganizationCode: "011",
    }), configuredRules).status).toBe("addressable");
  });

  it("uses the lower MCA value band without lowering MCC's value band", () => {
    expect(assessAddressability(federalEvent({
      amount: 250_000,
      clientName: "Millennium Challenge Account Nepal",
      federalOrganizationCode: "524",
    }), configuredRules).status).toBe("addressable");
    expect(assessAddressability(federalEvent({
      amount: 250_000,
      clientName: "Millennium Challenge Corporation",
      federalOrganizationCode: "524",
    }), configuredRules)).toMatchObject({
      status: "excluded",
      exclusionRuleId: "sam-mcc-below-minimum-value",
    });
  });

  it("applies the configured Grants.gov agency value bands and service-evidence requirement", () => {
    expect(assessAddressability(grantsEvent({ amount: 2_000_000 }), configuredRules).status)
      .toBe("addressable");
    expect(assessAddressability(grantsEvent({ amount: 1_999_999 }), configuredRules)).toMatchObject({
      status: "excluded",
      exclusionRuleId: "grants-dos-below-minimum-value",
    });
    expect(assessAddressability(grantsEvent({
      amount: 500_000,
      federalOrganizationCode: "077",
    }), configuredRules).status).toBe("addressable");
    expect(assessAddressability(grantsEvent({
      amount: 250_000,
      federalOrganizationCode: "011",
    }), configuredRules).status).toBe("addressable");
    expect(assessAddressability(grantsEvent({
      amount: 500_000,
      clientName: "Millennium Challenge Corporation",
      federalOrganizationCode: "524",
    }), configuredRules).status).toBe("addressable");
    expect(assessAddressability(grantsEvent({
      amount: 250_000,
      clientName: "Millennium Challenge Account Nepal",
      federalOrganizationCode: "524",
    }), configuredRules).status).toBe("addressable");
    for (const [event, exclusionRuleId] of [
      [grantsEvent({ amount: 499_999, federalOrganizationCode: "077" }), "grants-dfc-below-minimum-value"],
      [grantsEvent({ amount: 249_999, federalOrganizationCode: "011" }), "grants-ustda-below-minimum-value"],
      [grantsEvent({
        amount: 499_999,
        clientName: "Millennium Challenge Corporation",
        federalOrganizationCode: "524",
      }), "grants-mcc-below-minimum-value"],
      [grantsEvent({
        amount: 249_999,
        clientName: "Millennium Challenge Account Nepal",
        federalOrganizationCode: "524",
      }), "grants-mca-below-minimum-value"],
    ] as const) {
      expect(assessAddressability(event, configuredRules)).toMatchObject({
        status: "excluded",
        exclusionRuleId,
      });
    }
    expect(assessAddressability(grantsEvent({
      amount: 2_000_000,
      description: "General grant program",
      opportunityName: "General grant program",
    }), configuredRules).status).toBe("uncertain");
  });

  it("scores every configured service term positively and every goods term negatively", () => {
    const serviceTerms = [
      "advisory",
      "capacity building",
      "consultancy",
      "consultant",
      "consulting",
      "implementation support",
      "professional services",
      "services",
      "technical assistance",
    ];
    for (const term of serviceTerms) {
      const result = assessAddressability(grantsEvent({
        amount: 2_000_000,
        description: `Program provides ${term}.`,
        opportunityName: "General program",
      }), configuredRules);
      expect(result).toMatchObject({ status: "addressable", score: 3 });
      expect(result.matchedRules).toContainEqual({ ruleId: "service-terms", points: 2 });
    }

    const goodsTerms = [
      "goods",
      "supply",
      "supplies",
      "equipment",
      "vehicles",
      "hardware",
      "furniture",
      "materials",
      "computers",
    ];
    for (const term of goodsTerms) {
      const result = assessAddressability(grantsEvent({
        amount: 2_000_000,
        description: `Advisory services involving ${term}.`,
        opportunityName: "General program",
      }), configuredRules);
      expect(result).toMatchObject({ status: "uncertain", score: 1 });
      expect(result.matchedRules).toContainEqual({ ruleId: "goods-terms", points: -2 });
    }
  });

  it("applies service and goods evidence consistently to every Source", () => {
    const result = assessAddressability(biddingEvent({
      sourceId: "future-source",
      opportunityName: "Professional services and equipment",
      description: "General opportunity",
      value: undefined,
    }), configuredRules);
    expect(result).toMatchObject({ status: "uncertain", score: 0 });
    expect(result.matchedRules).toEqual([
      { ruleId: "service-terms", points: 2 },
      { ruleId: "goods-terms", points: -2 },
    ]);
  });

  it("keeps missing value or service evidence Uncertain", () => {
    expect(assessAddressability(federalEvent({ amount: undefined }), configuredRules).status).toBe("uncertain");
    expect(assessAddressability(federalEvent({
      amount: 1_000_000,
      description: "General program",
      opportunityName: "General requirement",
    }), configuredRules).status).toBe("uncertain");
  });

  it("hard-excludes clear goods, supplies, and manufacturing opportunities", () => {
    expect(assessAddressability(federalEvent({
      amount: 1_000_000,
      classificationCode: "7010",
    }), configuredRules)).toMatchObject({
      status: "excluded",
      exclusionRuleId: "sam-goods-product-code",
    });
    expect(assessAddressability(federalEvent({
      amount: 1_000_000,
      naicsCode: "332999",
    }), configuredRules)).toMatchObject({
      status: "excluded",
      exclusionRuleId: "sam-manufacturing-naics",
    });
  });
});
