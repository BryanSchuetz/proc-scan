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

function samEvent({
  amount,
  clientName = "Department of State",
  description = "Technical assistance and advisory services",
  federalOrganizationCode = "019",
  classificationCode = "R408",
  naicsCode = "541611",
  opportunityName = "Technical assistance opportunity",
}: {
  amount?: number;
  clientName?: string;
  description?: string;
  federalOrganizationCode?: string;
  classificationCode?: string;
  naicsCode?: string;
  opportunityName?: string;
}) {
  return biddingEvent({
    sourceId: "sam-gov",
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
    expect(assessAddressability(samEvent({ amount: 500_000 }), configuredRules).status).toBe("addressable");
    expect(assessAddressability(samEvent({ amount: 499_999 }), configuredRules)).toMatchObject({
      status: "excluded",
      exclusionRuleId: "sam-dos-dfc-below-minimum-value",
    });
    expect(assessAddressability(samEvent({
      amount: 250_000,
      federalOrganizationCode: "011",
    }), configuredRules).status).toBe("addressable");
  });

  it("uses the lower MCA value band without lowering MCC's value band", () => {
    expect(assessAddressability(samEvent({
      amount: 250_000,
      clientName: "Millennium Challenge Account Nepal",
      federalOrganizationCode: "524",
    }), configuredRules).status).toBe("addressable");
    expect(assessAddressability(samEvent({
      amount: 250_000,
      clientName: "Millennium Challenge Corporation",
      federalOrganizationCode: "524",
    }), configuredRules)).toMatchObject({
      status: "excluded",
      exclusionRuleId: "sam-mcc-below-minimum-value",
    });
  });

  it("keeps missing value or technical-assistance evidence Uncertain", () => {
    expect(assessAddressability(samEvent({ amount: undefined }), configuredRules).status).toBe("uncertain");
    expect(assessAddressability(samEvent({
      amount: 1_000_000,
      description: "General services",
      opportunityName: "General services requirement",
    }), configuredRules).status).toBe("uncertain");
  });

  it("hard-excludes clear goods, supplies, and manufacturing opportunities", () => {
    expect(assessAddressability(samEvent({
      amount: 1_000_000,
      classificationCode: "7010",
    }), configuredRules)).toMatchObject({
      status: "excluded",
      exclusionRuleId: "sam-goods-product-code",
    });
    expect(assessAddressability(samEvent({
      amount: 1_000_000,
      naicsCode: "332999",
    }), configuredRules)).toMatchObject({
      status: "excluded",
      exclusionRuleId: "sam-manufacturing-naics",
    });
  });
});
