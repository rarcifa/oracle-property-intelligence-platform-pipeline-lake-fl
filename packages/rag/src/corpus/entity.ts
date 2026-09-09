/**
 * Helper for the generated half of the corpus.
 *
 * Documents in this half are not extracted from prose; they are written from
 * structured records — the source catalog, the coverage snapshot, the published
 * schema — into the sentences a person would use to ask about them. The text is
 * generated deterministically from the record, so it can never drift from the
 * data it describes, and every one carries the provenance of the record it was
 * generated from.
 */

import type { CorpusChunk, DocType, Provenance } from "../types.js";
import { shortHash, tidy } from "../text.js";

export interface EntityChunkInput {
  docId: string;
  docType: DocType;
  title: string;
  /** Lines of generated prose. Empty entries are dropped. */
  lines: (string | null | undefined | false)[];
  aliases: string[];
  metadata: Record<string, string>;
  provenance: Provenance;
}

/** Build a one-chunk generated document. */
export function entityChunk(input: EntityChunkInput): CorpusChunk {
  const body = tidy(
    input.lines
      .filter((line): line is string => typeof line === "string" && line.length > 0)
      .join("\n"),
  );
  const text = `${input.title}\n\n${body}`;
  return {
    id: `${input.docId}#0`,
    docId: input.docId,
    docType: input.docType,
    chunkIndex: 0,
    chunkCount: 1,
    title: input.title,
    headingPath: [],
    textForEmbedding: text,
    textForContext: text,
    sourceHash: shortHash(text),
    aliases: [...new Set(input.aliases.filter((alias) => alias.trim().length > 2))],
    metadata: input.metadata,
    provenance: input.provenance,
  };
}

/** Format a count the way the corpus writes counts, so queries match. */
export function count(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : "unknown";
}
