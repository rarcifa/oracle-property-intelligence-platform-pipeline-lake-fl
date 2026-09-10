import { describe, expect, it } from "vitest";
import { parseCsvRecords } from "../src/core/csv.mjs";
import {
  assertSafeSourceFields,
  assertSeedReconciliation,
  buildSeed,
  buildSiteAddress,
  classifyDorUseBand,
  EXCLUDED_PII_FIELDS,
  isInLakeBbox,
  isPermitEligibleBand,
  isValidAltKey,
  isValidLakeParcelId,
  NAL_SOURCE_FIELDS,
  SEED_COLUMNS,
  toSeedRow,
  toUndashedParcelId,
} from "../src/counties/lake/seed.mjs";

const NAL_ROW = Object.freeze({
  PARCEL_ID: "32-18-24-0250-000-01400",
  ALT_KEY: "3404921",
  CO_NO: "45",
  ASMNT_YR: "2026",
  DOR_UC: "001",
  JV: "318622",
  ACT_YR_BLT: "1992",
  PHY_ADDR1: "36828 TAYLOR MILL RD",
  PHY_CITY: "FRUITLAND PARK",
  PHY_ZIPCD: "34731",
  OWN_NAME: "MASON JEANNE M  LIFE ESTATE",
  OWN_CITY: "FRUITLAND PARK",
  OWN_STATE: "FL",
});

describe("Lake parcel identifiers", () => {
  it("accepts the canonical dashed form and rejects near misses", () => {
    expect(isValidLakeParcelId("32-18-24-0250-000-01400")).toBe(true);
    // Block and lot segments are alphanumeric in 12.3% of the roll.
    expect(isValidLakeParcelId("28-18-24-0500-00B-02500")).toBe(true);
    expect(isValidLakeParcelId("29-19-26-0100-067-00D00")).toBe(true);
    expect(isValidLakeParcelId("28-18-24-0500-00b-02500")).toBe(false);
    expect(isValidLakeParcelId("321824025000001400")).toBe(false);
    expect(isValidLakeParcelId("32-18-24-0250-000-0140")).toBe(false);
    expect(isValidLakeParcelId("")).toBe(false);
  });

  it("accepts the alternate key used to join permits", () => {
    expect(isValidAltKey("3404921")).toBe(true);
    expect(isValidAltKey("12345")).toBe(false);
    expect(isValidAltKey("abc4921")).toBe(false);
  });

  it("undashes a parcel id for the permit layer and refuses a non-canonical one", () => {
    expect(toUndashedParcelId("32-18-24-0250-000-01400")).toBe("321824025000001400");
    expect(() => toUndashedParcelId("nope")).toThrow(/Not a canonical Lake parcel id/);
  });
});

describe("no PII in the seed", () => {
  it("passes the retained non-PII column list", () => {
    expect(() => assertSafeSourceFields(NAL_SOURCE_FIELDS)).not.toThrow();
  });

  it("refuses every owner and fiduciary column", () => {
    for (const field of EXCLUDED_PII_FIELDS) {
      expect(() => assertSafeSourceFields([field])).toThrow(/PII field is prohibited/);
    }
  });

  it("refuses a duplicated column", () => {
    expect(() => assertSafeSourceFields(["DOR_UC", "dor_uc"])).toThrow(/Duplicate source field/);
  });

  it("keeps owner columns out of the rendered seed row", () => {
    const row = toSeedRow({ nal: NAL_ROW, sourceRevision: "abc", snapshotAt: "2026-09-09T00:00:00Z" });
    for (const key of Object.keys(row)) {
      expect(key).not.toMatch(/OWN_|FIDU_/);
    }
  });
});

describe("use-code banding", () => {
  it("maps DOR use codes to bands and marks the permit-eligible ones", () => {
    expect(classifyDorUseBand("000")).toBe("vacant_residential");
    expect(classifyDorUseBand("001")).toBe("single_family");
    expect(classifyDorUseBand("004")).toBe("condo");
    expect(classifyDorUseBand("017")).toBe("commercial");
    expect(classifyDorUseBand("048")).toBe("industrial");
    expect(classifyDorUseBand("063")).toBe("agricultural");
    expect(classifyDorUseBand("080")).toBe("government");
    expect(classifyDorUseBand("")).toBe("other");
    expect(isPermitEligibleBand("commercial")).toBe(true);
    expect(isPermitEligibleBand("industrial")).toBe(true);
    expect(isPermitEligibleBand("single_family")).toBe(false);
  });
});

describe("centroid sanity", () => {
  it("accepts a Lake County point and rejects one from another county", () => {
    expect(isInLakeBbox({ latitude: 28.86, longitude: -81.62 })).toBe(true);
    // The measured north and south extremes must stay inside the box.
    expect(isInLakeBbox({ latitude: 28.3462, longitude: -81.9543 })).toBe(true);
    expect(isInLakeBbox({ latitude: 29.2772, longitude: -81.3527 })).toBe(true);
    expect(isInLakeBbox({ latitude: 30.33, longitude: -81.65 })).toBe(false);
    expect(isInLakeBbox({ latitude: "", longitude: "" })).toBe(false);
  });

  it("drops an out-of-county centroid instead of publishing it", () => {
    const row = toSeedRow({
      nal: NAL_ROW,
      centroid: { latitude: 30.33, longitude: -81.65 },
      sourceRevision: "abc",
      snapshotAt: "2026-09-09T00:00:00Z",
    });
    expect(row.latitude).toBe("");
    expect(row.source_geometry_source).toBe("none");
  });
});

describe("seed rows", () => {
  it("builds the situs address from the roll's address parts", () => {
    expect(buildSiteAddress(NAL_ROW)).toBe("36828 TAYLOR MILL RD, FRUITLAND PARK FL 34731");
    expect(buildSiteAddress({ PHY_CITY: "EUSTIS" })).toBe("EUSTIS FL");
  });

  it("carries the identifiers, geometry and provenance a later stage needs", () => {
    const row = toSeedRow({
      nal: NAL_ROW,
      centroid: { latitude: 28.86, longitude: -81.62 },
      sdfSaleCount: 2,
      permitCount: 3,
      sourceRevision: "sha256-abc",
      snapshotAt: "2026-09-09T00:00:00Z",
    });
    expect(row.parcel_id).toBe("32-18-24-0250-000-01400");
    expect(row.alt_key).toBe("3404921");
    expect(row.county_fips).toBe("12069");
    expect(row.latitude).toBe("28.86");
    expect(row.source_geometry_source).toBe("fl-gio-parcel-centroid-2025");
    expect(row.source_sdf_sale_count).toBe("2");
    expect(row.source_permit_count).toBe("3");
    expect(row.source_revision).toBe("sha256-abc");
    expect(row.source_ACT_YR_BLT).toBe("1992");
  });

  it("refuses a row whose parcel id is not canonical", () => {
    expect(() =>
      toSeedRow({ nal: { ...NAL_ROW, PARCEL_ID: "bad" }, sourceRevision: "a", snapshotAt: "b" }),
    ).toThrow(/Not a canonical Lake parcel id/);
  });

  it("renders a CSV with the declared column order and round-trips", async () => {
    const { rows, csv } = await buildSeed({
      records: [{ nal: NAL_ROW }, { nal: { ...NAL_ROW, PARCEL_ID: "01-22-24-1500-063-00001", ALT_KEY: "3404947" } }],
      sourceRevision: "rev",
      snapshotAt: "2026-09-09T00:00:00Z",
    });
    expect(rows).toHaveLength(2);
    const parsed = parseCsvRecords(csv);
    expect(parsed).toHaveLength(2);
    expect(Object.keys(parsed[0])).toEqual([...SEED_COLUMNS]);
    expect(parsed[0].parcel_id).toBe("32-18-24-0250-000-01400");
  });
});

describe("seed reconciliation", () => {
  it("passes when every counter agrees", () => {
    expect(() =>
      assertSeedReconciliation({
        rowsWritten: 3,
        uniqueParcelIds: 3,
        uniqueAltKeys: 3,
        expectedSeedRowCount: 3,
        invalidRecordCount: 0,
        skippedRecordCount: 0,
      }),
    ).not.toThrow();
  });

  it("fails closed when a join fanned the rows out", () => {
    expect(() =>
      assertSeedReconciliation({
        rowsWritten: 4,
        uniqueParcelIds: 3,
        uniqueAltKeys: 4,
        expectedSeedRowCount: 4,
        invalidRecordCount: 0,
        skippedRecordCount: 0,
      }),
    ).toThrow(/uniqueParcelIds 3 != rowsWritten 4/);
  });

  it("fails closed when the written count misses the expected count", () => {
    expect(() =>
      assertSeedReconciliation({
        rowsWritten: 2,
        uniqueParcelIds: 2,
        uniqueAltKeys: 2,
        expectedSeedRowCount: 3,
        invalidRecordCount: 0,
        skippedRecordCount: 0,
      }),
    ).toThrow(/rowsWritten 2 != expectedSeedRowCount 3/);
  });

  it("refuses a duplicated alternate key, which would double-count permits", async () => {
    await expect(
      buildSeed({
        records: [
          { nal: NAL_ROW },
          { nal: { ...NAL_ROW, PARCEL_ID: "01-22-24-1500-063-00001" } },
        ],
      }),
    ).rejects.toThrow(/uniqueAltKeys/);
  });
});
