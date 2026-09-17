import { describe, expect, it } from "vitest";
import { toSearchParams } from "../src/data/searchParams.js";
import { EMPTY_DRAFT, toOptions } from "../src/views/SearchView.js";

describe("radius draft request guard", () => {
  it.each([
    { lat: "28.5494" },
    { lat: "28.5494", lon: "-81.7729" },
    { radiusMiles: "5" },
    { lat: "28.5494", lon: "-81.7729", radiusMiles: "0" },
  ])("does not send partial radius filters for draft %j", (radius) => {
    const options = toOptions({ ...EMPTY_DRAFT, ...radius }, undefined, "desc", 0);
    const params = toSearchParams(options);
    expect(params.has("lat")).toBe(false);
    expect(params.has("lon")).toBe(false);
    expect(params.has("radiusMiles")).toBe(false);
  });

  it("sends all three fields together only once the tuple is complete", () => {
    const options = toOptions(
      { ...EMPTY_DRAFT, lat: "28.5494", lon: "-81.7729", radiusMiles: "5" },
      undefined,
      "desc",
      0,
    );
    expect(toSearchParams(options).toString()).toContain("lat=28.5494&lon=-81.7729&radiusMiles=5");
  });
});
