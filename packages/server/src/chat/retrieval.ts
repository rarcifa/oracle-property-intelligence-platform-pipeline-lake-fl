/**
 * The semantic retrieval capability, shared by the HTTP route and the agent.
 *
 * The SQL tools answer "how many" and "which parcels". They cannot answer "why
 * is this field empty", "what does this source actually cover", "how was roof
 * age derived" or "which jurisdictions are blocked and how do I request their
 * records", because none of those answers are rows. This is the surface that
 * can, and it complements the SQL loop rather than duplicating it.
 *
 * The retrieval index is a committed build artifact with no API key and no
 * model behind it, so this loads lazily and degrades to a clear error rather
 * than taking the process down when the index is missing.
 */

import {
  assertIndexCompatibleWithRun,
  loadIndex,
  retrieve,
  retrievalOptionsSchema,
  type LoadedIndex,
  type RetrievalResult,
  type ServedRunIdentity,
} from "@oracle-lake/rag";

/** One retrieved document, flattened for citation display. */
export interface DocumentCitation {
  chunkId: string;
  docId: string;
  docType: string;
  title: string;
  score: number;
  /** Repository path the text came from. */
  sourceFile: string;
  /** Published artifact name, when the text is also published to IPFS. */
  artifact: string | null;
  /** CID of that artifact. */
  cid: string | null;
  /** Resolvable `ipfs://` path, when published. */
  ipfsPath: string | null;
}

/** Raised when the committed retrieval index cannot be loaded. */
export class RetrievalUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = "RetrievalUnavailableError";
    this.detail = detail;
  }
}

type IndexState = { ok: true; index: LoadedIndex } | { ok: false; detail: string };

let state: IndexState | null = null;

/** Load the committed index once, remembering a failure instead of retrying it. */
export function getRetrievalIndex(): LoadedIndex {
  if (state === null) {
    try {
      state = { ok: true, index: loadIndex() };
    } catch (error) {
      state = {
        ok: false,
        detail: `The retrieval index could not be loaded. Rebuild it with \`pnpm --filter @oracle-lake/rag build:index\`. Underlying error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  if (!state.ok) throw new RetrievalUnavailableError(state.detail);
  return state.index;
}

/** Drop the memoised index. Used by tests. */
export function resetRetrievalIndex(): void {
  state = null;
}

export const searchRequestSchema = retrievalOptionsSchema;

/** Run one retrieval. Throws {@link RetrievalUnavailableError} when unusable. */
export function searchCorpus(input: unknown, served?: ServedRunIdentity): RetrievalResult {
  const index = getRetrievalIndex();
  if (served !== undefined) {
    try {
      assertIndexCompatibleWithRun(index.raw, served);
    } catch (error) {
      throw new RetrievalUnavailableError(
        `The retrieval corpus does not describe the dataset currently being served. ${
          error instanceof Error ? error.message : String(error)
        } Rebuild the index from an exact source receipt for that run.`,
      );
    }
  }
  return retrieve(searchRequestSchema.parse(input), index);
}

/** Flatten a retrieval result into citation records. */
export function toDocumentCitations(result: RetrievalResult): DocumentCitation[] {
  return result.chunks.map((chunk) => ({
    chunkId: chunk.id,
    docId: chunk.docId,
    docType: chunk.docType,
    title: chunk.title,
    score: chunk.score,
    sourceFile: chunk.provenance.sourceFile,
    artifact: chunk.provenance.artifact,
    cid: chunk.provenance.cid,
    ipfsPath: chunk.provenance.ipfsPath,
  }));
}

/**
 * Shape the model sees.
 *
 * Confidence and the abstention note travel with the evidence so the model is
 * told, in the tool result itself, when it must decline. Full chunk text is
 * included because the whole point is grounding; the corpus carries no PII, so
 * there is nothing here that must be kept out of a prompt.
 */
export function toToolPayload(result: RetrievalResult): {
  confidence: string;
  abstained: boolean;
  guidance: string;
  documents: {
    docId: string;
    title: string;
    score: number;
    text: string;
    sourceFile: string;
    cid: string | null;
  }[];
} {
  return {
    confidence: result.confidence,
    abstained: result.abstained,
    guidance: result.note,
    documents: result.chunks.map((chunk) => ({
      docId: chunk.docId,
      title: chunk.title,
      score: chunk.score,
      text: chunk.text,
      sourceFile: chunk.provenance.sourceFile,
      cid: chunk.provenance.cid,
    })),
  };
}
