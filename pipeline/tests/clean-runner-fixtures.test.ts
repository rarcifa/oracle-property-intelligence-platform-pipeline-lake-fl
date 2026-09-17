import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CLERMONT_CONFIGURATION_SCOPE_FILES,
  CLERMONT_SCHEMA_SCOPE_FILES,
  CLERMONT_SOURCE_SCOPE_FILES,
} from "../src/batch/clermont-run-contracts.js";
import {
  createClermontScopeFixture,
  removeClermontScopeFixture,
} from "./clermont-scope-fixture.js";
import {
  createLegacyDuckDbFixture,
  removeLegacyDuckDbFixture,
} from "./duckdb-legacy-json-fixture.js";

describe("clean-runner test fixture boundaries", () => {
  it("prepares exact tracked scopes without reading an ignored production seed", async () => {
    const trackedOnlyRoot = await mkdtemp(path.join(os.tmpdir(), "clermont-tracked-only-"));
    let fixtureRoot: string | undefined;
    try {
      const paths = new Set([
        ...CLERMONT_SOURCE_SCOPE_FILES,
        ...CLERMONT_CONFIGURATION_SCOPE_FILES,
        ...CLERMONT_SCHEMA_SCOPE_FILES,
      ]);
      for (const logicalPath of paths) {
        if (logicalPath === "pipeline/data/seeds/lake.csv") continue;
        const destination = path.join(trackedOnlyRoot, logicalPath);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(process.cwd(), "..", logicalPath), destination);
      }
      await expect(
        stat(path.join(trackedOnlyRoot, "pipeline/data/seeds/lake.csv")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      fixtureRoot = await createClermontScopeFixture(trackedOnlyRoot);
      const syntheticSeed = await readFile(
        fileURLToPath(new URL("./fixtures/clermont-synthetic-seed.csv", import.meta.url)),
      );
      expect(await readFile(path.join(fixtureRoot, "pipeline/data/seeds/lake.csv"))).toEqual(
        syntheticSeed,
      );
      for (const logicalPath of paths) {
        if (logicalPath === "pipeline/data/seeds/lake.csv") continue;
        expect(await readFile(path.join(fixtureRoot, logicalPath))).toEqual(
          await readFile(path.join(trackedOnlyRoot, logicalPath)),
        );
      }
      await expect(
        stat(path.join(trackedOnlyRoot, "pipeline/data/seeds/lake.csv")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (fixtureRoot) await removeClermontScopeFixture(fixtureRoot);
      await rm(trackedOnlyRoot, { recursive: true, force: true });
    }
  });

  it("keeps real legacy-lambda results strict JSON and propagates SQL errors", async () => {
    const directory = await createLegacyDuckDbFixture();
    try {
      const executable = path.join(directory, "duckdb");
      const stdout = execFileSync(
        executable,
        ["-json", "-c", "SELECT len(list_filter(['A', ''], x -> trim(x) <> '')) AS owner_count;"],
        { encoding: "utf8" },
      );
      expect(JSON.parse(stdout)).toEqual([{ owner_count: 1 }]);
      expect(stdout.trim().startsWith("[")).toBe(true);
      expect(() =>
        execFileSync(executable, ["-json", "-c", "SELECT CAST(2147483648 AS INTEGER);"], {
          stdio: "pipe",
        }),
      ).toThrow();
      expect(() =>
        execFileSync(executable, ["-json", "-c", "SELECT FROM;"], { stdio: "pipe" }),
      ).toThrow();
    } finally {
      await removeLegacyDuckDbFixture(directory);
    }
  });
});
