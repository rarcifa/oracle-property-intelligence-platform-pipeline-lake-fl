/** Real submitted-snapshot checks, distinct from legacy decision regressions. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { assertSnapshotBytes } from "../src/data/ci-snapshot.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import { getDatasetStats, getCityCentre, searchProperties } from "../src/data/queries.js";

describe("selected CI snapshot integrity", () => {
  it("refuses substituted or truncated bytes", () => {
    expect(() =>
      assertSnapshotBytes(new Uint8Array([1]), { size: 1, sha256: `sha256:${"0".repeat(64)}` }),
    ).toThrow(/immutable manifest/);
  });
});

const directory = process.env.ORACLE_SELECTED_RUN_DIR;
describe.skipIf(!directory)("selected submitted source-only snapshot", () => {
  let store: OracleDataStore;
  let binding: { runId: string; rootCid: string };
  beforeAll(async () => {
    if (!directory) throw new Error("Selected snapshot is required");
    binding = z
      .object({ runId: z.string(), rootCid: z.string() })
      .parse(JSON.parse(readFileSync(resolve(directory, "snapshot-receipt.json"), "utf8")));
    store = new OracleDataStore({ source: resolve(directory, "query-table.parquet") });
    await store.init();
  });
  afterAll(() => store?.close());
  it("opens the actual properties, permits and business account tables", async () => {
    expect(store.sourceObservationsOnly).toBe(true);
    expect(await store.queryScalar("SELECT count(*) FROM properties")).toBe(215806);
    expect(await store.queryScalar("SELECT count(*) FROM businesses")).toBe(33346);
    const coverage = JSON.parse(readFileSync(resolve(directory!, "coverage.json"), "utf8"));
    expect(coverage.runId).toBe(binding.runId);
    expect(await store.queryScalar("SELECT count(*) FROM permits")).toBe(
      coverage.tables.permits.rows,
    );
  });
  it("reconciles linked and unlinked records without dropping either", async () => {
    const result = await getDatasetStats(store, {
      ...binding,
      dataSource: store.source,
      dataSourceKind: "local",
      sourceObservationsOnly: true,
    });
    expect(result.stats.permit_records_total).toBe(
      Number(result.stats.permit_records_linked) +
        Number(result.stats.permit_records_valid_unlinked),
    );
    expect(result.stats.with_coordinates).toBe(209503);
    expect(result.stats.roof_age_known).toBe(169007);
  });
  it("answers the brief's strict older-than-15 five-mile query with canonical source rows", async () => {
    const context = {
      ...binding,
      dataSource: store.source,
      dataSourceKind: "local" as const,
      sourceObservationsOnly: true,
    };
    const centre = await getCityCentre(store, context, "Clermont");
    expect(centre).not.toBeNull();
    if (centre.lat === null || centre.lon === null) throw new Error("No source-backed city centre");
    const result = await searchProperties(store, context, {
      minRoofAge: 16,
      lat: centre.lat,
      lon: centre.lon,
      radiusMiles: 5,
      limit: 25,
    });
    expect(result.matched).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(25);
    for (const row of result.rows) {
      expect(row.request_identifier).toEqual(expect.any(String));
      expect(Number(row.roof_age_years)).toBeGreaterThan(15);
      expect(row.roof_age_basis).toBe("built_year_proxy");
    }
  });
  it("keeps unsupported current-open and roofing conclusions unknown", async () => {
    expect(
      await store.queryScalar(
        "SELECT count(*) FROM permits WHERE is_open IS NOT NULL OR is_roofing IS NOT NULL OR days_open IS NOT NULL",
      ),
    ).toBe(0);
    await expect(
      searchProperties(
        store,
        {
          ...binding,
          dataSource: store.source,
          dataSourceKind: "local",
          sourceObservationsOnly: true,
        },
        { hasOpenRoofingPermit: true },
      ),
    ).rejects.toThrow(/unknown evidence/);
  });
});
