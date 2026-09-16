/** Synthetic-only all-account, unmatched visibility, privacy and legacy compatibility checks. */
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUSINESS_TABLE_COLUMNS,
  buildBusinessSearchSql,
  businessSearchSchema,
  quote,
  assertBusinessSchemaMatches,
} from "@oracle-lake/shared";
import { buildBusinessTable } from "../../../pipeline/scripts/lake/build-business-table.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import { searchBusinessAccounts } from "../src/data/queries.js";
import { createContext } from "../src/context.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { callTool } from "../src/mcp/tools.js";
import { bodyJson, request } from "./harness.js";

const provenance = {
  runId: "synthetic-business-run",
  rootCid: null,
  dataSource: "synthetic-only",
  dataSourceKind: "local" as const,
};
let directory = "";
let publicPath = "";
let propertyPath = "";
let store: OracleDataStore;
let receipt: Record<string, unknown>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "oracle-synthetic-business-"));
  const tpp = join(directory, "tpp.csv");
  const nal = join(directory, "nal.csv");
  await writeFile(
    tpp,
    "CO_NO,ACCT_ID,ASMNT_YR,OWN_NAM,NAICS_CD,PHY_ADDR,PHY_CITY,PHY_ZIPCD,OWN_ADDR,FIDU_NAME\n45,000A,2026,Synthetic Roofing,238160,10 Fixture Street,CLERMONT,34711,private-owner-contact,private-fiduciary\n45,000B,2026,Synthetic Unmatched,541000,99 No Match Street,TAVARES,32778,private-owner-contact,private-fiduciary\n45,000C,2026,Synthetic Without Address,541000,,,,private-owner-contact,private-fiduciary\n",
  );
  await writeFile(
    nal,
    "PARCEL_ID,PHY_ADDR1,PHY_ZIPCD\nfixture-A,10 Fixture Street,34711\nfixture-B,10 Fixture Street,34711\nfixture-C,Other Fixture Street,32778\n",
  );
  receipt = await buildBusinessTable({
    tppPath: tpp,
    nalPath: nal,
    output: join(directory, "candidate"),
    expectedAccounts: 3,
  });
  publicPath = join(directory, "candidate/business-table.parquet");
  propertyPath = join(directory, "properties.parquet");
  const db = await DuckDBInstance.create(":memory:");
  const connection = await db.connect();
  try {
    await connection.run(
      `COPY (SELECT 'fixture-property' AS property_id) TO ${quote(propertyPath)} (FORMAT PARQUET)`,
    );
  } finally {
    connection.closeSync();
    db.closeSync();
  }
  store = new OracleDataStore({
    source: propertyPath,
    permitSource: null,
    businessSource: publicPath,
    skipSchemaCheck: true,
  });
  await store.init();
});
afterAll(async () => {
  store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("all-source business accounts", () => {
  it("retains every stable official account, including unmatched and missing-situs accounts", async () => {
    const result = await searchBusinessAccounts(store, provenance, {});
    expect(result.matched).toBe(3);
    expect(result.rows.map((row) => row.business_id)).toEqual([
      "lake:fl_dor_tpp:000A",
      "lake:fl_dor_tpp:000B",
      "lake:fl_dor_tpp:000C",
    ]);
    expect(receipt.counts).toMatchObject({
      source_accounts: 3,
      matched_accounts: 1,
      valid_unmatched_accounts: 2,
      account_parcel_attributions: 2,
    });
  });
  it("returns actual unmatched account rows and honest candidate association grain", async () => {
    const unmatched = await searchBusinessAccounts(store, provenance, { linked: false });
    expect(unmatched.matched).toBe(2);
    expect(unmatched.rows.every((row) => row.matched_parcel_count === 0)).toBe(true);
    const matched = await searchBusinessAccounts(store, provenance, { linked: true });
    expect(matched.rows[0]?.matched_parcel_count).toBe(2);
    expect(JSON.parse(String(matched.rows[0]?.matched_parcel_ids))).toEqual([
      "fixture-A",
      "fixture-B",
    ]);
    expect(matched.note).toContain("not verified legal companies");
  });
  it("gates the actual public projection while preserving unmapped payload privately", async () => {
    const described = await store.query("DESCRIBE businesses");
    assertBusinessSchemaMatches(
      described.map((row) => ({
        column_name: String(row.column_name),
        column_type: String(row.column_type),
      })),
    );
    expect(described.map((row) => row.column_name)).toEqual(
      BUSINESS_TABLE_COLUMNS.map(([name]) => name),
    );
    const rows = JSON.stringify((await searchBusinessAccounts(store, provenance, {})).rows);
    expect(rows).not.toContain("private-owner-contact");
    expect(rows).not.toContain("private-fiduciary");
    expect(rows).not.toContain("source_payload");
    expect(
      await readFile(join(directory, "candidate/private-business-source-payload.jsonl"), "utf8"),
    ).toContain("private-fiduciary");
  });
  it("exposes the same rows through REST and MCP, with exact selected-run provenance", async () => {
    const context = createContext(
      loadConfig({
        ORACLE_PARQUET_PATH: propertyPath,
        ORACLE_DATA_RUN_ID: "synthetic-business-run",
        OPENAI_API_KEY: "",
      }),
      store,
    );
    const response = await request(
      createApp(context),
      "GET",
      "/api/businesses?linked=false&limit=1",
    );
    expect(response.status).toBe(200);
    const result = bodyJson<{
      matched: number;
      rows: unknown[];
      provenance: { rootCid: unknown; sourceSystems: string[] };
    }>(response);
    expect(result.matched).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.provenance.rootCid).toBeNull();
    expect(result.provenance.sourceSystems).toEqual(["fl_dor_tpp_2026p"]);
    const mcp = await callTool(context, "listOracleBusinessAccounts", { linked: false, limit: 1 });
    expect(mcp.isError).not.toBe(true);
    expect(mcp.payload).toMatchObject({ matched: 2, businessesAvailable: true });
  });
  it("does not transform legacy artifact absence into a zero-business assertion", async () => {
    const legacy = new OracleDataStore({
      source: propertyPath,
      permitSource: null,
      businessSource: null,
      skipSchemaCheck: true,
    });
    try {
      await legacy.init();
      expect(legacy.businessesAvailable).toBe(false);
      await expect(searchBusinessAccounts(legacy, provenance, {})).rejects.toThrow(
        "absence is not established",
      );
      const context = createContext(loadConfig({ ORACLE_PARQUET_PATH: propertyPath }), legacy);
      expect((await request(createApp(context), "GET", "/api/businesses")).status).toBe(409);
      expect((await callTool(context, "listOracleBusinessAccounts", {})).isError).toBe(true);
    } finally {
      legacy.close();
    }
  });
  it("rejects unknown options and escapes free text without introducing SQL", () => {
    expect(businessSearchSchema.strict().safeParse({ unimplemented: true }).success).toBe(false);
    expect(buildBusinessSearchSql({ q: "O'Company" })).toContain("O''Company");
  });
  it("refuses to overwrite a completed business candidate", async () => {
    await expect(
      buildBusinessTable({
        tppPath: join(directory, "tpp.csv"),
        nalPath: join(directory, "nal.csv"),
        output: join(directory, "candidate"),
        expectedAccounts: 3,
      }),
    ).rejects.toThrow();
  });
});
