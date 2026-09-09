/**
 * The corpus, index and retrieval contracts.
 *
 * Everything the retriever stores or returns is described here as a Zod schema
 * first and a TypeScript type second, so the committed index file is validated
 * on load rather than trusted. The field names deliberately mirror the
 * `rag_sources` / `rag_chunks` / `rag_links` model in the kit's
 * `build-local-rag-pocs` skill, which is what a later migration to OpenSearch
 * maps onto one-for-one.
 */

import { z } from "zod";

/** What kind of thing a corpus document describes. */
export const DOC_TYPES = [
  "doc", // prose from a repository markdown file
  "jurisdiction", // one permit-issuing authority
  "source", // one upstream data source
  "column", // one published query-table column
  "limitation", // one documented coverage limitation
  "coverage", // a coverage-snapshot section
  "access", // an access/gating state
  "publication", // the published run, its CIDs and layout
  "sample", // a published sample extract
] as const;

export type DocType = (typeof DOC_TYPES)[number];

/** Provenance carried by every chunk. Never optional in spirit: nulls are explicit. */
export const provenanceSchema = z.object({
  /** Repository-relative path of the file the text came from. */
  sourceFile: z.string(),
  /** Name of the published artifact, when the text came from one. */
  artifact: z.string().nullable(),
  /** Published run id the artifact belongs to. */
  runId: z.string().nullable(),
  /** CID of the published artifact itself. */
  cid: z.string().nullable(),
  /** CID of the published run root the artifact sits under. */
  rootCid: z.string().nullable(),
  /** Resolvable `ipfs://` path, when the text is published. */
  ipfsPath: z.string().nullable(),
});

export type Provenance = z.infer<typeof provenanceSchema>;

/** One retrievable unit. */
export const corpusChunkSchema = z.object({
  /** Deterministic id: `<docId>#<chunkIndex>`. */
  id: z.string(),
  docId: z.string(),
  docType: z.enum(DOC_TYPES),
  chunkIndex: z.number().int().min(0),
  chunkCount: z.number().int().min(1),
  title: z.string(),
  /** Heading trail inside the source document, outermost first. */
  headingPath: z.array(z.string()),
  /** Exactly the text that is embedded and scored. */
  textForEmbedding: z.string(),
  /** Exactly the text that may be shown to an agent or a user. */
  textForContext: z.string(),
  /** Short, stable hash of the source bytes this chunk was derived from. */
  sourceHash: z.string(),
  /** Literal strings that identify this document, matched case-insensitively. */
  aliases: z.array(z.string()),
  /** Filterable facets. */
  metadata: z.record(z.string()),
  provenance: provenanceSchema,
});

export type CorpusChunk = z.infer<typeof corpusChunkSchema>;

/** A typed relation between two documents, mirroring `rag_links`. */
export const corpusLinkSchema = z.object({
  sourceDocId: z.string(),
  targetDocId: z.string(),
  relation: z.enum(["documents", "limits", "derived_from", "requests_records_from", "published_in"]),
});

export type CorpusLink = z.infer<typeof corpusLinkSchema>;

/** Postings for one term: pairs of `[chunkIndex, termFrequency]`. */
const postingsSchema = z.array(z.tuple([z.number().int().min(0), z.number().int().min(1)]));

/** The committed, key-free retrieval index. */
export const ragIndexSchema = z.object({
  schemaVersion: z.literal("oracle.rag-index.v1"),
  county: z.string(),
  builtFrom: z.object({
    runId: z.string().nullable(),
    rootCid: z.string().nullable(),
  }),
  /** Identifies the retrieval model so a stale index is detectable. */
  embedding: z.object({
    model: z.literal("lsa-tfidf-svd"),
    dimension: z.number().int().min(1),
    version: z.string(),
  }),
  chunks: z.array(corpusChunkSchema),
  links: z.array(corpusLinkSchema),
  lexical: z.object({
    /** Total tokens per chunk, used by BM25 length normalisation. */
    lengths: z.array(z.number().int().min(0)),
    averageLength: z.number(),
    postings: z.record(postingsSchema),
  }),
  /** Left singular vectors, one row per chunk. */
  singularVectors: z.array(z.array(z.number())),
  /** Singular values, one per latent dimension. */
  singularValues: z.array(z.number()),
  /** L2-normalised latent vector per chunk, in the same space a query folds into. */
  chunkVectors: z.array(z.array(z.number())),
});

export type RagIndex = z.infer<typeof ragIndexSchema>;

/** How much the retriever trusts its own top result. */
export const CONFIDENCE_BANDS = ["high", "moderate", "low", "none"] as const;
export type Confidence = (typeof CONFIDENCE_BANDS)[number];

/** One scored hit. */
export interface RetrievedChunk {
  id: string;
  docId: string;
  docType: DocType;
  title: string;
  headingPath: string[];
  text: string;
  /** Combined score in [0, 1]. */
  score: number;
  /** The signals behind `score`, kept so a low result can be explained. */
  signals: {
    lexical: number;
    semantic: number;
    alias: number;
    phrase: number;
    overlap: number;
  };
  metadata: Record<string, string>;
  provenance: Provenance;
}

/** What a retrieval call returns. */
export interface RetrievalResult {
  query: string;
  /** Tokens actually scored, after normalisation and alias expansion. */
  expandedTerms: string[];
  confidence: Confidence;
  /** True when nothing cleared the floor and the caller must say so. */
  abstained: boolean;
  /** Plain-language reason, always present so a caller can quote it. */
  note: string;
  chunks: RetrievedChunk[];
  /** Chunks that were scored but fell below the floor, for debugging only. */
  consideredCount: number;
  index: {
    chunkCount: number;
    runId: string | null;
    rootCid: string | null;
    embeddingModel: string;
    embeddingDimension: number;
  };
}

/** Retrieval request options. */
export const retrievalOptionsSchema = z.object({
  query: z.string().trim().min(2).max(500),
  topK: z.number().int().min(1).max(20).default(5),
  /** Restrict to these document families. */
  docTypes: z.array(z.enum(DOC_TYPES)).optional(),
  /** Override the abstention floor. Defaults to the calibrated value. */
  minScore: z.number().min(0).max(1).optional(),
});

export type RetrievalOptions = z.infer<typeof retrievalOptionsSchema>;
