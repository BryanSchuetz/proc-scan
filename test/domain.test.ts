import { describe, expect, it } from "vitest";
import {
  buildEventIdentity,
  buildMaterialFingerprint,
  canonicalizeUrl,
} from "../src/domain/identity";
import { inheritMissingFields } from "../src/domain/inheritance";
import { buildOcdsRelease, ocdsTagFor } from "../src/domain/ocds";
import { biddingEvent } from "./fixtures";

describe("Bidding Event identity", () => {
  it("uses Source event ID before canonical URL", async () => {
    expect(await buildEventIdentity(biddingEvent())).toBe("id:event-1");
  });

  it("canonicalizes URLs before using them as identity", async () => {
    const event = biddingEvent({
      sourceEventId: undefined,
      canonicalUrl: "HTTPS://Example.Test/opportunities/1/?b=2&a=1#details",
    });
    expect(await buildEventIdentity(event)).toBe("url:https://example.test/opportunities/1?a=1&b=2");
    expect(canonicalizeUrl(event.canonicalUrl)).toBe("https://example.test/opportunities/1?a=1&b=2");
  });

  it("ignores whitespace and field order while detecting material changes", async () => {
    const original = biddingEvent();
    const reformatted = biddingEvent({ opportunityName: "  Digital  government advisory services " });
    expect(await buildMaterialFingerprint(reformatted)).toBe(await buildMaterialFingerprint(original));
    expect(await buildMaterialFingerprint(biddingEvent({ dueDate: "2026-10-15T17:00:00.000Z" })))
      .not.toBe(await buildMaterialFingerprint(original));
  });
});

describe("related Bidding Events", () => {
  it("inherits only missing fields from an exactly linked prior event", () => {
    const prior = { ...biddingEvent(), id: "evt-prior" };
    const current = biddingEvent({
      sourceEventId: "event-2",
      eventType: "modification",
      description: "Deadline extended.",
      clientName: undefined,
      value: undefined,
    });
    const result = inheritMissingFields(current, prior);
    expect(result.event.clientName).toBe("Development Agency");
    expect(result.event.value).toEqual({ amount: 5_000_000, currency: "USD" });
    expect(result.event.description).toBe("Deadline extended.");
    expect(result.inheritedFields.map((item) => item.field)).toEqual(
      expect.arrayContaining(["clientName", "value"]),
    );
  });

  it("does not inherit when the Source Opportunity Identifier differs", () => {
    const result = inheritMissingFields(
      biddingEvent({ sourceOpportunityId: "other", clientName: undefined }),
      { ...biddingEvent(), id: "evt-prior" },
    );
    expect(result.event.clientName).toBeUndefined();
    expect(result.inheritedFields).toEqual([]);
  });
});

describe("OCDS-shaped releases", () => {
  it("maps the three product event types to OCDS release tags", () => {
    expect(ocdsTagFor({ eventType: "tender" })).toBe("tender");
    expect(ocdsTagFor({ eventType: "modification", isFormalAmendment: true })).toBe("tenderAmendment");
    expect(ocdsTagFor({ eventType: "modification" })).toBe("tenderUpdate");
    expect(ocdsTagFor({ eventType: "cancellation" })).toBe("tenderCancellation");
  });

  it("keeps related events on one stable ocid but gives each release a unique ID", async () => {
    const tender = biddingEvent();
    const modification = biddingEvent({ sourceEventId: "event-2", eventType: "modification" });
    const tenderRelease = await buildOcdsRelease(tender, "id:event-1", "fingerprint-1");
    const modificationRelease = await buildOcdsRelease(modification, "id:event-2", "fingerprint-2");
    expect(modificationRelease.ocid).toBe(tenderRelease.ocid);
    expect(modificationRelease.id).not.toBe(tenderRelease.id);
  });
});
