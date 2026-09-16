/** Permit headlines must preserve valid-unlinked rows and expose their grain. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { PERMIT_TABLE_COLUMNS, QUERY_TABLE_COLUMNS } from "@oracle-lake/shared";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import { getContractorView, getDatasetStats, type ProvenanceContext } from "../src/data/queries.js";
import { callTool } from "../src/mcp/tools.js";
import { bodyJson, closeStore, getContext, getStore, hasParquet, request } from "./harness.js";

const provenance: ProvenanceContext = {
  runId: "permit-count-fixture",
  rootCid: null,
  dataSource: "fixture",
  dataSourceKind: "local",
};
const temporaryDirectories: string[] = [];
const stores: OracleDataStore[] = [];

afterAll(async () => {
  for (const store of stores) store.close();
  closeStore();
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true });
});

describe.skipIf(!hasParquet)("permit counts over the configured real dataset", () => {
  it("reconciles the full permit table with API/MCP headlines and linked property sums", async () => {
    const store = await getStore();
    const context = await getContext();
    const stats = await getDatasetStats(store, await context.provenance());
    const propertyAggregate = Number(
      await store.queryScalar("SELECT coalesce(sum(permit_count), 0) FROM properties"),
    );
    expect(stats.stats.permit_records_property_aggregate).toBe(propertyAggregate);
    if (!store.permitsAvailable) {
      expect(stats.stats.permit_records).toBe(propertyAggregate);
      expect(stats.stats).not.toHaveProperty("permit_records_total");
      expect(stats.stats).not.toHaveProperty("permit_records_valid_unlinked");
      return;
    }
    const counts = await store.queryOne(`SELECT
      count(*) AS total,
      count(*) FILTER (WHERE linkage_status = 'linked_to_assessed_roll') AS linked,
      count(*) FILTER (WHERE linkage_status = 'unlinked_to_assessed_roll') AS unlinked
      FROM permits`);
    const expected = {
      permit_records: Number(counts?.total),
      permit_records_total: Number(counts?.total),
      permit_records_linked: Number(counts?.linked),
      permit_records_valid_unlinked: Number(counts?.unlinked),
      permit_records_property_aggregate: propertyAggregate,
    };
    expect(expected.permit_records_total).toBe(
      expected.permit_records_linked + expected.permit_records_valid_unlinked,
    );
    expect(expected.permit_records_linked).toBe(propertyAggregate);
    expect(stats.stats).toMatchObject(expected);
    const contractor = await getContractorView(store, await context.provenance());
    expect(contractor.posture).toMatchObject(expected);
    const response = await request(createApp(context), "GET", "/api/stats");
    expect(response.status).toBe(200);
    expect(bodyJson<{ stats: Record<string, number> }>(response).stats).toMatchObject(expected);
    const mcp = await callTool(context, "getOracleDatasetInfo", {});
    expect(mcp.isError).toBeFalsy();
    expect((mcp.payload as { liveCounts: Record<string, number> }).liveCounts).toMatchObject(
      expected,
    );
  });
});

const SQL_TYPES: Record<string, string> = {
  UTF8: "VARCHAR",
  INT32: "INTEGER",
  DOUBLE: "DOUBLE",
  BOOLEAN: "BOOLEAN",
};

async function fixture(
  options: { legacy?: boolean; status?: string; propertyCount?: number } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "oracle-permit-counts-"));
  temporaryDirectories.push(directory);
  const propertyPath = path.join(directory, "query-table.parquet");
  const permitPath = path.join(directory, "permit-table.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const propertyOverrides: Record<string, string> = {
      request_identifier: "'fixture-parcel'",
      permit_count: String(options.propertyCount ?? 2),
      roofing_permit_count: "2",
      open_permit_count: "2",
      open_roofing_permit_count: "2",
      has_permits: "TRUE",
    };
    const properties = QUERY_TABLE_COLUMNS.map(
      (column) =>
        `CAST(${propertyOverrides[column.name] ?? "NULL"} AS ${SQL_TYPES[column.type]}) AS ${column.name}`,
    ).join(", ");
    await connection.run(`COPY (SELECT ${properties}) TO '${propertyPath}' (FORMAT PARQUET)`);
    const permits = PERMIT_TABLE_COLUMNS.map((column) => {
      const values: Record<string, string> = {
        permit_id: "'fixture-permit-' || i::VARCHAR",
        parcel_identifier: "CASE WHEN i < 3 THEN 'fixture-parcel' END",
        linkage_status: `CASE WHEN i < 3 THEN 'linked_to_assessed_roll' ELSE '${options.status ?? "unlinked_to_assessed_roll"}' END`,
        is_roofing: "TRUE",
        is_open: "TRUE",
        days_open: "2000",
      };
      return `CAST(${values[column.name] ?? "NULL"} AS ${SQL_TYPES[column.type]}) AS ${column.name}`;
    }).join(", ");
    await connection.run(
      `COPY (SELECT ${permits} FROM range(1, 4) r(i)) TO '${permitPath}' (FORMAT PARQUET)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  const store = new OracleDataStore({
    source: propertyPath,
    permitSource: options.legacy ? null : permitPath,
  });
  stores.push(store);
  await store.init();
  const config = loadConfig({
    ORACLE_PARQUET_PATH: propertyPath,
    ORACLE_RUN_DIR: directory,
    ORACLE_LATEST_PATH: path.join(directory, "absent-latest.json"),
    ORACLE_DATA_RUN_ID: provenance.runId ?? "permit-count-fixture",
    OPENAI_API_KEY: "",
  });
  return { store, context: createContext(config, store) };
}

const fullCounts = {
  permit_records: 3,
  permit_records_total: 3,
  permit_records_linked: 2,
  permit_records_valid_unlinked: 1,
  permit_records_property_aggregate: 2,
};

describe("permit-table counts across the query, API and MCP surfaces", () => {
  it("includes valid-unlinked permits while keeping property and linked record grains", async () => {
    const { store, context } = await fixture();
    const stats = await getDatasetStats(store, provenance);
    const contractor = await getContractorView(store, provenance);
    expect(stats.stats).toMatchObject(fullCounts);
    expect(contractor.posture).toMatchObject(fullCounts);
    expect(stats.stats.with_open_roofing_permit).toBe(1);
    expect(contractor.posture.open_roofing_permit_records).toBe(2);
    expect(stats.provenance.sql).toContain("FROM permits");
    expect(stats.provenance.rootCid).toBeNull();

    const response = await request(createApp(context), "GET", "/api/stats");
    expect(response.status).toBe(200);
    expect(bodyJson<{ stats: Record<string, number> }>(response).stats).toMatchObject(fullCounts);
    const mcp = await callTool(context, "getOracleDatasetInfo", {});
    expect(mcp.isError).toBeFalsy();
    expect((mcp.payload as { liveCounts: Record<string, number> }).liveCounts).toMatchObject(
      fullCounts,
    );
    expect((mcp.payload as { run: unknown }).run).toBeNull();
    expect(
      await store.queryScalar("SELECT count(*) FROM permits WHERE parcel_identifier IS NULL"),
    ).toBe(1);
  });

  it("does not invent full-table or valid-unlinked zeros for a legacy property-only run", async () => {
    const { store } = await fixture({ legacy: true });
    expect(store.permitsAvailable).toBe(false);
    for (const counts of [
      (await getDatasetStats(store, provenance)).stats,
      (await getContractorView(store, provenance)).posture,
    ]) {
      expect(counts.permit_records).toBe(2);
      expect(counts.permit_records_property_aggregate).toBe(2);
      expect(counts).not.toHaveProperty("permit_records_total");
      expect(counts).not.toHaveProperty("permit_records_linked");
      expect(counts).not.toHaveProperty("permit_records_valid_unlinked");
    }
  });

  it("fails closed on unclassified linkage or a mismatched property aggregate", async () => {
    for (const options of [{ status: "unknown" }, { propertyCount: 1 }]) {
      const { store } = await fixture(options);
      await expect(getDatasetStats(store, provenance)).rejects.toThrow("do not reconcile");
      await expect(getContractorView(store, provenance)).rejects.toThrow("do not reconcile");
    }
  });
});
