import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../src/config.js";
import {
  ACCEPTED_REGRESSION_ROOT_CID,
  ACCEPTED_REGRESSION_RUN_ID,
  loadRegressionConfig,
} from "./fixture-config.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

afterEach(async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  vi.mocked(existsSync).mockReset().mockImplementation(actual.existsSync);
  const fs = await import("node:fs");
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(actual.readFileSync);
});

describe("explicit legacy regression fixture", () => {
  it("does not select a newer prepared source-only export or use a model key", () => {
    const config = loadRegressionConfig({ OPENAI_API_KEY: "never-use-this-test-key" });
    expect(config.runDir).toMatch(/runs\/20260911T131000Z$/);
    expect(config.dataRunId).toBe(ACCEPTED_REGRESSION_RUN_ID);
    expect(config.dataRootCid).toBe(ACCEPTED_REGRESSION_ROOT_CID);
    expect(config.openaiApiKey).toBeNull();
  });

  it("preserves an explicitly selected operator/CI dataset", () => {
    const config = loadRegressionConfig({
      ORACLE_RUN_DIR: "/operator/nonexistent-selected-run",
      ORACLE_PARQUET_URL: "https://example.test/ipfs/test/query-table.parquet",
    });
    expect(config.runDir).toBeNull();
    expect(config.parquetSource).toBe("https://example.test/ipfs/test/query-table.parquet");
    expect(config.dataRunId).toBeNull();
    expect(config.dataRootCid).toBeNull();
  });

  it("uses the same frozen metadata for CI's materialized historical local fixture", () => {
    const config = loadRegressionConfig({
      ORACLE_PARQUET_PATH: resolve(
        REPO_ROOT,
        "pipeline/data/artifacts/publish/lake/runs/20260911T131000Z/query-table.parquet",
      ),
      ORACLE_DATA_RUN_ID: ACCEPTED_REGRESSION_RUN_ID,
      ORACLE_DATA_ROOT_CID: "",
    });
    expect(config.runDir).toMatch(/runs\/20260911T131000Z$/);
    expect(config.parquetSource).toMatch(/runs\/20260911T131000Z\/query-table.parquet$/);
    expect(config.dataRunId).toBe(ACCEPTED_REGRESSION_RUN_ID);
    expect(config.dataRootCid).toBe(ACCEPTED_REGRESSION_ROOT_CID);
  });

  it("uses the explicit alternate run's metadata rather than the live or accepted selector", () => {
    const config = loadRegressionConfig({
      ORACLE_PARQUET_URL: "https://example.test/ipfs/alternate-cid/query-table.parquet",
      ORACLE_DATA_RUN_ID: "20260917T152549Z",
      ORACLE_DATA_ROOT_CID: "alternate-cid",
      ORACLE_RUN_DIR: "/operator/nonexistent-alternate-packet",
    });
    expect(config.runDir).toBeNull();
    expect(config.dataRunId).toBe("20260917T152549Z");
    expect(config.dataRootCid).toBe("alternate-cid");
    expect(config.ipnsName).toBeNull();
  });

  it("refuses a public root without its explicit run identity", () => {
    expect(() => loadRegressionConfig({ ORACLE_DATA_ROOT_CID: "alternate-cid" })).toThrow(
      /both run ID and root CID/,
    );
  });

  it("does not attach a fabricated publication CID to the historical local fixture", () => {
    expect(() =>
      loadRegressionConfig({
        ORACLE_DATA_RUN_ID: ACCEPTED_REGRESSION_RUN_ID,
        ORACLE_DATA_ROOT_CID: "wrong-root",
      }),
    ).toThrow(/cannot claim a public root CID/);
  });

  it("requires materialization rather than borrowing a public snapshot if historical bytes are absent", async () => {
    const actual = await vi.importActual<typeof NodeFs>("node:fs");
    vi.mocked(existsSync).mockImplementation((file) =>
      String(file) ===
      resolve(
        REPO_ROOT,
        "pipeline/data/artifacts/publish/lake/runs/20260911T131000Z/query-table.parquet",
      )
        ? false
        : actual.existsSync(file),
    );
    expect(() => loadRegressionConfig({})).toThrow(/materialize-historical-fixture/);
  });

  it.each(["local_candidate", "published"])(
    "does not read a mutable %s RAG selector to choose decision fixtures",
    async (releaseState) => {
      const fs = await import("node:fs");
      vi.mocked(fs.readFileSync).mockImplementation(() =>
        JSON.stringify({
          runId: "20260917T152549Z",
          releaseState,
          rootCid: "new-source-only-root",
        }),
      );
      const config = loadRegressionConfig({});
      expect(config.dataRunId).toBe(ACCEPTED_REGRESSION_RUN_ID);
      expect(config.dataRootCid).toBe(ACCEPTED_REGRESSION_ROOT_CID);
      expect(config.runDir).toMatch(/runs\/20260911T131000Z$/);
      expect(fs.readFileSync).not.toHaveBeenCalled();
    },
  );
});
