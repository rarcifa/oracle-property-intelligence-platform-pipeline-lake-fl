/** Synthetic-only real DuckDB compatibility and privacy tests. No network or private captures. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  LOCAL_EVIDENCE_CONTRACT_VERSION,
  LOCAL_EVIDENCE_PROPERTY_COLUMNS,
  LOCAL_EVIDENCE_PERMIT_COLUMNS,
  quote,
} from "@oracle-lake/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import { resolveDataSource, RuntimeDataset } from "../src/data/source.js";
import { callTool } from "../src/mcp/tools.js";

const TYPE_NAMES: Readonly<Record<string, string>> = {
  UTF8: "VARCHAR",
  DOUBLE: "DOUBLE",
  INT32: "INTEGER",
  BOOLEAN: "BOOLEAN",
};
const PRIVATE_SENTINEL = "synthetic-private-contact@example.invalid";
const PROPERTY_VALUES: Readonly<Record<string, string>> = {
  property_id: quote("synthetic-property"),
  request_identifier: quote("synthetic-parcel"),
  parcel_identifier: quote("synthetic-parcel"),
  latitude: "28.5",
  longitude: "-81.5",
  built_year: "2000",
  roof_age_years: "26",
  roof_age_basis: quote("built_year_proxy"),
  roof_age_confidence: quote("low"),
  built_year_evidence_state: quote("confirmed_present"),
  effective_built_year_evidence_state: quote("unknown"),
  roof_age_decision: quote("eligible_proxy"),
  roof_age_caveat: quote(
    "Partial history may omit later replacement. Built year is not measured roof age.",
  ),
  contractor_attribution_kind: quote(
    "source_display_name_only; not a verified legal company identity",
  ),
  evidence_contract_version: quote(LOCAL_EVIDENCE_CONTRACT_VERSION),
  has_permits: "TRUE",
  permit_count: "1",
  contractor_name: quote("Synthetic Roofing"),
  previous_unaccepted_roof_age_years: "5",
  source_export_open_permit_count: "1",
  enrichment_status: quote(
    "retained_source_observations;current_permit_status_not_revalidated;primary_roof_completion_needs_review;contractor_source_name_only;contractor_absence_not_proven;sunbiz_temporal_dbpr_required;bbb_policy_api_gated",
  ),
};
const PERMIT_VALUES: Readonly<Record<string, string>> = {
  permit_id: quote("synthetic-permit"),
  permit_number: quote("synthetic-number"),
  parcel_identifier: quote("synthetic-parcel"),
  applied_date: quote("2000-01-01"),
  permit_status: quote("INDEXED_HISTORICAL_STATUS"),
  source_system: quote("synthetic-official-source"),
  contractor_name: quote("Synthetic Roofing"),
  linkage_status: quote("linked_to_assessed_roll"),
  status_basis: quote("captured_observation_only; not live/current"),
  decisions_outcome: quote("needs_review"),
  evidence_contract_version: quote(LOCAL_EVIDENCE_CONTRACT_VERSION),
  source_observations_json: quote(
    JSON.stringify({ phone: "synthetic-private-phone", email: PRIVATE_SENTINEL }),
  ),
  source_export_days_open: "999",
  source_observed_is_open: "TRUE",
  directory_license_candidate: quote("synthetic-directory-candidate"),
  evidence_states_json: quote(
    JSON.stringify({ currentStatus: "unknown", completionDate: "unknown" }),
  ),
};

type FixtureOptions = {
  property?: Record<string, string>;
  permit?: Record<string, string>;
  extraPropertyColumn?: boolean;
  mixedPermitVersion?: boolean;
};

async function fixture(options: FixtureOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oracle-synthetic-preview-"));
  const propertyPath = join(dir, "properties.parquet");
  const permitPath = join(dir, "permits.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const projection = (
    columns: readonly { name: string; type: string }[],
    values: Record<string, string>,
  ): string =>
    columns
      .map(
        (column) =>
          `CAST(${values[column.name] ?? "NULL"} AS ${TYPE_NAMES[column.type] ?? column.type}) AS ${column.name}`,
      )
      .join(", ");
  try {
    const properties = projection(LOCAL_EVIDENCE_PROPERTY_COLUMNS, {
      ...PROPERTY_VALUES,
      ...options.property,
    });
    await connection.run(
      `COPY (SELECT ${properties}${options.extraPropertyColumn ? ", 'private' AS unexpected_raw_column" : ""}) TO ${quote(propertyPath)} (FORMAT PARQUET)`,
    );
    const permits = projection(LOCAL_EVIDENCE_PERMIT_COLUMNS, {
      ...PERMIT_VALUES,
      ...options.permit,
    });
    const second = options.mixedPermitVersion
      ? ` UNION ALL SELECT ${projection(LOCAL_EVIDENCE_PERMIT_COLUMNS, { ...PERMIT_VALUES, permit_id: quote("synthetic-permit-two"), evidence_contract_version: quote("unrecognised-contract") })}`
      : "";
    await connection.run(
      `COPY (SELECT ${permits}${second}) TO ${quote(permitPath)} (FORMAT PARQUET)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  const config = loadConfig({
    ORACLE_LOCAL_EVIDENCE_PREVIEW: "1",
    ORACLE_PARQUET_PATH: propertyPath,
    ORACLE_PERMIT_PARQUET_PATH: permitPath,
    ORACLE_DATA_RUN_ID: "synthetic-local-run",
    ORACLE_LOCAL_EVIDENCE_AS_OF_YEAR: "2026",
    OPENAI_API_KEY: "synthetic-unused-key",
  });
  const store = new OracleDataStore({
    source: propertyPath,
    permitSource: permitPath,
    localEvidencePreview: true,
    localEvidenceAsOfYear: 2026,
  });
  return {
    dir,
    propertyPath,
    permitPath,
    config,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("local preview configuration", () => {
  const valid = {
    ORACLE_LOCAL_EVIDENCE_PREVIEW: "1",
    ORACLE_PARQUET_PATH: "/synthetic/property.parquet",
    ORACLE_PERMIT_PARQUET_PATH: "/synthetic/permit.parquet",
    ORACLE_DATA_RUN_ID: "synthetic-local-run",
    ORACLE_LOCAL_EVIDENCE_AS_OF_YEAR: "2026",
  };
  it("requires an exact opt-in and preserves normal public configuration", () => {
    expect(
      loadConfig({ ORACLE_PARQUET_URL: "https://example.invalid/public.parquet" })
        .localEvidencePreview,
    ).toBeUndefined();
    expect(() => loadConfig({ ...valid, ORACLE_LOCAL_EVIDENCE_PREVIEW: "true" })).toThrow();
    expect(loadConfig(valid)).toMatchObject({
      host: "127.0.0.1",
      localEvidencePreview: true,
      dataRootCid: null,
      ipnsName: null,
      runDir: null,
      openaiApiKey: null,
      localEvidenceAsOfYear: 2026,
    });
  });
  it.each([
    { HOST: "0.0.0.0" },
    { HOST: "192.0.2.1" },
    { AWS_LAMBDA_FUNCTION_NAME: "synthetic-lambda" },
    { LAMBDA_TASK_ROOT: "/synthetic/lambda" },
    { ORACLE_PARQUET_URL: "https://example.invalid/public.parquet" },
    { ORACLE_IPNS_NAME: "synthetic-ipns" },
    { ORACLE_DATA_ROOT_CID: "synthetic-cid" },
    { ORACLE_PARQUET_PATH: "https://example.invalid/private.parquet" },
    { ORACLE_PERMIT_PARQUET_PATH: "ipfs://synthetic/private.parquet" },
    { ORACLE_PERMIT_PARQUET_PATH: "/synthetic/*.parquet" },
    { ORACLE_DATA_RUN_ID: "" },
    { ORACLE_LOCAL_EVIDENCE_AS_OF_YEAR: "" },
  ])("refuses unsafe or incomplete preview configuration %#", (override) => {
    expect(() => loadConfig({ ...valid, ...override })).toThrow();
  });
  it("refuses remote preview and bypassed source schema gates in the data layer itself", () => {
    expect(
      () =>
        new OracleDataStore({
          source: "https://example.invalid/p.parquet",
          permitSource: "/synthetic/permit.parquet",
          localEvidencePreview: true,
          localEvidenceAsOfYear: 2026,
        }),
    ).toThrow();
    expect(
      () =>
        new OracleDataStore({
          source: "/synthetic/p.parquet",
          permitSource: "/synthetic/permit.parquet",
          localEvidencePreview: true,
          localEvidenceAsOfYear: 2026,
          skipSchemaCheck: true,
        }),
    ).toThrow();
  });
});

describe("real DuckDB local preview", () => {
  it("gates synthetic source bytes, safely projects both grains and preserves them read-only", async () => {
    const f = await fixture();
    const before = [readFileSync(f.propertyPath), readFileSync(f.permitPath)];
    try {
      await f.store.init();
      const property = (await f.store.query("SELECT * FROM properties"))[0];
      const permit = (await f.store.query("SELECT * FROM permits"))[0];
      expect(property).toMatchObject({
        roof_age_years: 26,
        roof_age_basis: "built_year_proxy",
        roof_age_confidence: "low",
        open_permit_count: null,
        contractor_company_id: null,
        accepted_primary_roof_permit_count: null,
        property_cid: null,
      });
      expect(permit).toMatchObject({
        applied_date: "2000-01-01",
        is_open: null,
        is_roofing: null,
        completed_date: null,
        current_permit_status: null,
        contractor_license: null,
        contractor_company_id: null,
        decisions_outcome: "needs_review",
      });
      expect(JSON.stringify([property, permit])).not.toContain(PRIVATE_SENTINEL);
      expect(property).not.toHaveProperty("previous_unaccepted_roof_age_years");
      expect(permit).not.toHaveProperty("source_observations_json");
      expect(permit).not.toHaveProperty("directory_license_candidate");
      expect(permit).not.toHaveProperty("source_input_sha256");
      expect(permit).not.toHaveProperty("evidence_states_json");
      await expect(f.store.query("SELECT * FROM previous_properties")).rejects.toThrow();
      await expect(
        f.store.query(`SELECT * FROM read_parquet(${quote(f.permitPath)})`),
      ).rejects.toThrow();
      expect(readFileSync(f.propertyPath)).toEqual(before[0]);
      expect(readFileSync(f.permitPath)).toEqual(before[1]);
    } finally {
      f.cleanup();
    }
  });
  it.each([
    { property: { roof_age_years: "999" } },
    { property: { built_year: "2030", roof_age_years: "1" } },
    { property: { roof_age_confidence: quote("high") } },
    { property: { roof_age_basis: quote("roofing_permit_completed") } },
    { property: { property_cid: quote("synthetic-prior-cid") } },
    { property: { open_permit_count: "1" } },
    { property: { accepted_primary_roof_permit_count: "1" } },
    { permit: { current_permit_status: quote("OPEN") } },
    { permit: { is_open: "FALSE" } },
    { permit: { is_roofing: "TRUE" } },
    { permit: { completed_date: quote("2020-01-01") } },
    { permit: { contractor_company_id: quote("synthetic-company") } },
    { permit: { contractor_license: quote("synthetic-license") } },
    { permit: { accepted_roof_anchor_date: quote("2020-01-01") } },
    { permit: { decisions_outcome: quote("accepted") } },
    { permit: { observation_time: quote('"2026-01-01T00:00:00Z"') } },
    { extraPropertyColumn: true },
    { mixedPermitVersion: true },
  ] satisfies FixtureOptions[])(
    "rejects promotion, drift or incompatible proxy evidence %#",
    async (options) => {
      const f = await fixture(options);
      try {
        await expect(f.store.init()).rejects.toThrow(
          "Local evidence preview failed its read-only schema or eligibility checks",
        );
        expect(f.store.permitsAvailable).toBe(false);
      } finally {
        f.cleanup();
      }
    },
  );
  it("does not accept the conservative source through the unchanged default schema gate", async () => {
    const f = await fixture();
    const strict = new OracleDataStore({ source: f.propertyPath, permitSource: f.permitPath });
    try {
      await expect(strict.init()).rejects.toThrow(/expected 63/);
    } finally {
      strict.close();
      f.cleanup();
    }
  });
});

describe("preview REST/MCP contract", () => {
  it("keeps local identity, withheld decisions and unavailable public RAG explicit", async () => {
    const f = await fixture();
    try {
      await f.store.init();
      const context = createContext(f.config, f.store);
      expect(() => createContext({ ...f.config, host: "0.0.0.0" }, f.store)).toThrow();
      expect(() =>
        createContext({ ...f.config, openaiApiKey: "synthetic-key" }, f.store),
      ).toThrow();
      const router = createApp(context);
      const request = async (path: string, method = "GET", body?: unknown) => {
        const url = new URL(path, "http://synthetic.local");
        const response = await router.handle({
          method,
          path: url.pathname,
          query: url.searchParams,
          headers: {},
          body,
        });
        return {
          status: response.status,
          body: JSON.parse(String(response.body)) as Record<string, unknown>,
        };
      };
      const meta = await request("/api/meta/run");
      expect(meta.body).toMatchObject({
        localEvidencePreview: true,
        derivativeAsOfYear: 2026,
        sourceProfileAccepted: false,
        countyComplete: false,
        releaseReady: false,
        coverage: null,
        verification: null,
        runHistory: null,
        chatEnabled: false,
        dataSource: "local-unaccepted-evidence-preview",
        run: { runId: "synthetic-local-run", rootCid: null },
      });
      const stats = await request("/api/stats");
      expect(stats.body.stats).toMatchObject({
        properties: 1,
        permit_records: 1,
        permit_records_linked: 1,
        permit_records_valid_unlinked: 0,
        roof_age_15_plus: 1,
      });
      expect(stats.body.stats).not.toHaveProperty("with_open_roofing_permit");
      expect(stats.body.stats).not.toHaveProperty("roofing_permit_records");
      const property = await request("/api/properties/synthetic-parcel");
      const permits = await request("/api/properties/synthetic-parcel/permits");
      expect(permits.body.provenance).toMatchObject({
        dataSource: "local-unaccepted-permit-preview",
        rootCid: null,
      });
      for (const response of [meta, stats, property, permits]) {
        const text = JSON.stringify(response.body);
        expect(text).not.toContain(f.dir);
        expect(text).not.toContain(PRIVATE_SENTINEL);
        expect(text).not.toContain("source_observations_json");
      }
      for (const query of [
        "hasOpenRoofingPermit=true",
        "hasOpenRoofingPermit=false",
        "minOpenPermitDays=0",
        "minOpenRoofingPermitDays=1",
        "roofAgeBasis=roofing_permit_completed",
      ]) {
        const result = await request(`/api/properties?${query}`);
        expect(result.status).toBe(400);
        expect(JSON.stringify(result.body)).toContain("unknown evidence");
      }
      expect(
        (await request("/api/properties?roofAgeBasis=built_year_proxy&minRoofAge=15")).body.matched,
      ).toBe(1);
      expect((await request("/api/search")).status).toBe(503);
      expect(
        (
          await request("/api/search", "POST", {
            query: "Which verified contractors have current open permits?",
          })
        ).status,
      ).toBe(503);
      const schema = await callTool(context, "getPropertyQuerySchema", {});
      expect(schema.payload).toMatchObject({
        columnCount: 72,
        runId: "synthetic-local-run",
        rootCid: null,
      });
      const open = await callTool(context, "findOpenRoofPermits", {});
      expect(open.isError).toBe(true);
      const aged = await callTool(context, "findAgedRoofs", { minRoofAge: 15 });
      expect(aged.isError).not.toBe(true);
      expect(aged.payload).toMatchObject({
        matched: 1,
        rows: [{ roof_age_basis: "built_year_proxy", roof_age_confidence: "low" }],
        basisNote:
          "Low-confidence built-year proxy only, not measured roof age. Partial permit history may omit a later replacement; current status and permit-backed primary-roof completion remain unaccepted.",
      });
      expect(JSON.stringify(aged.payload)).not.toContain("when no roofing permit is published");
      const sql = await callTool(context, "queryProperties", {
        sql: "SELECT * FROM permits",
        limit: 1,
      });
      expect(sql.isError).not.toBe(true);
      expect(JSON.stringify(sql.payload)).not.toContain(PRIVATE_SENTINEL);
      expect(JSON.stringify(sql.payload)).not.toContain(f.dir);
    } finally {
      f.cleanup();
    }
  });
  it("opens preview bootstrap without resolving or refreshing IPNS", async () => {
    const f = await fixture();
    const resolve = vi.fn();
    try {
      expect(await resolveDataSource(f.config, resolve)).toMatchObject({
        source: f.propertyPath,
        pointer: null,
        stale: false,
      });
      const { dataset } = await RuntimeDataset.open(f.config, { resolve });
      expect(dataset.store.localEvidencePreview).toBe(true);
      expect(await dataset.refresh()).toEqual({ status: "skipped" });
      expect(resolve).not.toHaveBeenCalled();
      dataset.close();
    } finally {
      f.cleanup();
    }
  });
});
