import { describe, expect, it } from "vitest";
import { assertIndexCompatibleWithRun } from "../src/compatibility.js";
import { loadIndex } from "../src/index/load.js";
import { suggestPaths } from "../src/paths.js";
import { ragIndexSchema, type RagIndex } from "../src/types.js";
import { selectCorpusSource } from "../src/corpus/source.js";

const index = loadIndex();
const selectedPromise = selectCorpusSource();

/** Deliberately empty synthetic compatibility input; no actual selected
 * chunks, identifiers, citations or source observations are relabeled. */
function compatibilityFixture(
  releaseState: "local_candidate" | "published",
  rootCid: string | null,
): RagIndex {
  return ragIndexSchema.parse({
    schemaVersion: "oracle.rag-index.v2",
    county: "synthetic-compatibility-fixture",
    builtFrom: {
      runId: "synthetic-compatibility-run",
      releaseState,
      rootCid,
      snapshotDigest: `sha256:${"0".repeat(64)}`,
      sourceCount: 1,
      sourceReceipt: "synthetic-compatibility-receipt",
    },
    sourceSnapshot: {
      digest: `sha256:${"0".repeat(64)}`,
      inputs: [{ path: "synthetic-fixture", sha256: "0".repeat(64) }],
    },
    embedding: { model: "lsa-tfidf-svd", dimension: 1, version: "synthetic-fixture" },
    chunks: [],
    links: [],
    lexical: { lengths: [], averageLength: 0, postings: {} },
    singularVectors: [],
    singularValues: [],
    chunkVectors: [],
  });
}

describe("corpus contracts", () => {
  it("has deterministic unique chunk ids and resolvable typed links", () => {
    expect(new Set(index.raw.chunks.map((chunk) => chunk.id)).size).toBe(index.raw.chunks.length);
    const docs = new Set(index.raw.chunks.map((chunk) => chunk.docId));
    for (const chunk of index.raw.chunks) {
      expect(chunk.id).toBe(`${chunk.docId}#${chunk.chunkIndex}`);
      expect(chunk.sourceHash).toMatch(/^[a-f0-9]{16}$/);
      expect(chunk.textForEmbedding.length).toBeGreaterThan(0);
      expect(chunk.textForContext.length).toBeGreaterThan(0);
    }
    for (const link of index.raw.links) {
      expect(docs.has(link.sourceDocId)).toBe(true);
      expect(docs.has(link.targetDocId)).toBe(true);
      expect(Object.keys(link.metadata).length).toBeGreaterThan(0);
    }
  });

  it("stores only portable source paths and no local database", () => {
    for (const input of index.raw.sourceSnapshot.inputs) {
      expect(input.path.startsWith("/")).toBe(false);
      expect(input.path.startsWith("..")).toBe(false);
      expect(input.path).not.toMatch(/\.(?:db|sqlite|sqlite3)$/i);
    }
    for (const chunk of index.raw.chunks) {
      expect(chunk.provenance.sourceFile.startsWith("/")).toBe(false);
      expect(chunk.provenance.sourceFile).not.toContain("/Users/");
    }
  });

  it("limits the tenure conclusion to loaded and inspected DOR evidence", () => {
    const text = index.raw.chunks
      .filter((chunk) => chunk.docId === "source:sdf")
      .map((chunk) => chunk.textForContext)
      .join("\n");

    expect(text).toContain(
      "Ten-year ownership tenure provable from the loaded and inspected DOR evidence: NO.",
    );
    expect(text).toContain("remain unknown, not unavailable");
    expect(text).not.toContain("Ten-year ownership tenure provable from published sources");
    expect(text).not.toContain("cannot be proven from any published Lake source");
  });

  it("keeps Sunbiz mandatory without treating execution approval as a kit waiver", () => {
    const text = index.raw.chunks
      .filter((chunk) => chunk.docId === "source:sunbiz")
      .map((chunk) => chunk.textForContext)
      .join("\n");

    expect(text).toContain("historically not ingested for this run");
    expect(text).toContain("Sunbiz is mandatory and unresolved");
    expect(text).toContain(
      "Sunbiz first, then an adequate official DBPR snapshot, before future permit harvesting",
    );
    expect(text).toContain("DOR TPP is not a substitute for this identity baseline");
    expect(text).toContain("owner execution approval alone is not a kit waiver");
    expect(text).not.toContain("outside this assignment's acceptance criteria");
    expect(text).not.toContain("Sunbiz is optional");
  });
});

describe("served-run compatibility", () => {
  it("accepts the actual validated selected release only beside its exact identity", async () => {
    const { receipt } = await selectedPromise;
    expect(index.raw.builtFrom).toMatchObject({
      runId: receipt.runId,
      rootCid: receipt.rootCid,
      releaseState: receipt.releaseState,
    });
    expect(() =>
      assertIndexCompatibleWithRun(index.raw, {
        runId: receipt.runId,
        rootCid: receipt.rootCid,
      }),
    ).not.toThrow();
  });

  it("rejects a different run beside the actual selected release", async () => {
    const { receipt } = await selectedPromise;
    expect(() =>
      assertIndexCompatibleWithRun(index.raw, {
        runId: "synthetic-different-served-run",
        rootCid: receipt.rootCid,
      }),
    ).toThrow(/does not match served run/);
  });

  it("accepts a synthetic local candidate only beside its own unpublished run", () => {
    const local = compatibilityFixture("local_candidate", null);
    expect(() =>
      assertIndexCompatibleWithRun(local, { runId: local.builtFrom.runId, rootCid: null }),
    ).not.toThrow();
    expect(() =>
      assertIndexCompatibleWithRun(local, {
        runId: local.builtFrom.runId,
        rootCid: "synthetic-public-root",
      }),
    ).toThrow(/unpublished local candidate/);
  });

  it("requires both run id and root CID for a published corpus", () => {
    const published = compatibilityFixture("published", "synthetic-published-root");
    expect(() =>
      assertIndexCompatibleWithRun(published, {
        runId: published.builtFrom.runId,
        rootCid: published.builtFrom.rootCid,
      }),
    ).not.toThrow();
    expect(() =>
      assertIndexCompatibleWithRun(published, {
        runId: published.builtFrom.runId,
        rootCid: "synthetic-other-root",
      }),
    ).toThrow(/does not match served root/);
    expect(() =>
      assertIndexCompatibleWithRun(published, { runId: published.builtFrom.runId, rootCid: null }),
    ).toThrow(/does not match served root/);
  });

  it("refuses missing served run identity and published corpus missing its CID", () => {
    const local = compatibilityFixture("local_candidate", null);
    expect(() => assertIndexCompatibleWithRun(local, { runId: null, rootCid: null })).toThrow(
      /no runId/,
    );
    const unbound = compatibilityFixture("published", null);
    expect(() =>
      assertIndexCompatibleWithRun(unbound, {
        runId: unbound.builtFrom.runId,
        rootCid: "synthetic-root",
      }),
    ).toThrow(/no rootCid/);
  });
});

describe("paths contract", () => {
  it("returns only corpus-backed evidence paths", () => {
    const result = suggestPaths(
      {
        query: "full permit number status dates source URL and linkage details",
        topK: 5,
      },
      index,
    );
    expect(result.abstained).toBe(false);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.some((entry) => entry.path.endsWith("permit-schema.json"))).toBe(
      true,
    );
    for (const suggestion of result.suggestions) {
      expect(suggestion.path.startsWith("/")).toBe(false);
      expect(suggestion.evidence.length).toBeGreaterThan(0);
    }
  });

  it("returns no guessed path for an unanswerable request", () => {
    const result = suggestPaths({ query: "implement tomorrow weather radar", topK: 5 }, index);
    expect(result.abstained).toBe(true);
    expect(result.suggestions).toEqual([]);
  });
});
