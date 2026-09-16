/** Synthetic source facts exercise the public projection without promoting old decisions. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUSINESS_TABLE_COLUMNS,
  PERMIT_TABLE_COLUMNS,
  QUERY_TABLE_COLUMNS,
  quote,
} from "@oracle-lake/shared";
import { buildSourceOnlyExport } from "../../../pipeline/scripts/lake/build-source-only-export.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import {
  getDatasetStats,
  getPropertyPermits,
  searchBusinessAccounts,
  searchProperties,
} from "../src/data/queries.js";
import { createContext } from "../src/context.js";
import { loadConfig } from "../src/config.js";
import { callTool } from "../src/mcp/tools.js";
import { LAKE_BUSINESS_TABLE_SCHEMA_FIELDS } from "../../../pipeline/src/counties/lake/business-table.mjs";

let directory = "";
let store: OracleDataStore;
let options: Parameters<typeof buildSourceOnlyExport>[0];
const provenance = {
  runId: "20260916T181000Z",
  rootCid: null,
  dataSource: "synthetic-source-only",
  dataSourceKind: "local" as const,
  sourceObservationsOnly: true,
};
const type = (value: string): string =>
  ({ UTF8: "VARCHAR", INT32: "INTEGER", DOUBLE: "DOUBLE", BOOLEAN: "BOOLEAN" })[value] ?? value;
const projection = (
  columns: readonly { name: string; type: string }[],
  values: Record<string, string>,
): string =>
  columns
    .map(
      (column) =>
        `CAST(${values[column.name] ?? "NULL"} AS ${type(column.type)}) AS ${column.name}`,
    )
    .join(", ");
const sha256 = async (file: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "oracle-synthetic-source-only-"));
  const propertyInput = join(directory, "frozen-properties.parquet");
  const permitInput = join(directory, "frozen-permits.parquet");
  const businessInput = join(directory, "frozen-businesses.parquet");
  const db = await DuckDBInstance.create(":memory:");
  const connection = await db.connect();
  try {
    await connection.run(
      `COPY (SELECT ${projection(QUERY_TABLE_COLUMNS, { property_id: "'fixture-property'", request_identifier: "'fixture-folio'", built_year: "1990", has_permits: "true", permit_count: "1", open_roofing_permit_count: "1", roofing_permit_count: "1", roof_age_basis: "'completed_permit'", roof_age_years: "2", contractor_name: "'Synthetic Source Name'" })}) TO ${quote(propertyInput)} (FORMAT PARQUET)`,
    );
    const permit = (id: string, linked: boolean): string =>
      projection(PERMIT_TABLE_COLUMNS, {
        permit_id: quote(id),
        permit_number: quote(id),
        parcel_identifier: linked ? "'fixture-folio'" : "NULL",
        linkage_status: linked ? "'linked_to_assessed_roll'" : "'unlinked_to_assessed_roll'",
        permit_status: "'ISSUED'",
        permit_description: "'Source says reroof'",
        issued_date: "'2027-01-01'",
        completed_date: "'2024-01-01'",
        is_open: "true",
        is_roofing: "true",
        days_open: "99",
        contractor_name: "'Synthetic Source Name'",
        contractor_license: "'Unverified Candidate'",
        bbb_rating: "'Invented Input Score'",
        source_url: "'https://example.test/permit'",
        source_system: "'lake_clermont_etrakit_permits'",
      });
    await connection.run(
      `COPY (SELECT ${permit("fixture-linked", true)} UNION ALL SELECT ${permit("fixture-unlinked", false)}) TO ${quote(permitInput)} (FORMAT PARQUET)`,
    );
    await connection.run(
      `COPY (SELECT ${BUSINESS_TABLE_COLUMNS.map(([name, dataType]) => `CAST(${{ business_id: "'lake:fl_dor_tpp:000A'", county: "'lake'", account_id: "'000A'", matched_parcel_count: "0", matched_parcel_ids: "'[]'" }[name] ?? "NULL"} AS ${dataType}) AS ${name}`).join(", ")}) TO ${quote(businessInput)} (FORMAT PARQUET)`,
    );
  } finally {
    connection.closeSync();
    db.closeSync();
  }
  options = {
    propertyInput,
    propertySha256: await sha256(propertyInput),
    permitInput,
    permitSha256: await sha256(permitInput),
    businessInput,
    businessSha256: await sha256(businessInput),
    output: join(directory, "separate-export"),
    runId: provenance.runId,
    asOfDate: "2026-09-16",
    expectedProperties: 1,
    expectedPermits: 2,
    expectedBusinesses: 1,
  };
  await buildSourceOnlyExport(options);
  store = new OracleDataStore({ source: join(options.output, "query-table.parquet") });
  await store.init();
});
afterAll(async () => {
  store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("source-only public dataset", () => {
  it("keeps literal source evidence and valid unlinked permits, holding unsupported conclusions", async () => {
    expect(store.sourceObservationsOnly).toBe(true);
    expect(await store.queryScalar("SELECT count(*) FROM permits")).toBe(2);
    const result = await getPropertyPermits(store, provenance, "fixture-folio", 20);
    expect(result.permits[0]).toMatchObject({
      permit_status: "ISSUED",
      issued_date: "2027-01-01",
      contractor_name: "Synthetic Source Name",
      completed_date: null,
      is_open: null,
      is_roofing: null,
      days_open: null,
      contractor_license: null,
      bbb_rating: null,
    });
    expect(result.provenance.sourceObservationsOnly).toBe(true);
  });
  it("allows the brief's LOW building-year proxy, not a completed-roof anchor", async () => {
    const result = await searchProperties(store, provenance, { minRoofAge: 15 });
    expect(result.matched).toBe(1);
    expect(result.rows[0]).toMatchObject({
      roof_age_years: 36,
      roof_age_basis: "built_year_proxy",
      roof_last_permit_date: null,
    });
    await expect(
      searchProperties(store, provenance, { hasOpenRoofingPermit: true }),
    ).rejects.toThrow("unknown evidence is not an empty result");
    const context = createContext(
      loadConfig({ ORACLE_PARQUET_PATH: store.source, ORACLE_DATA_RUN_ID: provenance.runId }),
      store,
    );
    expect(await callTool(context, "findOpenRoofPermits", {})).toMatchObject({
      isError: true,
      payload: { error: "unsupported_source_observation_decision" },
    });
  });
  it("does not turn held current-open decisions into dashboard zeros", async () => {
    const result = await getDatasetStats(store, provenance);
    expect(result.stats).toMatchObject({
      permit_records_total: 2,
      permit_records_linked: 1,
      permit_records_valid_unlinked: 1,
    });
    expect(Object.keys(result.stats).some((key) => key.includes("open"))).toBe(false);
    expect(result.stats).not.toHaveProperty("roofing_permit_records");
    expect((await searchBusinessAccounts(store, provenance, { linked: false })).matched).toBe(1);
  });
  it("preserves frozen bytes, refuses overwrites, and keeps both business contracts identical", async () => {
    expect(await sha256(options.propertyInput)).toBe(options.propertySha256);
    expect(await sha256(options.permitInput)).toBe(options.permitSha256);
    await expect(buildSourceOnlyExport(options)).rejects.toThrow();
    expect(
      Object.entries(LAKE_BUSINESS_TABLE_SCHEMA_FIELDS).map(([name, field]) => [
        name,
        type(field.type),
      ]),
    ).toEqual(BUSINESS_TABLE_COLUMNS);
  });
});
