import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { QUERY_TABLE_COLUMNS, quote } from "@oracle-lake/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChatAgent } from "../src/chat/agent.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { OracleDataStore } from "../src/data/duckdb.js";

const QUESTION =
  "Which properties in Lake County within five miles of Clermont have roofs older than 15 years?";
const SQL_TYPES: Readonly<Record<string, string>> = {
  UTF8: "VARCHAR",
  INT32: "INTEGER",
  DOUBLE: "DOUBLE",
  BOOLEAN: "BOOLEAN",
};
let directory = "";
let store: OracleDataStore;
let context: AppContext;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "oracle-chat-canonical-"));
  const source = path.join(directory, "query-table.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    // Full schema; source-only held decision fields remain NULL. The data is a
    // synthetic boundary fixture, not submission evidence or invented county rows.
    const values: Readonly<Record<string, string>> = {
      request_identifier: "'FIXTURE-' || lpad(i::VARCHAR, 2, '0')",
      parcel_identifier: "'PARCEL-' || i::VARCHAR",
      address_street: "i::VARCHAR || ' FIXTURE ST'",
      address_city: "CASE WHEN i IN (5, 6) THEN 'ANOTHER CITY' ELSE 'CLERMONT' END",
      latitude: "CASE WHEN i = 4 THEN NULL WHEN i = 5 THEN 29.5 ELSE 28.5 END",
      longitude: "CASE WHEN i = 4 THEN NULL ELSE -81.75 END",
      built_year: "CASE WHEN i = 3 THEN NULL ELSE 2000 END",
      roof_age_years: "CASE WHEN i = 1 THEN 15 WHEN i = 2 THEN 16 WHEN i = 3 THEN NULL ELSE 26 END",
      roof_age_basis: "CASE WHEN i = 3 THEN NULL ELSE 'built_year_proxy' END",
      source_systems: "'fl_dor_nal;fl_gio'",
      enrichment_status: "'source_observations_only'",
    };
    const columns = QUERY_TABLE_COLUMNS.map(
      (column) =>
        `CAST(${values[column.name] ?? "NULL"} AS ${SQL_TYPES[column.type]}) AS ${column.name}`,
    ).join(", ");
    await connection.run(
      `COPY (SELECT ${columns} FROM range(1, 33) r(i)) TO ${quote(source)} (FORMAT PARQUET)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  store = new OracleDataStore({ source, permitSource: null, businessSource: null });
  await store.init();
  context = {
    config: loadConfig({ OPENAI_API_KEY: "sk-test-only", ORACLE_CHAT_TIMEOUT_MS: "120000" }),
    store,
    provenance: async () => ({
      runId: "canonical-boundary-fixture",
      rootCid: null,
      dataSource: source,
      dataSourceKind: "local",
      sourceObservationsOnly: store.sourceObservationsOnly,
    }),
  };
});
afterAll(async () => {
  store?.close();
  if (directory) await rm(directory, { recursive: true });
});

describe("canonical chat against real DuckDB query execution", () => {
  it("returns canonical nearest rows, strict >15, no forced city boundary, and replayable exact evidence", async () => {
    expect(store.sourceObservationsOnly).toBe(true);
    const response = await createChatAgent(context).run([{ role: "user", content: QUESTION }]);
    expect(response.grounding?.mode).toBe("canonical-query-rows");
    if (response.grounding?.mode !== "canonical-query-rows")
      throw new Error("Missing canonical evidence");
    const evidence = response.grounding.evidence[0];
    if (!evidence?.sql) throw new Error("Missing replayable SQL");
    expect(evidence.tool).toBe("searchProperties");
    expect(evidence.rowCount).toBe(28);
    expect(evidence.rows).toHaveLength(25);
    expect(evidence.rows).toEqual(await store.query(evidence.sql));
    const ids = evidence.rows.map((row) => row.request_identifier);
    expect(ids).toContain("FIXTURE-02"); // exactly 16 is eligible
    expect(ids).toContain("FIXTURE-06"); // nearby parcel outside city remains eligible
    for (const excluded of ["FIXTURE-01", "FIXTURE-03", "FIXTURE-04", "FIXTURE-05"]) {
      expect(ids).not.toContain(excluded);
    }
    for (const row of evidence.rows) {
      expect(Number(row.roof_age_years)).toBeGreaterThan(15);
      expect(Number(row.distance_miles)).toBeLessThanOrEqual(5);
      expect(response.answer).toContain(`request_identifier: ${row.request_identifier}`);
      expect(response.answer).toContain(`address_street: ${row.address_street}`);
      expect(row.open_roofing_permit_count).toBeNull();
    }
    expect(response.citations[0]?.sql).toContain("avg(latitude)");
    expect(response.citations[0]?.runId).toBe("canonical-boundary-fixture");
    expect(evidence.runId).toBe("canonical-boundary-fixture");
    expect(evidence.rootCid).toBeNull();
  });

  it("retains unsupported current/open refusal before any model/query attempt", async () => {
    const response = await createChatAgent(context).run([
      { role: "user", content: "Which properties have open roofing permits?" },
      { role: "assistant", content: "How many years?" },
      { role: "user", content: "five years" },
    ]);
    expect(response.grounding?.mode).toBe("source-only-refusal");
    expect(response.citations).toEqual([]);
    expect(response.answer).toContain("historical permits are missing");
    expect(response.answer).toContain("Contractor view");
    expect(response.answer).toContain("not asserted to be currently open");
  });
});
