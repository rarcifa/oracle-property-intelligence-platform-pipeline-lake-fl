import { describe, expect, it } from "vitest";
import type { LatestRunPointer } from "@oracle-lake/shared";
import { browserDataSourceEligible } from "./DataSourceProvider.js";

describe("browser data eligibility", () => {
  const run = { rootCid: "synthetic-published-root" } as LatestRunPointer;
  it("allows an explicitly published legacy run, including materialized public bytes", () => {
    expect(browserDataSourceEligible({ run })).toBe(true);
  });
  it("refuses private previews even when stale metadata contains a CID", () => {
    expect(browserDataSourceEligible({ run, localEvidencePreview: true })).toBe(false);
  });
  it("keeps source-only decision guards on the backend rather than bypassing them in WASM", () => {
    expect(browserDataSourceEligible({ run, sourceObservationsOnly: true })).toBe(false);
  });
  it("refuses unpublished runs", () => {
    expect(browserDataSourceEligible({ run: null })).toBe(false);
    expect(
      browserDataSourceEligible({ run: { ...run, rootCid: null } as unknown as LatestRunPointer }),
    ).toBe(false);
  });
});
