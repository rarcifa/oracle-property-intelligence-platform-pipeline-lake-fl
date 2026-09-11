/** Source-path suggestions grounded only in retrieved chunks and corpus links. */

import { z } from "zod";
import { loadIndex, type LoadedIndex } from "./index/load.js";
import { retrieve } from "./retrieve.js";

export const pathOptionsSchema = z.object({
  query: z.string().trim().min(2).max(4000),
  topK: z.number().int().min(1).max(20).default(5),
});

export interface PathSuggestion {
  path: string;
  kind: "documentation" | "source_catalog" | "run_artifact" | "source_evidence";
  score: number;
  evidence: {
    docId: string;
    chunkId: string;
    relation: "direct" | "linked";
    linkRelation: string | null;
  }[];
}

export interface PathResult {
  query: string;
  abstained: boolean;
  note: string;
  suggestions: PathSuggestion[];
  index: {
    runId: string;
    releaseState: "local_candidate" | "published";
    snapshotDigest: string;
  };
}

function validRepositoryPath(path: string): boolean {
  return (
    path.length > 0 && !path.startsWith("/") && !path.startsWith("..") && !path.includes("://")
  );
}

function kindOf(path: string): PathSuggestion["kind"] {
  if (path.endsWith("lake-sources.yaml")) return "source_catalog";
  if (path.startsWith("pipeline/data/artifacts/")) return "run_artifact";
  if (path.endsWith(".md")) return "documentation";
  return "source_evidence";
}

/**
 * Return only paths directly evidenced by a hit or a typed corpus edge.
 *
 * The corpus has no diffs or implementation chunks, so this deliberately does
 * not guess source-code files that might change. It answers "where is the
 * evidence?", and says so in the output contract.
 */
export function suggestPaths(input: unknown, index: LoadedIndex = loadIndex()): PathResult {
  const options = pathOptionsSchema.parse(input);
  const retrieval = retrieve({ query: options.query, topK: Math.min(20, options.topK * 2) }, index);
  const byDoc = new Map<string, (typeof index.raw.chunks)[number]>();
  for (const chunk of index.raw.chunks) {
    if (!byDoc.has(chunk.docId)) byDoc.set(chunk.docId, chunk);
  }

  const suggestions = new Map<string, PathSuggestion>();
  const add = (path: string, score: number, evidence: PathSuggestion["evidence"][number]): void => {
    if (!validRepositoryPath(path)) return;
    const existing = suggestions.get(path);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      if (!existing.evidence.some((entry) => JSON.stringify(entry) === JSON.stringify(evidence))) {
        existing.evidence.push(evidence);
      }
      return;
    }
    suggestions.set(path, {
      path,
      kind: kindOf(path),
      score,
      evidence: [evidence],
    });
  };

  for (const hit of retrieval.chunks) {
    add(hit.provenance.sourceFile, hit.score, {
      docId: hit.docId,
      chunkId: hit.id,
      relation: "direct",
      linkRelation: null,
    });
    for (const link of index.raw.links) {
      const neighborId =
        link.sourceDocId === hit.docId
          ? link.targetDocId
          : link.targetDocId === hit.docId
            ? link.sourceDocId
            : null;
      if (neighborId === null) continue;
      const neighbor = byDoc.get(neighborId);
      if (!neighbor) continue;
      add(neighbor.provenance.sourceFile, hit.score * 0.85, {
        docId: neighbor.docId,
        chunkId: neighbor.id,
        relation: "linked",
        linkRelation: link.relation,
      });
    }
  }

  const ranked = [...suggestions.values()]
    .map((entry) => ({
      ...entry,
      score: Math.round(entry.score * 1e4) / 1e4,
      evidence: entry.evidence.sort((left, right) =>
        `${left.docId}|${left.relation}`.localeCompare(`${right.docId}|${right.relation}`),
      ),
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, options.topK);

  const abstained = retrieval.abstained || ranked.length === 0;
  return {
    query: options.query,
    abstained,
    note: abstained
      ? "No corpus-backed source path was found. Do not invent a file path."
      : "These are evidence source files named by retrieved chunks or typed corpus links; they are not guessed implementation-change paths.",
    suggestions: abstained ? [] : ranked,
    index: {
      runId: index.raw.builtFrom.runId,
      releaseState: index.raw.builtFrom.releaseState,
      snapshotDigest: index.raw.builtFrom.snapshotDigest,
    },
  };
}
