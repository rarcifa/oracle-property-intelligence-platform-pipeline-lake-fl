import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/lake-query-table-sql-regressions/", import.meta.url),
);
const sql = readFileSync(new URL("../scripts/lake/build-query-table.sql", import.meta.url), "utf8");
const describedColumnSchema = z.object({ column_name: z.string(), column_type: z.string() });
const expectedSchemas = z
  .object({
    property: z.array(describedColumnSchema),
    permit: z.array(describedColumnSchema),
  })
  .parse(JSON.parse(readFileSync(path.join(fixtureRoot, "expected-schemas.json"), "utf8")));
const propertySchema = z.object({
  alt_key: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  roof_age_years: z.number().int().nullable(),
  roof_age_basis: z.string().nullable(),
  roof_last_permit_date: z.string().nullable(),
  source_systems: z.string(),
});
let artifactRoot: string | undefined;
let propertyPath: string;
let permitPath: string;

function quote(value: string): string {
  return value.replace(/'/g, "''");
}

function execute(statement: string): string {
  return execFileSync("duckdb", ["-batch", "-json", "-c", statement], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function query<Schema extends z.ZodType>(statement: string, schema: Schema): z.output<Schema>[] {
  const result: unknown = JSON.parse(execute(statement));
  return z.array(schema).parse(result);
}

function property(key: string): z.output<typeof propertySchema> {
  const row = query(
    `SELECT alt_key, latitude, longitude, roof_age_years, roof_age_basis, roof_last_permit_date, source_systems FROM read_parquet('${quote(propertyPath)}') WHERE alt_key='${quote(key)}'`,
    propertySchema,
  )[0];
  if (row === undefined) throw new Error(`Missing fixture property ${key}`);
  return row;
}

beforeAll(() => {
  try {
    execFileSync("duckdb", ["--version"], { encoding: "utf8", stdio: "pipe" });
  } catch (cause) {
    throw new Error(
      "These SQL regression tests require the real DuckDB CLI. Install DuckDB and ensure duckdb is on PATH; no mocked or vacuous fallback is allowed.",
      { cause },
    );
  }
  // Verify the uncast fixture count expression is nonnegative and fits INT32
  // before producing the ordinarily cast Parquet output.
  const range = query(
    `SELECT min(owner_count) AS minimum, max(owner_count) AS maximum, count(*) FILTER (WHERE owner_count < 0 OR owner_count > 2147483647) AS out_of_range FROM (SELECT CASE WHEN trim(coalesce(OWN_NAME,''))='' THEN 0 ELSE greatest(1,len(list_filter(str_split(trim(OWN_NAME),'&'),x -> trim(x)<>''))) END AS owner_count FROM read_csv_auto('${quote(path.join(fixtureRoot, "NAL45P202601.csv"))}', header=true, all_varchar=true))`,
    z.object({
      minimum: z.number().int(),
      maximum: z.number().int(),
      out_of_range: z.number().int(),
    }),
  )[0];
  if (range === undefined) throw new Error("Missing fixture owner-count range proof");
  expect(range.minimum).toBeGreaterThanOrEqual(0);
  expect(range.maximum).toBeLessThanOrEqual(2147483647);
  expect(range.out_of_range).toBe(0);
  artifactRoot = mkdtempSync(path.join(os.tmpdir(), "lake-query-table-sql-regressions-"));
  propertyPath = path.join(artifactRoot, "properties.parquet");
  permitPath = path.join(artifactRoot, "permits.parquet");
  execute(
    sql
      .replaceAll("$DOWNLOAD_DIR", quote(fixtureRoot))
      .replaceAll("$PERMIT_OUT_PARQUET", quote(permitPath))
      .replaceAll("$OUT_PARQUET", quote(propertyPath))
      .replaceAll("$AS_OF_YEAR", "2026")
      .replaceAll("$AS_OF_DATE", "2026-09-16"),
  );
});

afterAll(() => {
  if (artifactRoot === undefined) return;
  if (
    path.dirname(artifactRoot) !== os.tmpdir() ||
    !path.basename(artifactRoot).startsWith("lake-query-table-sql-regressions-")
  ) {
    throw new Error("Refusing cleanup outside the isolated SQL fixture run");
  }
  rmSync(artifactRoot, { recursive: true, force: true });
});

describe("Lake query-table SQL regressions with real DuckDB", () => {
  it("selects one actual coordinate pair rather than crossing independent minima", () => {
    expect(property("A")).toMatchObject({ latitude: 28.6, longitude: -81.2 });
    expect(
      query(
        `SELECT count(*) AS absent_source_pairs FROM read_parquet('${quote(propertyPath)}') p WHERE latitude IS NOT NULL AND NOT EXISTS (SELECT 1 FROM read_csv_auto('${quote(path.join(fixtureRoot, "centroids.csv"))}', header=true, all_varchar=true) c WHERE c.alt_key=p.alt_key AND TRY_CAST(c.latitude AS DOUBLE)=p.latitude AND TRY_CAST(c.longitude AS DOUBLE)=p.longitude)`,
        z.object({ absent_source_pairs: z.number().int() }),
      ),
    ).toEqual([{ absent_source_pairs: 0 }]);
  });

  it("deduplicates centroid keys without multiplying parcels or permit counts", () => {
    expect(
      query(
        `SELECT count(*) AS rows, count(DISTINCT parcel_identifier) AS parcels FROM read_parquet('${quote(propertyPath)}')`,
        z.object({ rows: z.number().int(), parcels: z.number().int() }),
      ),
    ).toEqual([{ rows: 9, parcels: 9 }]);
    expect(property("B")).toMatchObject({ latitude: 28.7, longitude: -81.3 });
    expect(
      query(
        `SELECT permit_count, roofing_permit_count, open_roofing_permit_count FROM read_parquet('${quote(propertyPath)}') WHERE alt_key='B'`,
        z.object({
          permit_count: z.number().int(),
          roofing_permit_count: z.number().int(),
          open_roofing_permit_count: z.number().int(),
        }),
      ),
    ).toEqual([{ permit_count: 2, roofing_permit_count: 2, open_roofing_permit_count: 1 }]);
  });

  it("rejects nonfinite, invalid, out-of-range, and incomplete coordinate pairs", () => {
    for (const key of ["C", "D"]) {
      expect(property(key)).toMatchObject({ latitude: null, longitude: null });
      expect(property(key).source_systems).not.toContain("fl_gio_parcel_centroid_2025");
    }
  });

  it("does not reset roof age from open roofing permits carrying completion dates", () => {
    expect(property("A")).toMatchObject({
      roof_age_years: 56,
      roof_age_basis: "year_built",
      roof_last_permit_date: null,
    });
    expect(
      query(
        `SELECT completed_date, issued_date, is_open FROM read_parquet('${quote(permitPath)}') WHERE alt_key='A'`,
        z.object({ completed_date: z.string(), issued_date: z.string(), is_open: z.boolean() }),
      ),
    ).toEqual([{ completed_date: "2025-02-01", issued_date: "2024-01-01", is_open: true }]);
  });

  it("requires explicit closure instead of treating unknown or missing status as closed", () => {
    expect(property("C")).toMatchObject({
      roof_age_years: 52,
      roof_age_basis: "year_built",
      roof_last_permit_date: null,
    });
    expect(property("H")).toMatchObject({
      roof_age_years: 46,
      roof_age_basis: "year_built",
      roof_last_permit_date: null,
    });
  });

  it("uses valid closed completion evidence and ignores a newer open completion", () => {
    expect(property("B")).toMatchObject({
      roof_age_years: 8,
      roof_age_basis: "roofing_permit_completed",
      roof_last_permit_date: "2018-04-01",
    });
  });

  it("preserves the clearly named closed-issued proxy when completion cannot anchor", () => {
    const expected: Array<[string, number, string]> = [
      ["D", 8, "2018-01-01"],
      ["E", 6, "2020-01-01"],
      ["G", 1, "2025-01-01"],
    ];
    for (const [key, years, issuedDate] of expected) {
      expect(property(key)).toMatchObject({
        roof_age_years: years,
        roof_age_basis: "roofing_permit_issued",
        roof_last_permit_date: issuedDate,
      });
    }
  });

  it("falls back honestly when closed permits contain invalid or missing dates", () => {
    for (const key of ["F", "I"]) {
      expect(property(key)).toMatchObject({
        roof_age_years: 46,
        roof_age_basis: "year_built",
        roof_last_permit_date: null,
      });
    }
  });

  it("preserves raw invalid and future completion dates and unknown-status nulls", () => {
    expect(
      query(
        `SELECT alt_key, completed_date FROM read_parquet('${quote(permitPath)}') WHERE alt_key IN ('D','G') ORDER BY alt_key`,
        z.object({ alt_key: z.string(), completed_date: z.string() }),
      ),
    ).toEqual([
      { alt_key: "D", completed_date: "2025-02-30" },
      { alt_key: "G", completed_date: "2027-01-01" },
    ]);
    expect(
      query(
        `SELECT alt_key, is_open FROM read_parquet('${quote(permitPath)}') WHERE alt_key IN ('C','H') ORDER BY alt_key`,
        z.object({ alt_key: z.string(), is_open: z.boolean().nullable() }),
      ),
    ).toEqual([
      { alt_key: "C", is_open: null },
      { alt_key: "H", is_open: null },
    ]);
  });

  it("writes INTEGER/Parquet INT32 owner counts with unchanged values, nulls, and table schemas", () => {
    expect(
      query(`DESCRIBE SELECT * FROM read_parquet('${quote(propertyPath)}')`, describedColumnSchema),
    ).toEqual(expectedSchemas.property);
    expect(
      query(`DESCRIBE SELECT * FROM read_parquet('${quote(permitPath)}')`, describedColumnSchema),
    ).toEqual(expectedSchemas.permit);
    expect(expectedSchemas.property).toHaveLength(63);
    expect(expectedSchemas.permit).toHaveLength(22);
    expect(
      query(
        `SELECT type FROM parquet_schema('${quote(propertyPath)}') WHERE name='owner_count'`,
        z.object({ type: z.string() }),
      ),
    ).toEqual([{ type: "INT32" }]);
    const owners = query(
      `SELECT alt_key, owner_count, owner_name FROM read_parquet('${quote(propertyPath)}') ORDER BY alt_key`,
      z.object({
        alt_key: z.string(),
        owner_count: z.number().int().nonnegative().max(2147483647),
        owner_name: z.string().nullable(),
      }),
    );
    expect(owners).toHaveLength(9);
    expect(owners.slice(0, 3)).toEqual([
      { alt_key: "A", owner_count: 2, owner_name: "OWNER A & OWNER B" },
      { alt_key: "B", owner_count: 0, owner_name: null },
      { alt_key: "C", owner_count: 1, owner_name: "OWNER C &" },
    ]);
    expect(
      query(
        `SELECT count(*) AS rows, count(DISTINCT permit_id) AS unique_permits FROM read_parquet('${quote(permitPath)}')`,
        z.object({ rows: z.number().int(), unique_permits: z.number().int() }),
      ),
    ).toEqual([{ rows: 10, unique_permits: 10 }]);
    expect(sql).toContain(") END AS INTEGER)");
    expect(sql).not.toContain("diagnostic_only");
    expect(() => execute("SELECT CAST(2147483648 AS INTEGER)")).toThrow();
  });
});
