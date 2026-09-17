import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  historicalFixtureManifestSchema,
  HISTORICAL_RUN_ID,
  materializeHistoricalFixture,
} from "./materialize-historical-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const integrity = (bytes: Buffer) => ({
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

async function syntheticInputs() {
  const root = await mkdtemp(path.join(tmpdir(), "oracle-historical-fixture-test-"));
  directories.push(root);
  const fixtureDir = path.join(
    root,
    `packages/server/tests/fixtures/historical-${HISTORICAL_RUN_ID}`,
  );
  const runDirectory = `pipeline/data/artifacts/publish/lake/runs/${HISTORICAL_RUN_ID}`;
  const runDir = path.join(root, runDirectory);
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const artifacts = [];
  for (const name of ["query-table.parquet", "permit-table.parquet"]) {
    const bytes = Buffer.from(`SYNTHETIC_UNIT_TEST_BYTES:${name}`);
    await writeFile(path.join(fixtureDir, `${name}.bin`), bytes);
    artifacts.push({ name, fixtureFile: `${name}.bin`, ...integrity(bytes) });
  }
  const metadata = [];
  for (const name of ["coverage.json", "index.json", "schema.json", "permit-schema.json"]) {
    const bytes = Buffer.from(JSON.stringify({ synthetic: true, name }));
    await writeFile(path.join(runDir, name), bytes);
    metadata.push({ name, ...integrity(bytes) });
  }
  const manifest = {
    schemaVersion: "oracle.historical-regression-fixture.v1",
    runId: HISTORICAL_RUN_ID,
    rootCid: null,
    releaseState: "historical-local-test-fixture",
    testOnly: true,
    purpose: "Synthetic unit-test bytes; not dataset evidence",
    runDirectory,
    artifacts,
    metadata,
  };
  const manifestPath = path.join(fixtureDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, fixtureDir, runDir, manifest, manifestPath };
}

describe("historical local fixture materializer", () => {
  it("losslessly materializes both tables, retains original metadata, and is idempotent", async () => {
    const f = await syntheticInputs();
    const metadata = await readFile(path.join(f.runDir, "coverage.json"));
    const result = await materializeHistoricalFixture(f.root);
    expect(result).toMatchObject({
      runId: HISTORICAL_RUN_ID,
      rootCid: null,
      testOnly: true,
      materializedFiles: 2,
    });
    for (const entry of f.manifest.artifacts)
      expect(await readFile(path.join(f.runDir, entry.name))).toEqual(
        await readFile(path.join(f.fixtureDir, entry.fixtureFile)),
      );
    expect(await readFile(path.join(f.runDir, "coverage.json"))).toEqual(metadata);
    expect((await materializeHistoricalFixture(f.root)).materializedFiles).toBe(0);
  });

  it.each(["input", "metadata", "existing-output", "public-cid", "duplicate-table", "path-escape"])(
    "refuses %s before any table materialization",
    async (failure) => {
      const f = await syntheticInputs();
      if (failure === "input")
        await writeFile(path.join(f.fixtureDir, "permit-table.parquet.bin"), "changed");
      if (failure === "metadata") await writeFile(path.join(f.runDir, "coverage.json"), "changed");
      if (failure === "existing-output")
        await writeFile(path.join(f.runDir, "permit-table.parquet"), "conflicting immutable bytes");
      if (failure === "public-cid")
        await writeFile(
          f.manifestPath,
          JSON.stringify({ ...f.manifest, rootCid: "fake-public-cid" }),
        );
      if (failure === "duplicate-table")
        await writeFile(
          f.manifestPath,
          JSON.stringify({
            ...f.manifest,
            artifacts: [f.manifest.artifacts[0], f.manifest.artifacts[0]],
          }),
        );
      if (failure === "path-escape")
        await writeFile(
          f.manifestPath,
          JSON.stringify({ ...f.manifest, runDirectory: "../../outside" }),
        );
      await expect(materializeHistoricalFixture(f.root)).rejects.toThrow();
      await expect(readFile(path.join(f.runDir, "query-table.parquet"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects publication flags in the manifest rather than promoting historical observations", async () => {
    const f = await syntheticInputs();
    expect(() => historicalFixtureManifestSchema.parse({ ...f.manifest, promote: true })).toThrow();
  });
});
