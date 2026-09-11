/**
 * Build the committed retrieval index.
 *
 * The output is one JSON file checked into the repository as build output. It
 * carries the chunks, the postings list, and the latent space — everything the
 * server needs to answer a retrieval call at boot with no API key, no model
 * download and no network. Rebuilding it from the same checkout produces a
 * byte-identical file, which is asserted by a test rather than assumed.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildCorpus } from "../corpus/build.js";
import { tokenize } from "../text.js";
import { buildLatentSpace, idfOf, normalizeSparse, type SparseRow } from "./lsa.js";
import { ragIndexSchema, type RagIndex } from "../types.js";
import { INDEX_PATH } from "./paths.js";

export { INDEX_PATH, PACKAGE_ROOT } from "./paths.js";

/** Latent dimensions. Capped by the corpus size, which bounds the true rank. */
export const LATENT_DIMENSIONS = 96;

/** Version stamp, bumped whenever scoring inputs change shape. */
export const EMBEDDING_VERSION = "lsa-v1";

/** Round for storage so the committed file is stable and compact. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Compute the full index from the explicitly selected corpus run on disk. */
export async function buildIndex(expectedRunId?: string): Promise<RagIndex> {
  const corpus = await buildCorpus(expectedRunId);
  if (corpus.chunks.length === 0)
    throw new Error("Corpus is empty: no source documents were found");

  const chunkCount = corpus.chunks.length;
  const postings = new Map<string, [number, number][]>();
  const lengths: number[] = [];
  const counted: Map<string, number>[] = [];

  corpus.chunks.forEach((chunk, chunkIndex) => {
    const terms = tokenize(chunk.textForEmbedding);
    lengths.push(terms.length);
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    counted.push(counts);
    for (const [term, frequency] of counts) {
      const list = postings.get(term);
      if (list) list.push([chunkIndex, frequency]);
      else postings.set(term, [[chunkIndex, frequency]]);
    }
  });

  // Sparse TF-IDF rows, sublinear in term frequency, L2-normalised.
  const termIndex = new Map<string, number>();
  for (const term of [...postings.keys()].sort()) termIndex.set(term, termIndex.size);

  const rows: SparseRow[] = counted.map((counts) => {
    const row: SparseRow = new Map();
    for (const [term, frequency] of counts) {
      const column = termIndex.get(term);
      if (column === undefined) continue;
      const documentFrequency = postings.get(term)?.length ?? 1;
      row.set(column, (1 + Math.log(frequency)) * idfOf(chunkCount, documentFrequency));
    }
    return normalizeSparse(row);
  });

  const latent = buildLatentSpace(rows, Math.min(LATENT_DIMENSIONS, Math.max(1, chunkCount - 1)));

  const index: RagIndex = {
    schemaVersion: "oracle.rag-index.v2",
    county: "lake",
    builtFrom: {
      runId: corpus.runId,
      releaseState: corpus.releaseState,
      rootCid: corpus.rootCid,
      snapshotDigest: corpus.sourceSnapshot.digest,
      sourceCount: corpus.sourceSnapshot.inputs.length,
      sourceReceipt: corpus.sourceReceipt,
    },
    sourceSnapshot: corpus.sourceSnapshot,
    embedding: {
      model: "lsa-tfidf-svd",
      dimension: latent.singularValues.length,
      version: EMBEDDING_VERSION,
    },
    chunks: corpus.chunks,
    links: corpus.links,
    lexical: {
      lengths,
      averageLength: lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length),
      postings: Object.fromEntries(
        [...postings.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
    singularVectors: latent.singularVectors.map((row) => row.map(round)),
    singularValues: latent.singularValues.map(round),
    chunkVectors: latent.chunkVectors.map((row) => row.map(round)),
  };

  return ragIndexSchema.parse(index);
}

/** Build the index and write it to the committed path. */
export async function writeIndex(
  path = INDEX_PATH,
  expectedRunId?: string,
): Promise<{ path: string; index: RagIndex }> {
  const index = await buildIndex(expectedRunId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(index)}\n`, "utf8");
  return { path, index };
}
