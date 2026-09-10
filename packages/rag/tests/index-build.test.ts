/**
 * Index-build tests.
 *
 * The committed index must be exactly what the current checkout produces.
 * If it is not, the server is answering from a stale corpus, which is the one
 * failure mode a retrieval layer cannot detect at runtime.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildIndex, INDEX_PATH } from "../src/index/build-index.js";
import { ragIndexSchema } from "../src/types.js";
import { cosine } from "../src/index/lsa.js";

const committed = ragIndexSchema.parse(JSON.parse(readFileSync(INDEX_PATH, "utf8")));
const rebuiltPromise = buildIndex();

describe("committed index", () => {
  it("validates against its own schema", () => {
    expect(committed.schemaVersion).toBe("oracle.rag-index.v1");
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
});
