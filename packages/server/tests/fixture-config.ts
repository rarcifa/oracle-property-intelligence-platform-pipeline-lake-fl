/** Historical local decision regressions are frozen independently of live RAG.
 * They are not a publication or proof of current accepted source semantics. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, REPO_ROOT, type ServerConfig } from "../src/config.js";

export const ACCEPTED_REGRESSION_RUN_ID = "20260911T131000Z";
export const ACCEPTED_REGRESSION_ROOT_CID = null;
const acceptedRunDir = resolve(
  REPO_ROOT,
  "pipeline/data/artifacts/publish/lake/runs",
  ACCEPTED_REGRESSION_RUN_ID,
);
const acceptedParquet = resolve(acceptedRunDir, "query-table.parquet");

export function loadRegressionConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const runId = environment.ORACLE_DATA_RUN_ID?.trim();
  const rootCid = environment.ORACLE_DATA_ROOT_CID?.trim();
  if (rootCid && !runId) {
    throw new Error("Explicit regression publication identity requires both run ID and root CID");
  }
  if (runId === ACCEPTED_REGRESSION_RUN_ID && rootCid) {
    throw new Error("Historical local regression fixture cannot claim a public root CID");
  }
  const explicitSource =
    environment.ORACLE_PARQUET_URL?.trim() || environment.ORACLE_PARQUET_PATH?.trim();
  const explicitRunDir = environment.ORACLE_RUN_DIR?.trim();
  const frozenIdentity =
    (runId === ACCEPTED_REGRESSION_RUN_ID && !rootCid) ||
    (!runId && !rootCid && !explicitSource && !explicitRunDir);
  // Explicit alternate tables must not borrow metadata or CIDs from either
  // the frozen accepted snapshot or whichever RAG publication is current.
  const runDir =
    explicitRunDir ??
    (frozenIdentity
      ? acceptedRunDir
      : runId
        ? resolve(REPO_ROOT, "pipeline/data/artifacts/publish/lake/runs", runId)
        : resolve(REPO_ROOT, ".test-fixtures/unbound-regression-metadata"));
  const source = explicitSource ?? (frozenIdentity ? acceptedParquet : undefined);
  if (frozenIdentity && !existsSync(source ?? acceptedParquet)) {
    throw new Error(
      "Historical local regression fixture is absent; run node packages/server/tests/materialize-historical-fixture.ts",
    );
  }
  return loadConfig({
    ...environment,
    ORACLE_RUN_DIR: runDir,
    ORACLE_PARQUET_URL: source && /^https?:\/\//.test(source) ? source : undefined,
    ORACLE_PARQUET_PATH: source && !/^https?:\/\//.test(source) ? source : undefined,
    ORACLE_DATA_RUN_ID: runId || (frozenIdentity ? ACCEPTED_REGRESSION_RUN_ID : ""),
    ORACLE_DATA_ROOT_CID: rootCid || "",
    ORACLE_IPNS_NAME: "",
    OPENAI_API_KEY: "",
  });
}
