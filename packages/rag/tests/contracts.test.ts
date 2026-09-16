import { describe, expect, it } from "vitest";
import { assertIndexCompatibleWithRun } from "../src/compatibility.js";
import { loadIndex } from "../src/index/load.js";
import { suggestPaths } from "../src/paths.js";
import type { RagIndex } from "../src/types.js";

const index = loadIndex();

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
  it("accepts the selected candidate only beside the same local run", () => {
    expect(() =>
      assertIndexCompatibleWithRun(index.raw, {
        runId: "20260911T131000Z",
        rootCid: null,
      }),
    ).not.toThrow();
  });

  it("rejects a different run or a public root for a local candidate", () => {
    expect(() =>
      assertIndexCompatibleWithRun(index.raw, {
        runId: "20260910T225242Z",
        rootCid: null,
      }),
    ).toThrow(/does not match served run/);
    expect(() =>
      assertIndexCompatibleWithRun(index.raw, {
        runId: "20260911T131000Z",
        rootCid: "bafy-public",
      }),
    ).toThrow(/unpublished local candidate/);
  });

  it("requires both run id and root CID for a published corpus", () => {
    const published = structuredClone(index.raw) as RagIndex;
    published.builtFrom.releaseState = "published";
    published.builtFrom.rootCid = "bafy-release";
    expect(() =>
      assertIndexCompatibleWithRun(published, {
        runId: published.builtFrom.runId,
        rootCid: "bafy-release",
      }),
    ).not.toThrow();
    expect(() =>
      assertIndexCompatibleWithRun(published, {
        runId: published.builtFrom.runId,
        rootCid: "bafy-other",
      }),
    ).toThrow(/does not match served root/);
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
