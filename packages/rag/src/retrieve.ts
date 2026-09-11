/**
 * The retrieval pipeline.
 *
 * Ordered exactly as `build-rag-systems` prescribes: normalise, filter, match
 * deterministic aliases, score lexically, score semantically, rerank, combine,
 * then apply the threshold policy. The top vector hit is never treated as
 * automatically correct, and a question the corpus cannot answer returns an
 * abstention with a reason rather than the nearest irrelevant chunk.
 *
 * Four signals feed one score:
 *
 * - `lexical`  BM25 over the postings list. Refuses documents with no shared
 *              vocabulary, which is what makes abstention possible.
 * - `semantic` cosine in the latent space. Bridges vocabulary gaps.
 * - `alias`    deterministic whole-phrase match against an entity's aliases.
 *              A question that names `roof_age_basis` or "Groveland" must
 *              surface that document whatever the statistics prefer.
 * - `phrase`   exact multi-word phrase present in the chunk text.
 *
 * A chunk that matched *nothing the user actually typed* — no typed term, no
 * alias — is discounted hard, because that is precisely the shape of a latent
 * false positive.
 */

import { aliasScore, expandQuery } from "./aliases.js";
import { scoreLexical } from "./index/bm25.js";
import { cosine, idfOf, normalizeSparse, projectQuery, type SparseRow } from "./index/lsa.js";
import { loadIndex, type LoadedIndex } from "./index/load.js";
import { normalize, tokenize } from "./text.js";
import {
  retrievalOptionsSchema,
  type Confidence,
  type RetrievalOptions,
  type RetrievalResult,
  type RetrievedChunk,
} from "./types.js";

/** Signal weights. Calibrated against the evaluation set in `src/eval/`. */
export const WEIGHTS = Object.freeze({
  lexical: 0.42,
  semantic: 0.24,
  alias: 0.14,
  title: 0.12,
  phrase: 0.08,
});

/** Multiplier applied to a chunk that matched no typed term and no alias. */
export const UNGROUNDED_PENALTY = 0.3;

/**
 * How hard an ungrounded *question* is damped.
 *
 * The single most reliable out-of-domain signal is not the score of the best
 * chunk; it is how many of the words the user typed exist anywhere in the
 * corpus at all. "median household income" and "key lime pie" both contain a
 * word this corpus knows ("county", "key") and several it has never seen, and
 * without this damper the known word alone is enough to produce a confident
 * answer about county_name or alt_key. Raising grounding to a power above 1
 * makes a partly-unknown question fall away fast while a fully known one is
 * untouched.
 */
export const GROUNDING_EXPONENT = 1.5;

/** Confidence thresholds, calibrated against the evaluation set. */
export const THRESHOLDS = Object.freeze({
  /** At or above this the answer is well supported. */
  high: 0.42,
  /** At or above this the evidence is plausible and should be shown with care. */
  moderate: 0.29,
  /**
   * Below this the retriever abstains: there is no document for the question.
   *
   * Calibrated on the evaluation set, where the best-scoring unanswerable
   * question reaches 0.221 and the weakest answerable one reaches 0.299. The
   * floor sits between them, and that margin is thin enough to be worth
   * re-measuring whenever the corpus changes.
   */
  floor: 0.23,
});

/** At most this many chunks from one document, so results stay diverse. */
export const MAX_CHUNKS_PER_DOC = 2;

/** Band a combined score. */
export function bandOf(score: number): Confidence {
  if (score >= THRESHOLDS.high) return "high";
  if (score >= THRESHOLDS.moderate) return "moderate";
  if (score >= THRESHOLDS.floor) return "low";
  return "none";
}

/** Longest typed word sequence, used for the exact-phrase signal. */
function phrases(query: string): string[] {
  const words = normalize(query)
    .replace(/[^a-z0-9_ ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
  const out: string[] = [];
  for (let size = Math.min(4, words.length); size >= 2; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      out.push(words.slice(start, start + size).join(" "));
    }
  }
  return out;
}

/** Build the query's sparse TF-IDF row in the index's term space. */
function queryRow(
  index: LoadedIndex,
  terms: readonly { term: string; weight: number }[],
): SparseRow {
  const row: SparseRow = new Map();
  const chunkCount = index.raw.chunks.length;
  for (const { term, weight } of terms) {
    const column = index.termIndex.get(term);
    const postings = index.lexical.postings.get(term);
    if (column === undefined || !postings) continue;
    row.set(column, weight * idfOf(chunkCount, postings.length));
  }
  return normalizeSparse(row);
}

/** Run the full pipeline. */
export function retrieve(
  options: RetrievalOptions,
  index: LoadedIndex = loadIndex(),
): RetrievalResult {
  const parsed: RetrievalOptions = retrievalOptionsSchema.parse(options);
  const { raw } = index;

  // 1. Normalise and expand.
  const terms = expandQuery(parsed.query);
  const typedTerms = [...new Set(tokenize(parsed.query))];
  const queryPhrases = phrases(parsed.query);

  // 1b. Out-of-domain check. A term the corpus has never seen anywhere is the
  // strongest available evidence that the question is not about this dataset.
  const knownTerms = typedTerms.filter((term) => index.lexical.postings.has(term));
  const unknownTerms = typedTerms.filter((term) => !index.lexical.postings.has(term));
  const queryGrounding = typedTerms.length === 0 ? 0 : knownTerms.length / typedTerms.length;
  const groundingDamper = Math.pow(queryGrounding, GROUNDING_EXPONENT);

  // 2. Metadata filter.
  const allowed = parsed.docTypes && parsed.docTypes.length > 0 ? new Set(parsed.docTypes) : null;

  // 3-5. Lexical, semantic and deterministic alias signals.
  const lexical = scoreLexical(index.lexical, terms);
  const projected = projectQuery(
    queryRow(index, terms),
    index.rows,
    raw.singularVectors,
    raw.singularValues,
  );

  const scored: RetrievedChunk[] = [];
  for (let position = 0; position < raw.chunks.length; position += 1) {
    const chunk = raw.chunks[position];
    if (!chunk) continue;
    if (allowed && !allowed.has(chunk.docType)) continue;

    const semantic = Math.max(0, cosine(projected, raw.chunkVectors[position] ?? []));
    const lexicalScore = lexical.scores[position] ?? 0;
    const overlap = lexical.overlap[position] ?? 0;
    const alias = aliasScore(parsed.query, chunk.aliases);
    const haystack = normalize(chunk.textForEmbedding);
    const phrase = queryPhrases.some((candidate) => haystack.includes(candidate)) ? 1 : 0;

    // A title match is worth more than a body match: a document titled
    // "Data source: Lake County CD Plus permit layer" is what a question about
    // that layer wants, not the forty column documents that merely cite it.
    const titleTerms = new Set(tokenize(chunk.title));
    const titleHits = knownTerms.filter((term) => titleTerms.has(term)).length;
    const titleScore = knownTerms.length === 0 ? 0 : titleHits / knownTerms.length;

    let score =
      WEIGHTS.lexical * lexicalScore +
      WEIGHTS.semantic * semantic +
      WEIGHTS.alias * alias +
      WEIGHTS.title * titleScore +
      WEIGHTS.phrase * phrase;

    // 6. Rerank: a latent-only hit is the shape of a false positive, and an
    // ungrounded question must not produce a confident answer from anything.
    if (overlap === 0 && alias === 0) score *= UNGROUNDED_PENALTY;
    score *= groundingDamper;

    if (score <= 0) continue;
    scored.push({
      id: chunk.id,
      docId: chunk.docId,
      docType: chunk.docType,
      title: chunk.title,
      headingPath: chunk.headingPath,
      text: chunk.textForContext,
      score: Math.round(Math.min(1, score) * 1e4) / 1e4,
      signals: {
        lexical: Math.round(lexicalScore * 1e4) / 1e4,
        semantic: Math.round(semantic * 1e4) / 1e4,
        alias: Math.round(alias * 1e4) / 1e4,
        title: Math.round(titleScore * 1e4) / 1e4,
        phrase,
        overlap: Math.round(overlap * 1e4) / 1e4,
      },
      metadata: chunk.metadata,
      provenance: chunk.provenance,
    });
  }

  scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  // Diversity: one document must not fill the whole answer.
  const perDoc = new Map<string, number>();
  const diverse: RetrievedChunk[] = [];
  for (const candidate of scored) {
    const seen = perDoc.get(candidate.docId) ?? 0;
    if (seen >= MAX_CHUNKS_PER_DOC) continue;
    perDoc.set(candidate.docId, seen + 1);
    diverse.push(candidate);
  }

  // 7-8. Threshold policy.
  const floor = parsed.minScore ?? THRESHOLDS.floor;
  const kept = diverse.filter((candidate) => candidate.score >= floor).slice(0, parsed.topK);
  const top = kept[0]?.score ?? 0;
  const confidence = kept.length === 0 ? "none" : bandOf(top);

  const note =
    kept.length === 0
      ? `No document in the Lake County retrieval corpus answers this. ${
          typedTerms.length === 0
            ? "The question contained no searchable terms."
            : unknownTerms.length > 0
              ? `The corpus has never seen ${unknownTerms.length === typedTerms.length ? "any" : "some"} of the terms in it (${unknownTerms.slice(0, 6).join(", ")}), and nothing scored above the ${floor} confidence floor.`
              : `Nothing scored above the ${floor} confidence floor.`
        } Say so plainly rather than offering the nearest chunk.`
      : confidence === "high"
        ? "Strong match: the top chunk shares vocabulary and latent context with the question."
        : confidence === "moderate"
          ? "Plausible match. Quote it only with its source named, and say it may not be the document the question is about."
          : "Weak match. Treat this as a pointer, not an answer, and say the corpus may not cover the question.";

  return {
    query: parsed.query,
    expandedTerms: terms.map((term) => term.term),
    queryGrounding: Math.round(queryGrounding * 1e4) / 1e4,
    unknownTerms,
    confidence,
    abstained: kept.length === 0,
    note,
    chunks: kept,
    consideredCount: scored.length,
    index: {
      chunkCount: raw.chunks.length,
      runId: raw.builtFrom.runId,
      rootCid: raw.builtFrom.rootCid,
      releaseState: raw.builtFrom.releaseState,
      snapshotDigest: raw.builtFrom.snapshotDigest,
      embeddingModel: raw.embedding.model,
      embeddingDimension: raw.embedding.dimension,
    },
  };
}
