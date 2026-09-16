/** Legacy decision regressions use an explicit corpus-bound run, not the newest
 * local directory. Source-only behavior has its own isolated fixture suite. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, REPO_ROOT, type ServerConfig } from "../src/config.js";

export function loadRegressionConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const receipt: unknown = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "packages/rag/corpus-source.json"), "utf8"),
  );
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    !("runId" in receipt) ||
    typeof receipt.runId !== "string" ||
    !/^\d{8}T\d{6}Z$/.test(receipt.runId)
  )
    throw new Error("Regression fixture requires the committed corpus run identity");
  return loadConfig({
    ...environment,
    ORACLE_RUN_DIR:
      environment.ORACLE_RUN_DIR ??
      resolve(REPO_ROOT, "pipeline/data/artifacts/publish/lake/runs", receipt.runId),
    OPENAI_API_KEY: "",
  });
}
