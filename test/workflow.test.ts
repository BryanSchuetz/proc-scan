import { describe, expect, it } from "vitest";
import {
  localScanCycleForInstant,
  scanCycleForEvent,
  scanTimingForEvent,
} from "../src/worker/workflow";

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
    expect(() => scanTimingForEvent(
      { requestedAt: "2026-09-17T17:00:00.000Z" },
      undefined,
      new Date("2026-09-15T23:13:52.923Z"),
    )).toThrow("requestedAt cannot be in the future");
  });

  it("uses a past request for the cycle while preserving the actual scan time", () => {
    const timing = scanTimingForEvent(
      { requestedAt: "2026-09-15T17:00:00.000Z" },
      undefined,
      new Date("2026-09-15T23:13:52.923Z"),
    );

    expect(timing.cycleInstant.toISOString()).toBe("2026-09-15T17:00:00.000Z");
    expect(timing.scanInstant.toISOString()).toBe("2026-09-15T23:13:52.923Z");
  });

  it("uses the scheduled time instead of the workflow deployment time for a scheduled scan", () => {
    const timing = scanTimingForEvent(
      {},
      "2026-09-18T05:00:10.887Z",
      new Date("2026-09-17T11:41:40.302Z"),
    );

    expect(timing.cycleInstant.toISOString()).toBe("2026-09-18T05:00:10.887Z");
    expect(timing.scanInstant.toISOString()).toBe("2026-09-18T05:00:10.887Z");
  });

  it("keeps a manual run requested for a scheduled time in a separate cycle", () => {
    const timing = scanTimingForEvent(
      { requestedAt: "2026-09-15T17:00:00.000Z" },
      undefined,
      new Date("2026-09-15T23:13:52.923Z"),
    );

    expect(scanCycleForEvent(timing, undefined)).toEqual({
      cycleKey: "manual:2026-09-15T23:13:52.923Z",
      scheduledFor: "2026-09-15T17:00:00.000Z",
    });
    expect(scanCycleForEvent(timing, timing.cycleInstant.getTime())).toEqual({
      cycleKey: "2026-09-15:PM",
      scheduledFor: "2026-09-15T17:00:00.000Z",
    });
  });
});
