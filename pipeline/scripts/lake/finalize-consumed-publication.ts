/** Bounded local recovery; the sole provider operation is a read-only IPNS GET. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { finalizeConsumedPublication } from "../../src/core/finalize-consumed-publication.ts";
import { loadEnvFile, fillDerivedFilebaseToken } from "../../src/core/filebase.mjs";
import { readCurrentRowHashes, readIpnsPointer } from "./publish-run.mjs";

const FLAGS = new Set([
  "attempt-id",
  "approval",
  "expected-candidate-commit",
  "approval-public-key",
  "env-file",
]);

export function parseLocalFinalizationArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag?.startsWith("--") ||
      !FLAGS.has(flag.slice(2)) ||
      !value ||
      value.startsWith("--") ||
      result[flag.slice(2)] !== undefined
    )
      throw new Error("Only explicit local-finalization flags and values are allowed");
    result[flag.slice(2)] = value;
  }
  for (const required of ["attempt-id", "approval", "expected-candidate-commit"]) {
    if (!result[required]) throw new Error(`Missing --${required}`);
  }
  return result;
}

export async function runLocalFinalization(args: string[]) {
  const flags = parseLocalFinalizationArgs(args);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const authorization: unknown = JSON.parse(await readFile(flags.approval!, "utf8"));
  const publicKeyPem = flags["approval-public-key"]
    ? await readFile(flags["approval-public-key"])
    : null;
  const environment = { ...process.env };
  await loadEnvFile(flags["env-file"] ?? path.join(repoRoot, ".env"), environment);
  fillDerivedFilebaseToken(environment);
  const result = await finalizeConsumedPublication({
    repoRoot,
    authorization,
    publicKeyPem,
    attemptId: flags["attempt-id"]!,
    expectedCandidateCommit: flags["expected-candidate-commit"]!,
    readPointer: () => {
      if (!environment.FILEBASE_API_TOKEN?.trim())
        throw new Error("A read-only Filebase names token is required");
      return readIpnsPointer(environment.FILEBASE_API_TOKEN);
    },
    readHashes: readCurrentRowHashes,
  });
  return {
    attemptId: result.attempt.attemptId,
    state: result.attempt.state,
    repaired: result.repaired,
    runId: result.runRecord.runId,
    rootCid: result.runRecord.rootCid,
    executionCandidateCommit: result.runRecord.candidateCommit,
    effects: "local-history-cache-latest-only",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalFinalization(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Local finalization failed");
      process.exitCode = 1;
    });
}
