/**
 * Public surface of the Lake County retrieval package.
 *
 * Query-time only, deliberately. Corpus construction (`corpus/build.ts`) parses
 * YAML and walks the repository tree, and nothing that serves a request needs
 * either, so it stays reachable through the CLI and the tests but out of this
 * entry point. That keeps the server's import graph — and any deployment bundle
 * built from it — free of build-only dependencies.
 */

export { retrieve, THRESHOLDS, WEIGHTS, bandOf, MAX_CHUNKS_PER_DOC } from "./retrieve.js";
export { loadIndex, prepareIndex, resetIndexCache, type LoadedIndex } from "./index/load.js";
export { INDEX_PATH, PACKAGE_ROOT } from "./index/paths.js";
export { assertIndexCompatibleWithRun, type ServedRunIdentity } from "./compatibility.js";
export { runEval, type EvalReport, type CaseResult } from "./eval/run-eval.js";
export { EVAL_CASES, POSITIVE_CASES, NEGATIVE_CASES, type EvalCase } from "./eval/questions.js";
export { expandQuery, aliasScore, QUERY_EXPANSIONS } from "./aliases.js";
export { suggestPaths, pathOptionsSchema, type PathResult, type PathSuggestion } from "./paths.js";
export { tokenize, normalize, stem, shortHash } from "./text.js";
export {
  interpretParcelQuery,
  DEFAULT_AGED_ROOF_YEARS,
  type InterpretedParcelQuery,
  type InterpretedFilter,
  type ParcelVocabulary,
} from "./parcels/interpret.js";
export {
  DOC_TYPES,
  CONFIDENCE_BANDS,
  corpusChunkSchema,
  ragIndexSchema,
  retrievalOptionsSchema,
  type Confidence,
  type CorpusChunk,
  type CorpusLink,
  type DocType,
  type Provenance,
  type RagIndex,
  type RetrievalOptions,
  type RetrievalResult,
  type RetrievedChunk,
} from "./types.js";
