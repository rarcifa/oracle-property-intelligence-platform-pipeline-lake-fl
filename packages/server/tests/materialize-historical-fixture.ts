/** Lossless test-only materialization. No network, CID, publication or readiness writes. */
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

export const HISTORICAL_RUN_ID = "20260911T131000Z";
const RUN_DIRECTORY = `pipeline/data/artifacts/publish/lake/runs/${HISTORICAL_RUN_ID}`;
const FIXTURE_DIRECTORY = `packages/server/tests/fixtures/historical-${HISTORICAL_RUN_ID}`;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const integrity = { size: z.number().int().positive(), sha256: digestSchema };
export const historicalFixtureManifestSchema = z
  .object({
    schemaVersion: z.literal("oracle.historical-regression-fixture.v1"),
    runId: z.literal(HISTORICAL_RUN_ID),
    rootCid: z.null(),
    releaseState: z.literal("historical-local-test-fixture"),
    testOnly: z.literal(true),
    purpose: z.string().min(1),
    runDirectory: z.literal(RUN_DIRECTORY),
    artifacts: z
      .array(
        z
          .object({
            name: z.enum(["query-table.parquet", "permit-table.parquet"]),
            fixtureFile: z.enum(["query-table.parquet.bin", "permit-table.parquet.bin"]),
            ...integrity,
          })
          .strict(),
      )
      .length(2),
    metadata: z
      .array(
        z
          .object({
            name: z.enum(["coverage.json", "index.json", "schema.json", "permit-schema.json"]),
            ...integrity,
          })
          .strict(),
      )
      .length(4),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      new Set(manifest.artifacts.map((entry) => entry.name)).size !== 2 ||
      new Set(manifest.metadata.map((entry) => entry.name)).size !== 4 ||
      manifest.artifacts.some((entry) => entry.fixtureFile !== `${entry.name}.bin`)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Historical fixture must bind both exact tables and all four original metadata files",
      });
    }
  });

function verify(bytes: Buffer, expected: { size: number; sha256: string }, name: string): void {
  if (
    bytes.length !== expected.size ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  )
    throw new Error(`Historical fixture integrity mismatch: ${name}`);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function materializeHistoricalFixture(
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
) {
  const fixtureDir = path.join(repoRoot, FIXTURE_DIRECTORY);
  const manifest = historicalFixtureManifestSchema.parse(
    JSON.parse(await readFile(path.join(fixtureDir, "manifest.json"), "utf8")),
  );
  const runDir = path.join(repoRoot, manifest.runDirectory);
  // Metadata is already tracked and must remain byte-for-byte unchanged. It
  // cannot be borrowed from the newest run or manufactured by this helper.
  for (const entry of manifest.metadata)
    verify(await readFile(path.join(runDir, entry.name)), entry, entry.name);
  const writes: { destination: string; bytes: Buffer }[] = [];
  for (const entry of manifest.artifacts) {
    const bytes = await readFile(path.join(fixtureDir, entry.fixtureFile));
    verify(bytes, entry, entry.fixtureFile);
    const destination = path.join(runDir, entry.name);
    try {
      const current = await readFile(destination);
      verify(current, entry, entry.name);
    } catch (error) {
      if (!missing(error)) throw error;
      writes.push({ destination, bytes });
    }
  }
  // No write until every input, existing output and original metadata passes.
  for (const { destination, bytes } of writes) {
    const temporary = `${destination}.${process.pid}.fixture.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  }
  return {
    runId: manifest.runId,
    rootCid: manifest.rootCid,
    testOnly: true,
    queryPath: path.join(runDir, "query-table.parquet"),
    permitPath: path.join(runDir, "permit-table.parquet"),
    runDir,
    materializedFiles: writes.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2)
    throw new Error("Historical fixture materializer accepts no publication or override flags");
  materializeHistoricalFixture()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "Historical fixture materialization failed",
      );
      process.exitCode = 1;
    });
}
