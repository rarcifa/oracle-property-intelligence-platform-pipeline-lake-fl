/**
 * Per-run artifact manifest for an immutable IPFS publication.
 *
 * A run publishes a directory of objects and then has to prove, later and to
 * somebody who was not there, exactly what it published. The manifest is that
 * record: for every object it pins the CIDv1, the logical name inside the
 * snapshot, the byte length, whether the CID addresses a file or a directory,
 * and the sha2-256 of those bytes. Size and digest are what make the CID
 * checkable — a gateway can return any bytes it likes, and only the recorded
 * digest catches it. The manifest also names the CAR file for the root, so the
 * whole snapshot can be re-imported rather than re-crawled.
 *
 * `size` and `sha256` describe the bytes stored under the entry's CID, and what
 * those bytes are depends on the codec. For a `file` they are the file's own
 * content, which is what a gateway returns for the CID. A `directory` has no
 * content beyond the dag-pb node listing its children, so its entry describes
 * that node: fetch the block itself (`?format=raw`) to check it, not the
 * gateway's HTML rendering of the listing. This used to record
 * `sha256(cid_string)` for directories — a digest of the identifier rather than
 * of anything the identifier addresses, which verified nothing at all.
 *
 * Nothing here records which providers served an object. The manifest is built
 * and hashed before a single byte is uploaded, so at that moment no provider
 * has been observed and any such field could only be empty. What actually
 * served the bytes back is measured after publication and recorded in
 * `artifacts/verification-<run>.json`.
 *
 * @module core/artifact-manifest
 */

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { isCidV1Base32 } from "./cid.mjs";

/** Schema version stamped into every manifest this runtime writes. */
export const ARTIFACT_MANIFEST_SCHEMA_VERSION = "elephant.artifact-manifest.v1";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COUNTY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const cidSchema = z
  .string()
  .refine(isCidV1Base32, "must be a CIDv1 base32 string");
const isoTimestamp = z
  .string()
  .regex(ISO_TIMESTAMP_PATTERN, "must be an ISO-8601 UTC timestamp");

/** One published object: its CID, its logical name, and its integrity facts. */
export const artifactEntrySchema = z
  .object({
    cid: cidSchema,
    name: z.string().trim().min(1),
    size: z.number().int().nonnegative(),
    codec: z.enum(["file", "directory"]),
    sha256: z
      .string()
      .regex(SHA256_PATTERN, "must be a lowercase sha256:<64-hex> digest"),
    // Legacy only, and never written by this runtime. Manifests published
    // before the field was retired carry it, and they must stay validatable —
    // being able to re-check an old publication is the point of the document.
    origins: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

/** The manifest as written to disk and published beside the snapshot. */
export const artifactManifestSchema = z
  .object({
    schemaVersion: z.literal(ARTIFACT_MANIFEST_SCHEMA_VERSION),
    runId: z.string().regex(RUN_ID_PATTERN, "must be a stable run identifier"),
    county: z
      .string()
      .regex(COUNTY_KEY_PATTERN, "must be normalized lowercase kebab-case"),
    generatedAt: isoTimestamp,
    root: z
      .object({
        cid: cidSchema,
        // `car` only. The build machine's path to the CAR was published here
        // too, which leaked a local filesystem layout into an immutable public
        // artifact and resolved for nobody but the machine that wrote it. The
        // pipeline keeps that path in local run state instead.
        car: z.string().trim().min(1),
      })
      .strict(),
    artifacts: z.array(artifactEntrySchema).min(1),
  })
  .strict();

/**
 * Render Zod issues as one readable, actionable error message.
 *
 * @param {import("zod").ZodError} error validation error
 * @returns {string}
 */
function describeIssues(error) {
  return error.issues
    .map((issue) => {
      const location =
        issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Validate an artifact manifest, throwing a single clear error on any
 * violation. Nothing is published from an unvalidated manifest.
 *
 * @param {unknown} value candidate manifest
 * @returns {import("zod").infer<typeof artifactManifestSchema>} the validated manifest
 */
export function validateArtifactManifest(value) {
  const result = artifactManifestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid artifact manifest: ${describeIssues(result.error)}`,
    );
  }
  const names = new Set();
  for (const artifact of result.data.artifacts) {
    if (names.has(artifact.name)) {
      throw new Error(
        `Invalid artifact manifest: duplicate artifact name '${artifact.name}'`,
      );
    }
    names.add(artifact.name);
  }
  if (
    !result.data.artifacts.some(
      (artifact) => artifact.cid === result.data.root.cid,
    )
  ) {
    throw new Error(
      "Invalid artifact manifest: root cid is not listed in artifacts",
    );
  }
  return result.data;
}

/**
 * Build a validated artifact manifest for one run.
 *
 * Entries are sorted by name so two runs over the same content produce the
 * same document.
 *
 * @param {{
 *   runId: string,
 *   county: string,
 *   generatedAt: string,
 *   rootCid: string,
 *   rootCarPath: string,
 *   entries: Array<{ cid: string, name: string, size: number, codec: "file" | "directory", sha256: string }>
 * }} options run identity, snapshot root, CAR path, and every published object,
 *   including the root directory entry itself
 * @returns {import("zod").infer<typeof artifactManifestSchema>} the validated manifest
 */
export function buildArtifactManifest({
  runId,
  county,
  generatedAt,
  rootCid,
  rootCarPath,
  entries,
}) {
  if (!Array.isArray(entries)) {
    throw new TypeError("entries must be an array of artifact entries");
  }
  return validateArtifactManifest({
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    runId,
    county,
    generatedAt,
    root: {
      cid: rootCid,
      // A content-addressed locator, so the DAG is reachable from the manifest
      // alone by anyone holding it.
      car: rootCarPath,
    },
    artifacts: [...entries]
      .sort((left, right) =>
        String(left?.name).localeCompare(String(right?.name)),
      )
      .map((entry) => ({
        cid: entry?.cid,
        name: entry?.name,
        size: entry?.size,
        codec: entry?.codec,
        sha256: entry?.sha256,
      })),
  });
}

/**
 * Validate and atomically write a manifest as pretty JSON.
 *
 * @param {unknown} manifest manifest to persist
 * @param {string} outputPath destination file
 * @returns {Promise<{ path: string, bytes: number, sha256: string }>} written path and integrity
 */
export async function writeArtifactManifest(manifest, outputPath) {
  const validated = validateArtifactManifest(manifest);
  const body = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, body);
  await rename(temporaryPath, outputPath);
  return {
    path: outputPath,
    bytes: body.length,
    sha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  };
}
