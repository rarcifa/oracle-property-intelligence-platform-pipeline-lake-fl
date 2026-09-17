/** Download the explicitly served snapshot for credential-free CI, never latest.json. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const bindingSchema = z.object({
  runId: z.string().regex(/^\d{8}T\d{6}Z$/),
  rootCid: z.string().regex(/^bafy[a-z2-7]+$/),
});
const artifactSchema = z.object({
  name: z.string(),
  cid: z.string().regex(/^ba[a-z2-7]+$/),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  codec: z.enum(["file", "directory"]),
});
const manifestSchema = z.object({
  runId: z.string(),
  root: z.object({ cid: z.string() }),
  artifacts: z.array(artifactSchema),
});
const FILES = [
  "query-table.parquet",
  "permit-table.parquet",
  "business-table.parquet",
  "coverage.json",
  "index.json",
  "schema.json",
  "permit-schema.json",
  "business-schema.json",
  "source-semantics.json",
] as const;
const REPO_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

export function assertSnapshotBytes(
  bytes: Uint8Array,
  expected: { size: number; sha256: string },
): void {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.byteLength !== expected.size || digest !== expected.sha256)
    throw new Error("Selected CI snapshot bytes differ from their immutable manifest");
}

export async function fetchCiSnapshot(output: string): Promise<void> {
  const recorded: unknown = JSON.parse(
    await readFile(resolve(REPO_ROOT, "artifacts/hosted-runtime-readback-20260917.json"), "utf8"),
  );
  const receipt = z.object({ metadata: z.object({ run: bindingSchema }) }).parse(recorded);
  const binding = receipt.metadata.run;
  const manifestBytes = await readFile(
    resolve(REPO_ROOT, "artifacts", `manifest-${binding.runId}.json`),
  );
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.runId !== binding.runId || manifest.root.cid !== binding.rootCid)
    throw new Error("Selected CI manifest does not describe the served run");
  await mkdir(output, { recursive: true });
  for (const name of FILES) {
    const matches = manifest.artifacts.filter((entry) => entry.name === name);
    const entry = matches[0];
    if (matches.length !== 1 || !entry || entry.codec !== "file")
      throw new Error(`Selected CI manifest must identify exactly one ${name}`);
    // Immediate diagnostic read only: bounded volume, timeout, no secret or side effect.
    let verified: Uint8Array | undefined;
    for (const gateway of ["https://ipfs.filebase.io", "https://gateway.pinata.cloud"]) {
      try {
        const response = await fetch(`${gateway}/ipfs/${entry.cid}`, {
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`Public snapshot fetch returned ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        assertSnapshotBytes(bytes, entry);
        verified = bytes;
        break;
      } catch {
        // Another independent public transport may serve the same immutable CID.
      }
    }
    if (!verified) throw new Error(`Neither public gateway returned verified ${name}`);
    await writeFile(resolve(output, name), verified);
  }
  await writeFile(
    resolve(output, "snapshot-receipt.json"),
    `${JSON.stringify({ ...binding, manifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`, files: FILES }, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ event: "selected_ci_snapshot_verified", ...binding })}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error("Usage: ci-snapshot.ts <output-directory>");
  await fetchCiSnapshot(resolve(output));
}
