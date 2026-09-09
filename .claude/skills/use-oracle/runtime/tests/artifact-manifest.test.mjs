import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_MANIFEST_SCHEMA_VERSION,
  buildArtifactManifest,
  validateArtifactManifest,
  writeArtifactManifest,
} from "../src/core/artifact-manifest.mjs";
import {
  buildUnixfsDirectory,
  computeUnixfsFileCid,
  sha256Hex,
} from "../src/core/cid.mjs";

const temporaryDirectories = [];

const propertiesBody = "parcel,owner\n1,ACME\n";
const coverageBody = '{"county":"lake"}\n';
const properties = computeUnixfsFileCid(propertiesBody);
const coverage = computeUnixfsFileCid(coverageBody);
const root = buildUnixfsDirectory([
  {
    name: "properties.csv",
    cid: properties.cid,
    size: properties.size,
    blocks: properties.blocks,
  },
  {
    name: "dataset-coverage.json",
    cid: coverage.cid,
    size: coverage.size,
    blocks: coverage.blocks,
  },
]);

/**
 * @param {Array<Record<string, unknown>>} [overrides] extra or replacement entries
 * @returns {Array<Record<string, unknown>>}
 */
function entries(overrides = []) {
  return [
    {
      cid: root.cid,
      name: ".",
      size: root.size,
      codec: "directory",
      sha256: `sha256:${sha256Hex(new Uint8Array(0))}`,
      origins: [],
    },
    {
      cid: properties.cid,
      name: "properties.csv",
      size: propertiesBody.length,
      codec: "file",
      sha256: `sha256:${sha256Hex(propertiesBody)}`,
      origins: ["https://gateway.pinata.cloud"],
    },
    {
      cid: coverage.cid,
      name: "dataset-coverage.json",
      size: coverageBody.length,
      codec: "file",
      sha256: `sha256:${sha256Hex(coverageBody)}`,
    },
    ...overrides,
  ];
}

/**
 * @param {Array<Record<string, unknown>>} [overrides] entries to append
 * @returns {ReturnType<typeof buildArtifactManifest>}
 */
function manifest(overrides = []) {
  return buildArtifactManifest({
    runId: "2026-09-09T00-00-00Z",
    county: "lake",
    generatedAt: "2026-09-09T00:00:00.000Z",
    rootCid: root.cid,
    rootCarPath: "lake-2026-09-09.car",
    entries: entries(overrides),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("buildArtifactManifest", () => {
  it("stamps the schema version and sorts artifacts by name", () => {
    const built = manifest();
    expect(built.schemaVersion).toBe(ARTIFACT_MANIFEST_SCHEMA_VERSION);
    expect(built.schemaVersion).toBe("elephant.artifact-manifest.v1");
    expect(built.root).toEqual({
      cid: root.cid,
      car: "lake-2026-09-09.car",
    });
    expect(built.artifacts.map((artifact) => artifact.name)).toEqual([
      ".",
      "dataset-coverage.json",
      "properties.csv",
    ]);
  });

  it("defaults origins to an empty list", () => {
    const built = manifest();
    const coverageEntry = built.artifacts.find(
      (artifact) => artifact.name === "dataset-coverage.json",
    );
    expect(coverageEntry.origins).toEqual([]);
  });

  it("records size, codec and digest for every artifact", () => {
    const built = manifest();
    const propertiesEntry = built.artifacts.find(
      (artifact) => artifact.name === "properties.csv",
    );
    expect(propertiesEntry).toEqual({
      cid: properties.cid,
      name: "properties.csv",
      size: propertiesBody.length,
      codec: "file",
      sha256: `sha256:${sha256Hex(propertiesBody)}`,
      origins: ["https://gateway.pinata.cloud"],
    });
  });
});

describe("validateArtifactManifest", () => {
  it("rejects a missing sha256", () => {
    const broken = manifest();
    delete broken.artifacts[1].sha256;
    expect(() => validateArtifactManifest(broken)).toThrow(
      /artifacts\.1\.sha256/,
    );
  });

  it("rejects a malformed sha256", () => {
    const broken = manifest();
    broken.artifacts[1].sha256 = sha256Hex(propertiesBody);
    expect(() => validateArtifactManifest(broken)).toThrow(
      /sha256:<64-hex> digest/,
    );
  });

  it("rejects a bad codec value", () => {
    const broken = manifest();
    broken.artifacts[1].codec = "parquet";
    expect(() => validateArtifactManifest(broken)).toThrow(
      /artifacts\.1\.codec/,
    );
  });

  it("rejects a non-CIDv1 cid", () => {
    const broken = manifest();
    broken.artifacts[1].cid = "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";
    expect(() => validateArtifactManifest(broken)).toThrow(
      /must be a CIDv1 base32 string/,
    );
  });

  it("rejects unknown fields, a wrong schema version and a missing root", () => {
    expect(() =>
      validateArtifactManifest({ ...manifest(), extra: true }),
    ).toThrow(/Invalid artifact manifest/);
    expect(() =>
      validateArtifactManifest({
        ...manifest(),
        schemaVersion: "elephant.artifact-manifest.v2",
      }),
    ).toThrow(/schemaVersion/);
    const orphaned = manifest();
    orphaned.artifacts = orphaned.artifacts.filter(
      (artifact) => artifact.codec === "file",
    );
    expect(() => validateArtifactManifest(orphaned)).toThrow(
      /root cid is not listed in artifacts/,
    );
  });

  it("rejects duplicate artifact names", () => {
    const duplicated = manifest();
    duplicated.artifacts.push({ ...duplicated.artifacts[1] });
    expect(() => validateArtifactManifest(duplicated)).toThrow(
      /duplicate artifact name/,
    );
  });
});

describe("writeArtifactManifest", () => {
  it("writes validated JSON that reads back unchanged", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "oracle-manifest-"));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "nested", "manifest.json");
    const built = manifest();
    const written = await writeArtifactManifest(built, outputPath);
    const body = await readFile(outputPath);
    expect(written.path).toBe(outputPath);
    expect(written.bytes).toBe(body.length);
    expect(written.sha256).toBe(`sha256:${sha256Hex(body)}`);
    expect(body.toString("utf8").endsWith("}\n")).toBe(true);
    expect(validateArtifactManifest(JSON.parse(body.toString("utf8")))).toEqual(
      built,
    );
  });

  it("refuses to write an invalid manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "oracle-manifest-"));
    temporaryDirectories.push(directory);
    const broken = manifest();
    broken.artifacts[1].size = -1;
    await expect(
      writeArtifactManifest(broken, path.join(directory, "manifest.json")),
    ).rejects.toThrow(/Invalid artifact manifest/);
  });
});
