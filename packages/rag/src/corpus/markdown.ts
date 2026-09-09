/**
 * Heading-aware markdown chunking.
 *
 * Splitting on headings rather than a fixed character window keeps a chunk
 * semantically whole: "Known limitations" stays one retrievable unit instead of
 * being cut in half mid-sentence. Only sections that are genuinely long are
 * windowed, and those windows overlap so a fact that straddles the cut is still
 * findable from either side.
 *
 * Chunk ids are derived from the document id and the chunk's ordinal, so the
 * same input always produces the same ids and re-running the build is
 * idempotent.
 */

import type { CorpusChunk, DocType, Provenance } from "../types.js";
import { shortHash, tidy } from "../text.js";

/** A section longer than this is windowed. */
export const MAX_SECTION_CHARS = 1500;
/** Characters of trailing context repeated at the head of the next window. */
export const WINDOW_OVERLAP_CHARS = 200;

interface Section {
  headingPath: string[];
  body: string;
}

/** Split markdown into sections keyed by their heading trail. */
export function splitSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let path: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const body = tidy(buffer.join("\n"));
    if (body.length > 0) sections.push({ headingPath: [...path], body });
    buffer = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const depth = (heading[1] ?? "#").length;
      const title = tidy(heading[2] ?? "");
      path = path.slice(0, depth - 1);
      path[depth - 1] = title;
      path = path.filter((entry) => typeof entry === "string" && entry.length > 0);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

/** Break one long body into overlapping windows on paragraph boundaries. */
export function windowBody(body: string, maxChars = MAX_SECTION_CHARS): string[] {
  if (body.length <= maxChars) return [body];
  const paragraphs = body.split(/\n\s*\n/);
  const windows: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= maxChars || current.length === 0) {
      current = candidate;
      continue;
    }
    windows.push(current);
    const tail = current.slice(Math.max(0, current.length - WINDOW_OVERLAP_CHARS));
    current = `${tail}\n\n${paragraph}`;
  }
  if (current.trim().length > 0) windows.push(current);

  // A single paragraph longer than the window still has to be cut somewhere.
  const out: string[] = [];
  for (const window of windows) {
    if (window.length <= maxChars * 2) {
      out.push(window);
      continue;
    }
    for (let start = 0; start < window.length; start += maxChars - WINDOW_OVERLAP_CHARS) {
      out.push(window.slice(start, start + maxChars));
    }
  }
  return out;
}

export interface MarkdownDocInput {
  docId: string;
  docType: DocType;
  title: string;
  markdown: string;
  provenance: Provenance;
  metadata: Record<string, string>;
  /** Literal identifiers for this document, used by the deterministic matcher. */
  aliases: string[];
}

/** Chunk one markdown document. */
export function chunkMarkdown(input: MarkdownDocInput): CorpusChunk[] {
  const sourceHash = shortHash(input.markdown);
  const pieces: { headingPath: string[]; body: string }[] = [];

  for (const section of splitSections(input.markdown)) {
    for (const body of windowBody(section.body)) {
      const trimmed = tidy(body);
      // A heading with no prose under it is navigation, not evidence.
      if (trimmed.length < 40) continue;
      pieces.push({ headingPath: section.headingPath, body: trimmed });
    }
  }

  return pieces.map((piece, chunkIndex) => {
    const trail = [input.title, ...piece.headingPath].join(" > ");
    const text = `${trail}\n\n${piece.body}`;
    return {
      id: `${input.docId}#${chunkIndex}`,
      docId: input.docId,
      docType: input.docType,
      chunkIndex,
      chunkCount: pieces.length,
      title:
        piece.headingPath.length > 0
          ? `${input.title} — ${piece.headingPath.join(" › ")}`
          : input.title,
      headingPath: piece.headingPath,
      textForEmbedding: text,
      textForContext: text,
      sourceHash,
      aliases: input.aliases,
      metadata: { ...input.metadata, heading: piece.headingPath.at(-1) ?? "" },
      provenance: input.provenance,
    };
  });
}
