import { describe, expect, it } from "vitest";
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
});
