import { describe, expect, it } from "vitest";
import { localScanCycleForInstant, scanInstantForEvent } from "../src/worker/workflow";

describe("UK scan schedule gate", () => {
  it("accepts the GMT UTC equivalent and rejects the BST equivalent in winter", () => {
    expect(localScanCycleForInstant(new Date("2026-01-10T06:00:00.000Z"))?.cycleKey).toBe("2026-01-10:AM");
    expect(localScanCycleForInstant(new Date("2026-01-10T05:00:00.000Z"))).toBeUndefined();
  });

  it("accepts the BST UTC equivalent and rejects the GMT equivalent in summer", () => {
    expect(localScanCycleForInstant(new Date("2026-07-10T17:00:00.000Z"))?.cycleKey).toBe("2026-07-10:PM");
    expect(localScanCycleForInstant(new Date("2026-07-10T18:00:00.000Z"))).toBeUndefined();
  });

  it("rejects a manually requested future scan cycle", () => {
    expect(() => scanInstantForEvent(
      { requestedAt: "2026-09-17T17:00:00.000Z" },
      undefined,
      new Date("2026-09-15T23:13:52.923Z"),
    )).toThrow("requestedAt cannot be in the future");
  });

  it("allows a manually requested past scan cycle", () => {
    expect(scanInstantForEvent(
      { requestedAt: "2026-09-15T17:00:00.000Z" },
      undefined,
      new Date("2026-09-15T23:13:52.923Z"),
    ).toISOString()).toBe("2026-09-15T17:00:00.000Z");
  });
});
