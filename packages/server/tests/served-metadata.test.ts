/** Bundle metadata must describe the explicit bytes, not a previous release. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import type { OracleDataStore } from "../src/data/duckdb.js";
import { readServedMetadata } from "../src/data/run.js";
import { callTool } from "../src/mcp/tools.js";

const OLD = "bafybeif5vpiyp2v5foc7k3swsgoujzlvo7exaspntdsrmc4tp5vkuok67q";
const NEW = "bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u";
const RUN = "20260916T181000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(
  options: { latestRoot?: string; coverageRun?: string; runId?: string } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "oracle-served-metadata-"));
  directories.push(dir);
  const source = `https://ipfs.filebase.io/ipfs/${NEW}/query-table.parquet`;
  const latestPath = join(dir, "latest.json");
  const latest = {
    runId: RUN,
    rootCid: options.latestRoot ?? OLD,
    manifestCid: "old-manifest-cid",
    archiveCid: "old-archive-cid",
    resolvedCid: options.latestRoot ?? OLD,
  };
  const coverage = {
    runId: options.coverageRun ?? "20260910T225242Z",
    tables: { properties: { rows: 1, source: "synthetic-property-source" } },
    limitations: ["Synthetic coverage caveat"],
  };
  await Promise.all([
    writeFile(latestPath, JSON.stringify(latest)),
    writeFile(join(dir, "coverage.json"), JSON.stringify(coverage)),
    writeFile(
      join(dir, `verification-${RUN}.json`),
      JSON.stringify({ runId: RUN, rootCid: options.latestRoot ?? OLD, verifications: [] }),
    ),
  ]);
  const config = loadConfig({
    ORACLE_RUN_DIR: dir,
    ORACLE_PARQUET_URL: source,
    ORACLE_LATEST_PATH: latestPath,
    ORACLE_DATA_RUN_ID: options.runId ?? RUN,
    ORACLE_DATA_ROOT_CID: NEW,
  });
  const store = {
    source,
    activeSource: source,
    sourceKind: "ipfs",
    sourceObservationsOnly: true,
    queryOne: vi.fn(async () => ({ properties: 1, permit_records: 0 })),
    query: vi.fn(async () => []),
  } as unknown as OracleDataStore;
  const context = createContext(config, store);
  return { config, context, latest, store };
}

describe("served run metadata", () => {
  it("does not reuse an older manifest or verification with a matching run ID", async () => {
    const { config } = await fixture({ coverageRun: RUN });
    const metadata = await readServedMetadata(config, { runId: RUN, rootCid: NEW });
    expect(metadata.latest).toBeNull();
    expect(metadata.verification).toBeNull();
    expect(metadata.coverage?.runId).toBe(RUN);
  });

  it("accepts bundle metadata only when both served run and root match", async () => {
    const { config, latest } = await fixture({ latestRoot: NEW, coverageRun: RUN });
    expect(await readServedMetadata(config, { runId: RUN, rootCid: NEW })).toMatchObject({
      latest,
      coverage: { runId: RUN },
      verification: { runId: RUN, rootCid: NEW },
    });
    expect(await readServedMetadata(config, { runId: "other-run", rootCid: NEW })).toEqual({
      latest: null,
      coverage: null,
      verification: null,
    });
  });

  it("keeps local or unidentified bytes free of unrelated public proof", async () => {
    const { config } = await fixture({ latestRoot: NEW, coverageRun: RUN });
    expect(await readServedMetadata(config, { runId: RUN, rootCid: null })).toMatchObject({
      latest: null,
      verification: null,
    });
    expect(await readServedMetadata(config, { runId: null, rootCid: NEW })).toEqual({
      latest: null,
      coverage: null,
      verification: null,
    });
  });

  it("serves the same explicit partial identity through REST and MCP", async () => {
    const { context } = await fixture();
    const response = await createApp(context).handle({
      method: "GET",
      path: "/api/meta/run",
      query: new URLSearchParams(),
      headers: {},
    });
    const rest = JSON.parse(String(response.body));
    const mcp = (await callTool(context, "getOracleDatasetInfo", {})).payload;
    expect(rest.run).toEqual({ runId: RUN, rootCid: NEW });
    expect(rest.coverage).toBeNull();
    expect(rest.verification).toBeNull();
    expect(rest).toMatchObject({
      sourceObservationsOnly: true,
      countyComplete: false,
      currentPermitStatusAccepted: false,
    });
    expect(mcp).toMatchObject({
      run: rest.run,
      runId: RUN,
      sourceObservationsOnly: true,
      countyComplete: false,
      currentPermitStatusAccepted: false,
      coverageTables: null,
      provenance: { runId: RUN, rootCid: NEW, sourceObservationsOnly: true },
    });
  });

  it("does not borrow a run ID from latest for a different explicit public root", async () => {
    const { config, store } = await fixture();
    const context = createContext({ ...config, dataRunId: null, dataRootCid: null }, store);
    expect(await context.provenance()).toMatchObject({ runId: null, rootCid: NEW });
  });

  it("can identify explicit public bytes from a matching bundled root", async () => {
    const { config, store } = await fixture({ latestRoot: NEW });
    const context = createContext({ ...config, dataRunId: null, dataRootCid: null }, store);
    expect(await context.provenance()).toMatchObject({ runId: RUN, rootCid: NEW });
  });

  it("does not let an initially empty IPNS configuration donate old local coverage", async () => {
    const { config, store } = await fixture();
    const context = createContext(
      { ...config, parquetSource: "", parquetSourceKind: "local", dataRunId: null },
      store,
    );
    expect(await context.provenance()).toMatchObject({ runId: null, rootCid: NEW });
  });

  it("keeps the MCP publication object null for local unpublished bytes", async () => {
    const { config, store } = await fixture();
    const localStore = {
      ...store,
      source: "/synthetic/query-table.parquet",
      activeSource: "/synthetic/query-table.parquet",
      sourceKind: "local",
    } as unknown as OracleDataStore;
    const context = createContext(
      { ...config, parquetSourceKind: "local", dataRootCid: null },
      localStore,
    );
    const result = await callTool(context, "getOracleDatasetInfo", {});
    expect(result.payload).toMatchObject({
      run: null,
      runId: RUN,
      provenance: { runId: RUN, rootCid: null, dataSourceKind: "local" },
    });
  });
});
