import { describe, expect, it } from "vitest";
import { propertyPath, toRoute } from "./useHashRoute.js";

describe("hash route parsing", () => {
  it("round-trips parcel identifiers without changing punctuation", () => {
    const parcel = "05-18-25 / 004%00";
    expect(toRoute(propertyPath(parcel)).segments).toEqual(["property", parcel]);
  });

  it.each(["%", "%2", "%GG", "%E0%A4%A", "%FF"])(
    "does not crash the application for malformed segment %s",
    (segment) => {
      expect(toRoute(`/property/${segment}`).segments).toEqual(["property", segment]);
    },
  );

  it("decodes valid segments independently of malformed ones", () => {
    expect(toRoute("/property/%/unit%20A").segments).toEqual(["property", "%", "unit A"]);
  });
});
