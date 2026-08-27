import { describe, expect, it } from "vitest";
import taxonomyRaw from "../tech-area-classification.yaml?raw";
import classificationRaw from "../config/technical-classification.yaml?raw";
import { parseAddressabilityYaml } from "../src/classification/addressability";
import {
  parseTaxonomyYaml,
  parseTechnicalClassificationYaml,
} from "../src/classification/taxonomy";
import { processCandidate } from "../src/pipeline/process-candidate";
import { biddingEvent } from "./fixtures";

const taxonomy = parseTaxonomyYaml(taxonomyRaw);
const technicalClassification = parseTechnicalClassificationYaml(classificationRaw);
const activeAddressability = parseAddressabilityYaml(`
schema_version: 1
status: active
threshold: 5
hard_exclusions:
  - id: blocked-client
    description: Client is explicitly outside the addressable market.
    conditions:
      all:
        - field: clientName
          operator: equals
          value: Do Not Pursue Agency
scoring_rules:
  - id: preferred-client
    description: Client is in the approved addressable list.
    points: 6
    conditions:
      all:
        - field: clientName
          operator: equals
          value: Development Agency
`);

const context = {
  scanRunId: "scan-test",
  taxonomy,
  technicalClassification,
  addressability: activeAddressability,
};

describe("candidate processing pipeline", () => {
  it("inherits reliable fields and Technical Areas for an exactly linked modification", async () => {
    const tender = await processCandidate(biddingEvent(), context);
    expect(tender.status).toBe("retained");
    if (tender.status !== "retained") return;

    const modification = await processCandidate(
      biddingEvent({
        sourceEventId: "event-2",
        eventType: "modification",
        description: "Deadline extended.",
        clientName: undefined,
        value: undefined,
      }),
      { ...context, priorEvent: tender.event },
    );
    expect(modification.status).toBe("retained");
    if (modification.status !== "retained") return;

    expect(modification.event.clientName).toBe("Development Agency");
    expect(modification.event.value).toEqual({ amount: 5_000_000, currency: "USD" });
    expect(modification.event.inheritedFields.map((item) => item.field)).toEqual(
      expect.arrayContaining(["clientName", "value"]),
    );
    expect(modification.event.technicalAreas.map((area) => area.id)).toContain(
      "digital-strategy-and-advisory",
    );
    expect(modification.event.addressability.status).toBe("addressable");
    expect(modification.event.ocdsRelease.tag).toEqual(["tenderUpdate"]);
  });

  it("drops a hard-excluded candidate before producing a retained event", async () => {
    const result = await processCandidate(
      biddingEvent({ clientName: "Do Not Pursue Agency" }),
      context,
    );
    expect(result.status).toBe("excluded");
    if (result.status !== "excluded") return;
    expect(result.assessment.exclusionRuleId).toBe("blocked-client");
    expect(result).not.toHaveProperty("event");
  });

  it("produces stable identity, fingerprint, and row ID for a repeated candidate", async () => {
    const first = await processCandidate(biddingEvent(), context);
    const second = await processCandidate(biddingEvent(), context);
    expect(first.status).toBe("retained");
    expect(second.status).toBe("retained");
    if (first.status !== "retained" || second.status !== "retained") return;
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.eventIdentity).toBe(first.event.eventIdentity);
    expect(second.event.contentFingerprint).toBe(first.event.contentFingerprint);
  });
});
