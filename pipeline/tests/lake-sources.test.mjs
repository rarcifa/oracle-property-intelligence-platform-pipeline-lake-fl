import { describe, expect, it } from "vitest";
import {
  esriEpochToIsoDate,
  isOpenPermit,
  isRoofingPermit,
  listDorFiles,
  mapWithConcurrency,
  normalizePermit,
  permitWindowClause,
  selectLakeRollFile,
  toObjectIdRanges,
  ROOFING_PERMIT_TYPES,
} from "../src/counties/lake/sources.mjs";

describe("DOR roll listing", () => {
  it("parses a SharePoint folder listing and selects the Lake file", async () => {
    const payload = {
      value: [
        { Name: "Lake 45 Preliminary NAL 2026.zip", ServerRelativeUrl: "/a/Lake 45 Preliminary NAL 2026.zip", Length: "18297748" },
        { Name: "Leon 37 Preliminary NAL 2026.zip", ServerRelativeUrl: "/a/Leon.zip", Length: "1" },
      ],
    };
    const files = await listDorFiles("NAL", {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }),
    });
    expect(files).toHaveLength(2);
    expect(files[0].bytes).toBe(18297748);
    expect(selectLakeRollFile(files, "NAL").name).toBe("Lake 45 Preliminary NAL 2026.zip");
  });

  it("refuses an ambiguous or missing Lake file rather than guessing", async () => {
    expect(() => selectLakeRollFile([{ name: "Leon NAL.zip", serverRelativeUrl: "/a" }], "NAL")).toThrow(
      /Expected exactly one Lake NAL file/,
    );
    expect(() =>
      selectLakeRollFile(
        [
          { name: "Lake NAL a.zip", serverRelativeUrl: "/a" },
          { name: "Lake NAL b.zip", serverRelativeUrl: "/b" },
        ],
        "NAL",
      ),
    ).toThrow(/found 2/);
  });

  it("fails closed on a non-ok listing response", async () => {
    await expect(
      listDorFiles("NAL", { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("OBJECTID range paging", () => {
  it("splits ascending ids into inclusive pages", () => {
    const ranges = toObjectIdRanges([1, 2, 3, 4, 5], 2);
    expect(ranges).toEqual([
      { min: 1, max: 2, count: 2 },
      { min: 3, max: 4, count: 2 },
      { min: 5, max: 5, count: 1 },
    ]);
  });

  it("handles a page size larger than the id list and an empty list", () => {
    expect(toObjectIdRanges([7, 9], 100)).toEqual([{ min: 7, max: 9, count: 2 }]);
    expect(toObjectIdRanges([], 10)).toEqual([]);
  });

  it("rejects a page size below one", () => {
    expect(() => toObjectIdRanges([1], 0)).toThrow(/at least 1/);
  });
});

describe("bounded concurrency", () => {
  it("preserves input order and never exceeds the window", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return value * 10;
    });
    expect(result).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("permit normalization", () => {
  const roofingFeature = {
    Permit_Number: "2026021076",
    Alternate_Key: "1015618",
    Parcel_ID: "231827010000023100",
    Permit_Type: "RFR",
    Permit_Desc: "RE-ROOF",
    Permit_Status: "ISSUED",
    PermitApplied_Date: Date.UTC(2026, 1, 10),
    PermitIssued_Date: Date.UTC(2026, 1, 12),
    CO_Date: null,
    Permit_LastModDate: Date.UTC(2026, 1, 12),
    PermitURL: "https://example.invalid/permit",
  };

  it("classifies every roofing type and no other type as roofing", () => {
    for (const type of ROOFING_PERMIT_TYPES) {
      expect(isRoofingPermit({ Permit_Type: type })).toBe(true);
    }
    expect(isRoofingPermit({ Permit_Type: "ELRA" })).toBe(false);
    expect(isRoofingPermit({ Permit_Type: "rfr" })).toBe(true);
  });

  it("treats only the open statuses as open", () => {
    expect(isOpenPermit({ Permit_Status: "ISSUED" })).toBe(true);
    expect(isOpenPermit({ Permit_Status: "INSPECT" })).toBe(true);
    expect(isOpenPermit({ Permit_Status: "FINAL" })).toBe(false);
    expect(isOpenPermit({ Permit_Status: "VOID" })).toBe(false);
    expect(isOpenPermit({ Permit_Status: "closed_ni" })).toBe(false);
  });

  it("converts Esri epoch milliseconds to an ISO date and rejects sentinels", () => {
    expect(esriEpochToIsoDate(Date.UTC(2026, 1, 12))).toBe("2026-02-12");
    expect(esriEpochToIsoDate(null)).toBeNull();
    expect(esriEpochToIsoDate(0)).toBeNull();
    expect(esriEpochToIsoDate("")).toBeNull();
  });

  it("normalizes a roofing permit and measures its open duration", () => {
    const permit = normalizePermit(roofingFeature, {
      nowMs: Date.parse("2026-09-11T00:00:00Z"),
    });
    expect(permit.permit_number).toBe("2026021076");
    expect(permit.alternate_key).toBe("1015618");
    expect(permit.is_roofing).toBe(true);
    expect(permit.is_open).toBe(true);
    expect(permit.issued_date).toBe("2026-02-12");
    expect(permit.co_date).toBeNull();
    expect(permit.days_open).toBe(211);
  });

  it("derives an open duration from the injected as-of clock, not wall time", () => {
    const first = normalizePermit(roofingFeature, {
      nowMs: Date.parse("2026-03-01T00:00:00Z"),
    });
    const later = normalizePermit(roofingFeature, {
      nowMs: Date.parse("2026-03-11T00:00:00Z"),
    });
    expect(first.days_open).toBe(17);
    expect(later.days_open).toBe(27);
  });

  it("measures a closed permit's duration between issue and certificate of occupancy", () => {
    const permit = normalizePermit({
      ...roofingFeature,
      Permit_Status: "FINAL",
      PermitIssued_Date: Date.UTC(2025, 0, 1),
      CO_Date: Date.UTC(2025, 0, 31),
    });
    expect(permit.is_open).toBe(false);
    expect(permit.days_open).toBe(30);
  });
});

describe("incremental permit window", () => {
  it("builds a LastModDate clause from a date and a full scan from null", () => {
    // The service types the field as a date, so it needs a SQL timestamp
    // literal; a raw epoch number is rejected with "Failed to execute query".
    expect(permitWindowClause(new Date("2026-09-01T00:00:00Z"))).toBe(
      "Permit_LastModDate > timestamp '2026-09-01 00:00:00'",
    );
    expect(permitWindowClause(null)).toBe("1=1");
  });

  it("refuses an invalid date rather than scanning everything by accident", () => {
    expect(() => permitWindowClause(new Date("not a date"))).toThrow(/valid Date/);
  });
});
