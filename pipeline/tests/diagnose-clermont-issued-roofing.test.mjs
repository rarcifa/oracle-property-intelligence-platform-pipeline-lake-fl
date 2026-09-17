import { describe, expect, it } from "vitest";
import {
  literalRoofType,
  parseArgs,
  selectIssuedRoofingCandidates,
  sourceIssuedRoofing,
} from "../scripts/lake/diagnose-clermont-issued-roofing.mjs";

const row = (overrides = {}) => ({
  permit_number: "SYN-1",
  permit_type: "ROOF/REROOF",
  permit_status: "ISSUED",
  issued_date: "2020-01-02",
  source_system: "lake_clermont_etrakit_permits",
  ...overrides,
});

describe("bounded Clermont issued-roofing diagnostic selection", () => {
  it("selects only literal Clermont ROOF/REROOF + ISSUED rows with non-empty issue dates", () => {
    expect(literalRoofType(row())).toBe(true);
    expect(literalRoofType(row({ permit_type: "PROOF OF OWNER" }))).toBe(false);
    expect(sourceIssuedRoofing(row())).toBe(true);
    expect(sourceIssuedRoofing(row({ issued_date: "" }))).toBe(false);
    expect(sourceIssuedRoofing(row({ permit_status: "FINALED" }))).toBe(false);
    expect(sourceIssuedRoofing(row({ source_system: "lake_cdplus_permits" }))).toBe(false);
  });

  it("returns the oldest deterministic bounded candidate set", () => {
    const selected = selectIssuedRoofingCandidates(
      [
        row({ permit_number: "SYN-3", issued_date: "2020-02-01" }),
        row({ permit_number: "SYN-2", issued_date: "2020-01-01" }),
        row({ permit_number: "SYN-1", issued_date: "2020-01-01" }),
        row({ permit_number: "SYN-X", permit_type: "MECHANICAL", issued_date: "2019-01-01" }),
      ],
      2,
    );
    expect(selected.map((candidate) => candidate.permit_number)).toEqual(["SYN-1", "SYN-2"]);
  });

  it("rejects repo-local raw output roots", () => {
    expect(() => parseArgs(["--output-root", "artifacts/score-repair-20260917-9msga0"])).toThrow(
      /outside the repository/,
    );
    expect(parseArgs(["--output-root", "/tmp/oracle-private-diagnostic"]).outputRoot).toBe(
      "/tmp/oracle-private-diagnostic",
    );
  });
});
