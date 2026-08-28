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
  - id: service-fit
    description: Opportunity contains service-fit evidence
    points: 4
    conditions:
      all:
        - field: description
          operator: contains
          value: service design
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
    const result = assessAddressability(biddingEvent({
      clientName: undefined,
      description: undefined,
      value: undefined,
    }), activeConfig);
    expect(result).toMatchObject({ status: "uncertain", score: 0 });
  });

  it("keeps every event Uncertain while configuration is draft", () => {
    const draft = { ...activeConfig, status: "draft" as const };
    expect(assessAddressability(biddingEvent(), draft).status).toBe("uncertain");
    expect(assessAddressability(biddingEvent({ clientName: "Blocked Agency" }), draft).status).toBe("uncertain");
  });

  it("applies the configured SAM.gov value floors as hard exclusions only", () => {
    expect(assessAddressability(federalEvent({ amount: 500_000 }), configuredRules))
      .toMatchObject({ status: "addressable", score: 4 });
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

  it("applies the configured Grants.gov value floors as hard exclusions only", () => {
    expect(assessAddressability(grantsEvent({ amount: 2_000_000 }), configuredRules))
      .toMatchObject({ status: "addressable", score: 4 });
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
    }), configuredRules).status).toBe("addressable");
  });

  it("scores every configured DAI-fit term positively and every miss-fit term negatively", () => {
    const daiFitTerms = [
      "advisory",
      "analytics",
      "capacity building",
      "climate",
      "consultancy",
      "consultant",
      "consulting",
      "digital",
      "economic growth",
      "education",
      "environment",
      "financial advisory",
      "fragile states",
      "global health",
      "governance",
      "implementation support",
      "institutional strengthening",
      "management consulting",
      "market systems",
      "monitoring evaluation and learning",
      "partnerships",
      "policy",
      "private sector",
      "professional services",
      "project design",
      "public financial management",
      "public sector",
      "resilience",
      "sustainable business",
      "technical assistance",
      "training",
      "WASH",
    ];
    expect(configuredRules.scoring_rules.find(({ id }) => id === "dai-fit-terms"))
      .toMatchObject({
        conditions: {
          any: [
            { field: "opportunityName", operator: "contains", value: daiFitTerms },
            { field: "description", operator: "contains", value: daiFitTerms },
          ],
        },
      });
    for (const term of daiFitTerms) {
      const result = assessAddressability(grantsEvent({
        amount: 2_000_000,
        description: `Program provides ${term}.`,
        opportunityName: "General program",
      }), configuredRules);
      expect(result).toMatchObject({ status: "addressable", score: 4 });
      expect(result.matchedRules).toContainEqual({ ruleId: "dai-fit-terms", points: 2 });
    }

    const missFitTerms = [
      "goods",
      "supplies",
      "equipment",
      "vehicles",
      "hardware",
      "furniture",
      "materials",
      "computers",
      "manned guarding",
      "security guarding",
      "guarding services",
      "security services",
      "close protection",
      "medical insurance",
      "health insurance for",
      "group insurance",
      "accidental insurance",
      "life insurance",
      "travel insurance",
      "cleaning services",
      "janitorial",
      "catering services",
      "canteen",
      "landscaping",
      "gardening services",
      "pest control",
      "waste collection",
      "vehicle hire",
      "vehicle rental",
      "car rental",
      "fleet management",
      "chauffeur",
      "travel management",
      "removal services",
      "relocation services",
      "furniture supply",
      "office supplies",
      "stationery",
      "residential lease",
      "building maintenance",
      "facilities management",
      "air conditioning maintenance",
      "supervision",
      "construction",
      "architecture",
      "architectural",
      "engineering",
      "engineer",
      "visa",
      "embassy",
      "maintenance",
      "irrigation",
      "drainage",
    ];
    expect(configuredRules.scoring_rules.find(({ id }) => id === "miss-fit-terms"))
      .toMatchObject({
        conditions: {
          any: [
            { field: "opportunityName", operator: "contains", value: missFitTerms },
            { field: "description", operator: "contains", value: missFitTerms },
          ],
        },
      });
    for (const term of missFitTerms) {
      const result = assessAddressability(grantsEvent({
        amount: 2_000_000,
        description: `Advisory services involving ${term}.`,
        opportunityName: "General program",
      }), configuredRules);
      expect(result).toMatchObject({ status: "addressable", score: 2 });
      expect(result.matchedRules).toContainEqual({ ruleId: "miss-fit-terms", points: -2 });
    }
  });

  it("applies DAI-Fit and Miss-Fit evidence consistently to every Source", () => {
    const result = assessAddressability(biddingEvent({
      sourceId: "future-source",
      opportunityName: "Professional services and equipment",
      description: "General opportunity",
      value: undefined,
    }), configuredRules);
    expect(result).toMatchObject({ status: "addressable", score: 2 });
    expect(result.matchedRules).toEqual([
      { ruleId: "inclusive-baseline", points: 2 },
      { ruleId: "dai-fit-terms", points: 2 },
      { ruleId: "miss-fit-terms", points: -2 },
    ]);
  });

  it("does not treat generic miss-fit services language as DAI-Fit evidence", () => {
    for (const phrase of [
      "security services",
      "guarding services",
      "cleaning services",
      "catering services",
      "gardening services",
      "removal services",
      "relocation services",
    ]) {
      expect(assessAddressability(grantsEvent({
        amount: 2_000_000,
        description: `Requirement for ${phrase}.`,
        opportunityName: "General requirement",
      }), configuredRules)).toMatchObject({
        status: "uncertain",
        score: 0,
        matchedRules: [
          { ruleId: "inclusive-baseline", points: 2 },
          { ruleId: "miss-fit-terms", points: -2 },
        ],
      });
    }
  });

  it("does not treat supply-chain language as Miss-Fit evidence", () => {
    expect(assessAddressability(grantsEvent({
      amount: 2_000_000,
      description: "A program supporting resilient, rights-respecting supply chains.",
      opportunityName: "General program",
    }), configuredRules)).toMatchObject({
      status: "addressable",
      score: 2,
      matchedRules: [{ ruleId: "inclusive-baseline", points: 2 }],
    });
  });

  it("treats zero and missing values as unknown rather than below the value floor", () => {
    for (const amount of [0, undefined]) {
      expect(assessAddressability(federalEvent({ amount }), configuredRules))
        .toMatchObject({ status: "addressable", score: 4 });
    }
  });

  it("marks opportunities with neither fit signal from the inclusive baseline", () => {
    for (const amount of [1_000_000, 0, undefined]) {
      expect(assessAddressability(federalEvent({
        amount,
        description: "General program",
        opportunityName: "General requirement",
      }), configuredRules)).toMatchObject({
        status: "addressable",
        score: 2,
        matchedRules: [{ ruleId: "inclusive-baseline", points: 2 }],
      });
    }
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
