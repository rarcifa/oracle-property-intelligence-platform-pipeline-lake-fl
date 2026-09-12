/**
 * Index-build tests.
 *
 * The committed index must be exactly what the current checkout produces.
 * If it is not, the server is answering from a stale corpus, which is the one
 * failure mode a retrieval layer cannot detect at runtime.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildIndex, INDEX_PATH } from "../src/index/build-index.js";
import { buildSourceSnapshot, collectLocalModuleClosure, REPO_ROOT } from "../src/corpus/source.js";
import { ragIndexSchema } from "../src/types.js";
import { cosine } from "../src/index/lsa.js";

const committed = ragIndexSchema.parse(JSON.parse(readFileSync(INDEX_PATH, "utf8")));
const rebuiltPromise = buildIndex();

describe("committed index", () => {
  it("validates against its own schema", () => {
    expect(committed.schemaVersion).toBe("oracle.rag-index.v2");
    expect(committed.chunks.length).toBeGreaterThan(100);
    expect(committed.embedding.dimension).toBeGreaterThan(1);
  });

  it("matches a rebuild from the current checkout", async () => {
    const rebuilt = await rebuiltPromise;
    expect(rebuilt.chunks.map((chunk) => chunk.id)).toEqual(
      committed.chunks.map((chunk) => chunk.id),
    );
    expect(rebuilt.chunks.map((chunk) => chunk.sourceHash)).toEqual(
      committed.chunks.map((chunk) => chunk.sourceHash),
    );
    expect(rebuilt.embedding).toEqual(committed.embedding);
    expect(rebuilt.builtFrom).toEqual(committed.builtFrom);
    expect(rebuilt.sourceSnapshot).toEqual(committed.sourceSnapshot);
    expect(Object.keys(rebuilt.lexical.postings)).toEqual(Object.keys(committed.lexical.postings));
  });

  it("produces the same latent space on a rebuild", async () => {
    const rebuilt = await rebuiltPromise;
    expect(rebuilt.chunkVectors).toHaveLength(committed.chunkVectors.length);
    for (let position = 0; position < committed.chunkVectors.length; position += 1) {
      const similarity = cosine(
        rebuilt.chunkVectors[position] as number[],
        committed.chunkVectors[position] as number[],
      );
      expect(similarity).toBeGreaterThan(0.999);
    }
  });

  it("carries no embedding provider, key or model download", () => {
    expect(committed.embedding.model).toBe("lsa-tfidf-svd");
    const serialised = JSON.stringify(committed.embedding);
    expect(serialised).not.toMatch(/openai|bedrock|anthropic|voyage|cohere/i);
  });

  it("binds one unpublished candidate without borrowing a public CID", () => {
    expect(committed.builtFrom).toMatchObject({
      runId: "20260911T131000Z",
      releaseState: "local_candidate",
      rootCid: null,
      sourceReceipt: "packages/rag/corpus-source.json",
    });
    expect(committed.builtFrom.snapshotDigest).toBe(committed.sourceSnapshot.digest);
    expect(committed.sourceSnapshot.inputs).toHaveLength(committed.builtFrom.sourceCount);
    for (const chunk of committed.chunks.filter(
      (entry) => entry.provenance.releaseState === "local_candidate",
    )) {
      expect(chunk.provenance.runId).toBe("20260911T131000Z");
      expect(chunk.provenance.rootCid).toBeNull();
      expect(chunk.provenance.cid).toBeNull();
      expect(chunk.provenance.ipfsPath).toBeNull();
    }
  });

  it("binds the complete transitive local generator closure", async () => {
    const closure = await collectLocalModuleClosure([
      resolve(REPO_ROOT, "packages/rag/src/index/build-index.ts"),
    ]);
    const snapshotted = new Set(committed.sourceSnapshot.inputs.map((input) => input.path));
    for (const path of closure) {
      expect(snapshotted.has(path.slice(REPO_ROOT.length + 1)), path).toBe(true);
    }
    for (const required of [
      "packages/rag/src/index/build-index.ts",
      "packages/rag/src/index/lsa.ts",
      "packages/rag/src/corpus/build.ts",
      "packages/rag/src/corpus/markdown.ts",
      "packages/rag/src/corpus/sources-yaml.ts",
      "packages/rag/src/text.ts",
      "packages/shared/src/index.ts",
      "packages/shared/src/schema.ts",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ]) {
      expect(snapshotted.has(required), required).toBe(true);
    }
  });

  it("changes the digest when an adversarial transitive generator dependency changes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "oracle-rag-closure-"));
    try {
      const entry = resolve(root, "entry.ts");
      const dependency = resolve(root, "dependency.ts");
      await writeFile(entry, 'import { value } from "./dependency.js";\nexport { value };\n');
      await writeFile(dependency, 'export const value = "first";\n');

      const firstClosure = await collectLocalModuleClosure([entry], root);
      const first = await buildSourceSnapshot(firstClosure, root);
      expect(first.inputs.map((input) => input.path)).toEqual(["dependency.ts", "entry.ts"]);

      await writeFile(dependency, 'export const value = "tampered";\n');
      const secondClosure = await collectLocalModuleClosure([entry], root);
      const second = await buildSourceSnapshot(secondClosure, root);
      expect(second.digest).not.toBe(first.digest);
      expect(second.inputs.find((input) => input.path === "entry.ts")?.sha256).toBe(
        first.inputs.find((input) => input.path === "entry.ts")?.sha256,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
