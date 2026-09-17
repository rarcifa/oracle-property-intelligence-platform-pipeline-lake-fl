import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LEGACY_LAMBDA_COMMAND = "SET lambda_syntax = 'ENABLE_SINGLE_ARROW';";
const PREFIX = "lake-legacy-duckdb-test-";

/** Test-only CLI boundary for frozen SQL; executes the real binary without filtering output. */
export async function createLegacyDuckDbFixture(): Promise<string> {
  const executable = execFileSync("which", ["duckdb"], { encoding: "utf8" }).trim();
  if (!path.isAbsolute(executable) || executable.includes("\n"))
    throw new Error("Tests require one absolute real DuckDB CLI executable");
  const directory = await mkdtemp(path.join(os.tmpdir(), PREFIX));
  const quotedExecutable = `'${executable.replaceAll("'", "'\\''")}'`;
  try {
    await writeFile(
      path.join(directory, "duckdb"),
      `#!/bin/sh\nexec ${quotedExecutable} -cmd "${LEGACY_LAMBDA_COMMAND}" "$@"\n`,
      { mode: 0o700 },
    );
    return directory;
  } catch (error) {
    await removeLegacyDuckDbFixture(directory);
    throw error;
  }
}

export async function removeLegacyDuckDbFixture(directory: string): Promise<void> {
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith(PREFIX))
    throw new Error("Refusing to remove anything except an owned DuckDB test fixture");
  await rm(directory, { recursive: true, force: true });
}
