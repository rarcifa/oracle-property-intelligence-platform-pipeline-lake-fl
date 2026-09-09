/**
 * Deterministic text normalisation.
 *
 * The same tokenizer runs over corpus text at build time and over the query at
 * request time, which is the only way a lexical index and a latent-semantic
 * projection can agree on what a term is. Every step here is pure and
 * dependency-free so the committed index is reproducible byte for byte.
 */

import { createHash } from "node:crypto";

/**
 * Words carrying no retrieval signal in this corpus. Deliberately short:
 * an over-eager stop list removes exactly the words that make a question a
 * question ("why", "how", "which"), and those are the questions this corpus
 * exists to answer.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by", "for", "from", "had",
  "has", "have", "if", "in", "into", "is", "it", "its", "of", "on", "or", "over", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those", "to", "was", "were", "with",
  "i", "we", "you", "me", "my", "our", "your", "do", "does", "did", "can", "could", "would",
  "should", "will", "shall", "may", "might", "must", "am", "so", "than", "too", "very", "just",
  "about", "any", "all", "each", "more", "most", "other", "some", "such", "only", "own", "same",
]);

/** True when a token is a stopword. Exported so tests can pin the list. */
export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/**
 * A conservative suffix stemmer.
 *
 * Full Porter stemming conflates terms this corpus needs to keep apart
 * (`permit` / `permitting` is fine, `parcel` / `parcels` is fine, but
 * `sales` / `sale` matters and `gated` / `gate` does not). These five rules
 * cover the plural and participle variation actually present in the questions
 * and leave everything else alone.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (token.endsWith("ss")) return token;
  if (token.endsWith("s") && !token.endsWith("us") && !token.endsWith("is")) return token.slice(0, -1);
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  return token;
}

/** Lowercase and collapse everything that is not a word character. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―‘’“”]/g, (match) =>
      match === "‘" || match === "’" ? "'" : match === "“" || match === "”" ? '"' : "-",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split normalised text into scored terms.
 *
 * Snake-case identifiers are emitted whole *and* split, because a question can
 * name a column either way ("roof_age_basis" or "roof age basis") and both must
 * hit the same document.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const raw = normalize(text).split(/[^a-z0-9_]+/);
  for (const piece of raw) {
    if (piece.length === 0) continue;
    if (piece.includes("_")) {
      out.push(piece);
      for (const part of piece.split("_")) {
        if (part.length > 0) out.push(part);
      }
      continue;
    }
    out.push(piece);
  }
  const terms: string[] = [];
  for (const token of out) {
    if (token.length < 2 && !/^[0-9]$/.test(token)) continue;
    if (isStopword(token)) continue;
    terms.push(token.includes("_") ? token : stem(token));
  }
  return terms;
}

/** Count how often each term occurs. */
export function termCounts(terms: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

/** Short, stable content hash used as the chunk's `sourceHash`. */
export function shortHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

/** Collapse whitespace for display without destroying paragraph breaks. */
export function tidy(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
