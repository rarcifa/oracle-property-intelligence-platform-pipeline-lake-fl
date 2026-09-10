/**
 * Okapi BM25 over the committed postings list.
 *
 * BM25 is the deterministic half of the hybrid: it is the signal that refuses
 * to match a document sharing no vocabulary with the question, which is exactly
 * the property an abstaining retriever needs. The latent-semantic half is
 * permissive by design and would happily return a nearest neighbour for a
 * question about nothing in the corpus; BM25 is what stops it.
 */

import type { WeightedTerm } from "../aliases.js";

/** Standard term-frequency saturation. */
export const K1 = 1.2;
/** Standard length normalisation. */
export const B = 0.75;
/**
 * Raw BM25 is unbounded, and a score normalised against the best hit in the
 * candidate set is always 1.0 for the top hit — which destroys the ability to
 * abstain. Saturating against a fixed constant keeps the scale absolute.
 */
export const SATURATION = 9;

export interface LexicalIndex {
  /** Term to `[chunkIndex, termFrequency]` pairs. */
  postings: Map<string, [number, number][]>;
  lengths: number[];
  averageLength: number;
  chunkCount: number;
}

/** BM25 inverse document frequency. */
export function bm25Idf(chunkCount: number, documentFrequency: number): number {
  return Math.log(1 + (chunkCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

export interface LexicalScores {
  /** Saturated score in [0, 1) per chunk index. */
  scores: number[];
  /** Fraction of the typed query terms each chunk actually contains. */
  overlap: number[];
}

/**
 * Score every chunk against the weighted query terms.
 *
 * `overlap` counts only terms the user actually typed (weight 1). An expanded
 * term proving present is useful for ranking but must not be read as evidence
 * that the chunk is about what was asked.
 */
export function scoreLexical(index: LexicalIndex, terms: readonly WeightedTerm[]): LexicalScores {
  const raw = new Array<number>(index.chunkCount).fill(0);
  const typedHits = new Array<number>(index.chunkCount).fill(0);
  const typedTerms = terms.filter((term) => term.weight >= 1);
  const typedSeen = new Set<string>();

  for (const { term, weight } of terms) {
    const postings = index.postings.get(term);
    if (!postings || postings.length === 0) continue;
    const idf = bm25Idf(index.chunkCount, postings.length);
    const typed = weight >= 1;
    if (typed && typedSeen.has(term)) continue;
    if (typed) typedSeen.add(term);

    for (const [chunkIndex, frequency] of postings) {
      const length = index.lengths[chunkIndex] ?? index.averageLength;
      const denominator = frequency + K1 * (1 - B + (B * length) / (index.averageLength || 1));
      raw[chunkIndex] =
        (raw[chunkIndex] as number) + weight * idf * ((frequency * (K1 + 1)) / denominator);
      if (typed) typedHits[chunkIndex] = (typedHits[chunkIndex] as number) + 1;
    }
  }

  const distinctTyped = new Set(typedTerms.map((term) => term.term)).size;
  return {
    scores: raw.map((value) => value / (value + SATURATION)),
    overlap: typedHits.map((hits) => (distinctTyped === 0 ? 0 : hits / distinctTyped)),
  };
}
