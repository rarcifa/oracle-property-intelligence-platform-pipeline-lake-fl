import { describe, expect, it } from "vitest";
import { assertRuntimeBundleIdentity, pinnedRuntimeSelection } from "./runtime-selection.js";

const env = {
  ORACLE_DATA_RUN_ID: "20260916T181000Z",
  ORACLE_DATA_ROOT_CID: "bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u",
  ORACLE_PARQUET_URL:
    "https://ipfs.filebase.io/ipfs/bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u/query-table.parquet",
};

describe("explicit public runtime snapshot", () => {
  it("leaves the ordinary IPNS-following deployment unchanged", () => {
    expect(pinnedRuntimeSelection({})).toBeNull();
    expect(pinnedRuntimeSelection({ ORACLE_PARQUET_URL: env.ORACLE_PARQUET_URL })).toBeNull();
  });
  it("binds an explicit preview to its exact public CID and run", () => {
    expect(pinnedRuntimeSelection(env)).toEqual({
      runId: env.ORACLE_DATA_RUN_ID,
      rootCid: env.ORACLE_DATA_ROOT_CID,
      parquetUrl: env.ORACLE_PARQUET_URL,
    });
  });
  it.each([
    { ORACLE_DATA_RUN_ID: undefined },
    { ORACLE_DATA_ROOT_CID: undefined },
    { ORACLE_DATA_ROOT_CID: "Qm-not-cidv1" },
    { ORACLE_PARQUET_URL: undefined },
    { ORACLE_PARQUET_URL: env.ORACLE_PARQUET_URL.replace("https:", "http:") },
    { ORACLE_PARQUET_URL: `${env.ORACLE_PARQUET_URL}?token=private` },
    { ORACLE_PARQUET_URL: env.ORACLE_PARQUET_URL.replace("/query-table", "/other") },
    { ORACLE_PARQUET_URL: env.ORACLE_PARQUET_URL.replace("https://", "https://user:secret@") },
  ])("rejects incomplete or mismatched selection %j", (change) => {
    expect(() => pinnedRuntimeSelection({ ...env, ...change })).toThrow();
  });
  it("requires all bundled evidence to match without fabricating latest/history", () => {
    const selected = pinnedRuntimeSelection(env)!;
    const coverage = { runId: selected.runId };
    const manifest = { runId: selected.runId, root: { cid: selected.rootCid } };
    expect(() => assertRuntimeBundleIdentity(selected, coverage, coverage, manifest)).not.toThrow();
    expect(() =>
      assertRuntimeBundleIdentity(selected, { runId: "old" }, coverage, manifest),
    ).toThrow();
    expect(() =>
      assertRuntimeBundleIdentity(selected, coverage, { runId: "old" }, manifest),
    ).toThrow();
    expect(() =>
      assertRuntimeBundleIdentity(selected, coverage, coverage, {
        ...manifest,
        root: { cid: "old" },
      }),
    ).toThrow();
  });
});
