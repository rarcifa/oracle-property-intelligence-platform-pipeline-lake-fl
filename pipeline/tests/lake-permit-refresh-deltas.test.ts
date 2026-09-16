import { describe, expect, it } from "vitest";
import { reconcilePermitRefresh } from "../scripts/lake/summarize-permit-refresh.js";

describe("source-record incremental deltas", () => {
  const base = [{ permit_number: "1", alternate_key: "a", permit_status: "ISSUED", days_open: 1 }];
  it("does not turn derived age drift into a source update", () => {
    const window = [{ ...base[0]!, days_open: 10 }];
    expect(reconcilePermitRefresh(base, window, window)).toMatchObject({
      inserted: 0,
      updated: 0,
      unchangedInWindow: 1,
      removed: null,
      idempotent: true,
    });
  });
  it("counts real source changes and keeps unmatched associations", () => {
    const window = [
      { ...base[0]!, permit_status: "FINAL" },
      { permit_number: "2", alternate_key: null, permit_status: "ISSUED" },
    ];
    expect(reconcilePermitRefresh(base, window, window)).toMatchObject({
      inserted: 1,
      updated: 1,
      unchangedInWindow: 0,
      mergedAssociations: 2,
    });
  });
  it("rejects lost or duplicated source evidence", () => {
    expect(() => reconcilePermitRefresh(base, [], [])).toThrow(/missing association/);
    expect(() => reconcilePermitRefresh(base, [], [...base, ...base])).toThrow(/duplicate/);
    expect(() =>
      reconcilePermitRefresh(base, [], [{ ...base[0]!, permit_status: "FINAL" }]),
    ).toThrow(/changed source evidence/);
  });
});
