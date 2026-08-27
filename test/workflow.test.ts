import { describe, expect, it } from "vitest";
import { localScanCycleForInstant } from "../src/worker/workflow";

describe("New York scan schedule gate", () => {
  it("accepts the EST UTC equivalent and rejects the EDT equivalent in winter", () => {
    expect(localScanCycleForInstant(new Date("2026-01-10T11:00:00.000Z"))?.cycleKey).toBe("2026-01-10:AM");
    expect(localScanCycleForInstant(new Date("2026-01-10T10:00:00.000Z"))).toBeUndefined();
  });

  it("accepts the EDT UTC equivalent and rejects the EST equivalent in summer", () => {
    expect(localScanCycleForInstant(new Date("2026-07-10T22:00:00.000Z"))?.cycleKey).toBe("2026-07-10:PM");
    expect(localScanCycleForInstant(new Date("2026-07-10T23:00:00.000Z"))).toBeUndefined();
  });
});
