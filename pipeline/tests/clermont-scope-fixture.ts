import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLERMONT_CONFIGURATION_SCOPE_FILES,
  CLERMONT_SCHEMA_SCOPE_FILES,
  CLERMONT_SOURCE_SCOPE_FILES,
} from "../src/batch/clermont-run-contracts.js";

const PREFIX = "clermont-synthetic-scope-";
const SEED_PATH = "pipeline/data/seeds/lake.csv";
const SYNTHETIC_SEED = fileURLToPath(
  new URL("./fixtures/clermont-synthetic-seed.csv", import.meta.url),
);

/** Exact tracked code/configuration bytes, with a clearly synthetic test-only seed. */
export async function createClermontScopeFixture(sourceRepoRoot: string): Promise<string> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), PREFIX));
  try {
    const logicalPaths = new Set([
      ...CLERMONT_SOURCE_SCOPE_FILES,
      ...CLERMONT_CONFIGURATION_SCOPE_FILES,
      ...CLERMONT_SCHEMA_SCOPE_FILES,
    ]);
    for (const logicalPath of logicalPaths) {
      const destination = path.join(fixtureRoot, logicalPath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(
        logicalPath === SEED_PATH ? SYNTHETIC_SEED : path.join(sourceRepoRoot, logicalPath),
        destination,
      );
    }
    return fixtureRoot;
  } catch (error) {
    await removeClermontScopeFixture(fixtureRoot);
    throw error;
  }
}

export async function removeClermontScopeFixture(fixtureRoot: string): Promise<void> {
  if (path.dirname(fixtureRoot) !== os.tmpdir() || !path.basename(fixtureRoot).startsWith(PREFIX))
    throw new Error("Refusing to remove anything except an owned Clermont test fixture");
  await rm(fixtureRoot, { recursive: true, force: true });
}
