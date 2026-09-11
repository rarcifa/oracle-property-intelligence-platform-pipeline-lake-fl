import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTransformedZipJsonFiles } from "../src/core/query-table.mjs";
import { loadRetryableFailures } from "../src/core/run-state.mjs";
import {
  assertSeedRowParcel,
  buildLexiconFiles,
  captureAndTransform,
  classifyLakeFailure,
  hasCompletedTransform,
  loadPermitIndex,
  nalRecordFromSeedRow,
  validateRun,
  assertTransformedCounty,
} from "../src/counties/lake/adapter.mjs";
import { toSeedRow } from "../src/counties/lake/seed.mjs";

const NAL_ROW = Object.freeze({
  PARCEL_ID: "32-18-24-0250-000-01400",
  ALT_KEY: "3404921",
  ASMNT_YR: "2026",
  DOR_UC: "001",
  JV: "318622",
  AV_NSD: "250000",
  LND_VAL: "60000",
  TV_NSD: "200000",
  LND_SQFOOT: "43560",
  ACT_YR_BLT: "1992",
  TOT_LVG_AREA: "1800",
  PHY_ADDR1: "36828 TAYLOR MILL RD",
  PHY_CITY: "FRUITLAND PARK",
  PHY_ZIPCD: "34731",
  SALE_YR1: "2025",
  SALE_MO1: "6",
  SALE_PRC1: "410000",
});

/**
 * @param {Record<string, unknown>} [overrides] - NAL overrides.
 * @returns {Record<string, string>} A seed row.
 */
function seedRow(overrides = {}) {
  return toSeedRow({
    nal: { ...NAL_ROW, ...overrides },
    centroid: { latitude: 28.86, longitude: -81.62 },
    sourceRevision: "sha256:test",
    snapshotAt: "2026-09-09T00:00:00Z",
  });
}

describe("seed round trip", () => {
  it("rebuilds the roll record the seed carries", () => {
    const nal = nalRecordFromSeedRow(seedRow());
    expect(nal.PARCEL_ID).toBe("32-18-24-0250-000-01400");
    expect(nal.ALT_KEY).toBe("3404921");
    expect(nal.ACT_YR_BLT).toBe("1992");
  });

  it("accepts a consistent row and refuses a mismatched one", () => {
    const row = seedRow();
    expect(assertSeedRowParcel(row)).toBe("32-18-24-0250-000-01400");
    expect(() => assertSeedRowParcel({ ...row, source_PARCEL_ID: "01-22-24-1500-063-00001" })).toThrow(
      /does not match source_PARCEL_ID/,
    );
    expect(() => assertSeedRowParcel({ ...row, parcel_id: "nope" })).toThrow(/Not a canonical Lake parcel id/);
  });
});

describe("lexicon files", () => {
  it("emits the required artifacts plus geometry and sales when present", () => {
    const files = buildLexiconFiles({ row: seedRow(), permits: [] });
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["property.json", "address.json", "lot.json", "tax_1.json", "geometry.json", "sales_history_1.json"]),
    );
    expect(files["address.json"].county_name).toBe("Lake");
    expect(files["geometry.json"].latitude).toBe(28.86);
    expect(files["sales_history_1.json"].ownership_transfer_date).toBe("2025-06-01");
  });

  it("omits geometry when the parcel has no centroid", () => {
    const row = toSeedRow({ nal: NAL_ROW, centroid: null, sourceRevision: "r", snapshotAt: "s" });
    const files = buildLexiconFiles({ row, permits: [] });
    expect(files["geometry.json"]).toBeUndefined();
  });

  it("writes one permit artifact per permit", () => {
    const files = buildLexiconFiles({
      row: seedRow(),
      permits: [
        { permit_number: "A", is_roofing: true, is_open: true },
        { permit_number: "B", is_roofing: false, is_open: false },
      ],
    });
    expect(files["permit_1.json"].permit_number).toBe("A");
    expect(files["permit_2.json"].permit_number).toBe("B");
  });

  it("refuses a transformed address for the wrong county", () => {
    expect(() => assertTransformedCounty({ county_name: "Duval" })).toThrow(/must be Lake/);
    expect(() => assertTransformedCounty(null)).toThrow(/missing/);
  });
});

describe("failure classification", () => {
  it("treats format and county errors as permanent and network errors as transient", () => {
    expect(classifyLakeFailure(new Error("Not a canonical Lake parcel id: x"))).toBe("permanent");
    expect(classifyLakeFailure(new Error("transformed county_name must be Lake"))).toBe("permanent");
    expect(classifyLakeFailure(new Error("HTTP 503 upstream"))).toBe("transient");
    expect(classifyLakeFailure(new Error("socket hang up"))).toBe("transient");
  });
});

describe("permit index", () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "lake-permits-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("groups permits by alternate key and ignores blank keys", async () => {
    const permitsPath = path.join(dir, "permits.json");
    await writeFile(
      permitsPath,
      JSON.stringify([
        { permit_number: "1", alternate_key: "3404921" },
        { permit_number: "2", alternate_key: "3404921" },
        { permit_number: "3", alternate_key: "" },
      ]),
      "utf8",
    );
    const index = await loadPermitIndex(permitsPath);
    expect(index.get("3404921")).toHaveLength(2);
    expect(index.size).toBe(1);
  });

  it("returns an empty index when no permits have been harvested", async () => {
    expect((await loadPermitIndex(path.join(dir, "missing.json"))).size).toBe(0);
  });
});

describe("pilot ingest run", () => {
  let workDir;
  let permitsPath;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "lake-run-"));
    permitsPath = path.join(workDir, "permits.json");
    await writeFile(
      permitsPath,
      JSON.stringify([
        {
          permit_number: "2026021076",
          alternate_key: "3404921",
          permit_type: "RFR",
          permit_status: "ISSUED",
          is_roofing: true,
          is_open: true,
          issued_date: "2020-06-01",
          co_date: null,
          days_open: 2200,
        },
      ]),
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("transforms every seed row and validates the run", async () => {
    const outputDir = path.join(workDir, "ingest");
    const seedRows = [seedRow(), seedRow({ PARCEL_ID: "28-18-24-0500-00B-02500", ALT_KEY: "3405285" })];
    const manifest = await captureAndTransform({ seedRows, outputDir, permitsPath, jobId: "test" });

    expect(manifest.reconciled).toEqual({ seedRows: 2, success: 2, permanentFailure: 0, retryableFailure: 0 });
    expect(manifest.results[0].permitCount).toBe(1);
    expect(manifest.results[1].permitCount).toBe(0);
    expect(await hasCompletedTransform(path.join(outputDir, "32-18-24-0250-000-01400"))).toBe(true);

    const files = readTransformedZipJsonFiles(
      path.join(outputDir, "32-18-24-0250-000-01400", "transformed.zip"),
    );
    expect(files["property.json"]).toBeDefined();
    expect(files["address.json"].county_name).toBe("Lake");
    expect(files["permit_1.json"].permit_number).toBe("2026021076");

    const validation = await validateRun(manifest);
    expect(validation.valid).toBe(true);
    expect(validation.checked).toBe(2);
    expect(validation.issues).toEqual([]);
  });

  it("records a bad row as a permanent failure and keeps the good rows", async () => {
    const outputDir = path.join(workDir, "ingest-mixed");
    const bad = { ...seedRow(), parcel_id: "not-a-parcel" };
    const manifest = await captureAndTransform({
      seedRows: [seedRow(), bad],
      outputDir,
      permitsPath,
      jobId: "test-mixed",
    });
    expect(manifest.reconciled.success).toBe(1);
    expect(manifest.reconciled.permanentFailure).toBe(1);
    const failures = await loadRetryableFailures(outputDir, "test-mixed", { includePermanent: true });
    expect(failures.map((failure) => failure.parcelId)).toContain("not-a-parcel");
  });

  it("refuses to call an all-failure run valid", async () => {
    const outputDir = path.join(workDir, "ingest-empty");
    await mkdir(outputDir, { recursive: true });
    const manifest = {
      outputDir,
      results: [{ parcelId: "x", classification: "permanent_failure" }],
      reconciled: { seedRows: 1, success: 0, permanentFailure: 1, retryableFailure: 0 },
    };
    const validation = await validateRun(manifest);
    expect(validation.valid).toBe(false);
    expect(validation.issues[0].reason).toMatch(/refusing to treat an all-failure run as valid/);
    expect((await validateRun(manifest, { allowEmpty: true })).valid).toBe(true);
  });

  it("catches a duplicated parcel in the run results", async () => {
    const outputDir = path.join(workDir, "ingest-dupe");
    await mkdir(outputDir, { recursive: true });
    const validation = await validateRun({
      outputDir,
      results: [
        { parcelId: "a", classification: "permanent_failure" },
        { parcelId: "a", classification: "permanent_failure" },
      ],
      reconciled: { seedRows: 2, success: 0, permanentFailure: 2, retryableFailure: 0 },
    }, { allowEmpty: true });
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => /duplicate parcelId/.test(issue.reason))).toBe(true);
  });
});
