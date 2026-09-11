import { describe, expect, it } from "vitest";
import { toSearchParams } from "./searchParams.js";

describe("toSearchParams", () => {
  it("serialises the explicit open-roofing duration field", () => {
    const params = toSearchParams({
      hasOpenRoofingPermit: true,
      minOpenRoofingPermitDays: 1825,
    });
    expect(params.get("hasOpenRoofingPermit")).toBe("true");
    expect(params.get("minOpenRoofingPermitDays")).toBe("1825");
    expect(params.has("minOpenPermitDays")).toBe(false);
  });

  it("retains the generic any-permit duration field independently", () => {
    const params = toSearchParams({ minOpenPermitDays: 365 });
    expect(params.get("minOpenPermitDays")).toBe("365");
    expect(params.has("minOpenRoofingPermitDays")).toBe(false);
  });
});
