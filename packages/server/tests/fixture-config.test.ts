import { describe, expect, it } from "vitest";
import { loadRegressionConfig } from "./fixture-config.js";

describe("explicit legacy regression fixture", () => {
  it("does not select a newer prepared source-only export or use a model key", () => {
    const config = loadRegressionConfig({ OPENAI_API_KEY: "never-use-this-test-key" });
    expect(config.runDir).toMatch(/runs\/20260911T131000Z$/);
    expect(config.openaiApiKey).toBeNull();
  });

  it("preserves an explicitly selected operator/CI dataset", () => {
    const config = loadRegressionConfig({
      ORACLE_RUN_DIR: "/operator/nonexistent-selected-run",
      ORACLE_PARQUET_URL: "https://example.test/ipfs/test/query-table.parquet",
    });
    expect(config.runDir).toBeNull();
    expect(config.parquetSource).toBe("https://example.test/ipfs/test/query-table.parquet");
  });
});
