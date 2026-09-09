/**
 * Load the committed retrieval index.
 *
 * The JSON is validated against the same Zod schema that produced it, so a
 * truncated or stale file fails loudly at boot instead of returning silently
 * empty results. The sparse TF-IDF matrix is reconstructed from the postings
 * list rather than stored twice.
 */

import { readFileSync } from "node:fs";
import { ragIndexSchema, type RagIndex } from "../types.js";
import { idfOf, normalizeSparse, type SparseRow } from "./lsa.js";
import type { LexicalIndex } from "./bm25.js";
import { INDEX_PATH } from "./paths.js";

export interface LoadedIndex {
  raw: RagIndex;
  lexical: LexicalIndex;
  /** Sparse TF-IDF rows, needed to fold a query into the latent space. */
  rows: SparseRow[];
  /** Term to column, matching the order used when the index was built. */
  termIndex: Map<string, number>;
}

/** Rebuild the derived structures the scorer needs from a parsed index. */
export function prepareIndex(raw: RagIndex): LoadedIndex {
  const chunkCount = raw.chunks.length;
  const postings = new Map<string, [number, number][]>(
    Object.entries(raw.lexical.postings).map(([term, list]) => [
      term,
      list.map(([a, b]) => [a, b] as [number, number]),
    ]),
  );

  const termIndex = new Map<string, number>();
  for (const term of [...postings.keys()].sort()) termIndex.set(term, termIndex.size);

  const rows: SparseRow[] = Array.from({ length: chunkCount }, () => new Map<number, number>());
  for (const [term, list] of postings) {
    const column = termIndex.get(term);
    if (column === undefined) continue;
    const idf = idfOf(chunkCount, list.length);
    for (const [chunkIndex, frequency] of list) {
      (rows[chunkIndex] as SparseRow).set(column, (1 + Math.log(frequency)) * idf);
    }
  }
  for (const row of rows) normalizeSparse(row);

  return {
    raw,
    lexical: {
      postings,
      lengths: raw.lexical.lengths,
      averageLength: raw.lexical.averageLength,
      chunkCount,
    },
    rows,
    termIndex,
  };
}

let cached: LoadedIndex | null = null;

/** Load, validate and cache the committed index. Synchronous by design. */
export function loadIndex(path = INDEX_PATH): LoadedIndex {
  if (cached !== null) return cached;
  cached = prepareIndex(ragIndexSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
  return cached;
}

/** Drop the cached index. Used by tests that rebuild it. */
export function resetIndexCache(): void {
  cached = null;
}
