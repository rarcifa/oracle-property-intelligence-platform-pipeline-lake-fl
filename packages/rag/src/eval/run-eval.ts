/**
 * Evaluation harness.
 *
 * Reports precision at k in two forms, because only reporting one of them would
 * be misleading. Strict precision divides by k, which a question with a single
 * relevant document can never score above 1/k. Normalised precision divides by
 * the number of relevant documents that could fit in k, which is the number
 * worth calibrating thresholds against. Hit rate and MRR are reported too, and
 * the negative cases are scored on whether the retriever abstained.
 */

import { retrieve } from "../retrieve.js";
import { loadIndex, type LoadedIndex } from "../index/load.js";
import { EVAL_CASES, NEGATIVE_CASES, POSITIVE_CASES, type EvalCase } from "./questions.js";
import type { Confidence } from "../types.js";

export interface CaseResult {
  id: string;
  question: string;
  expected: string[];
  retrieved: string[];
  confidence: Confidence;
  abstained: boolean;
  topScore: number;
  /** 1 when the top document is relevant. */
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  precisionAt1: number;
  precisionAt3: number;
  precisionAt5: number;
  normalisedPrecisionAt3: number;
  normalisedPrecisionAt5: number;
  reciprocalRank: number;
  /** For negative cases: did it correctly refuse? */
  correctlyAbstained: boolean | null;
}

function evaluateCase(entry: EvalCase, index: LoadedIndex): CaseResult {
  const result = retrieve({ query: entry.question, topK: 5 }, index);
  const retrieved: string[] = [];
  for (const chunk of result.chunks) {
    if (!retrieved.includes(chunk.docId)) retrieved.push(chunk.docId);
  }
  const expected = new Set(entry.expected);
  const relevantAt = (k: number): number =>
    retrieved.slice(0, k).filter((doc) => expected.has(doc)).length;

  const rank = retrieved.findIndex((doc) => expected.has(doc));
  const isNegative = entry.expected.length === 0;

  return {
    id: entry.id,
    question: entry.question,
    expected: entry.expected,
    retrieved,
    confidence: result.confidence,
    abstained: result.abstained,
    topScore: result.chunks[0]?.score ?? 0,
    hitAt1: relevantAt(1) > 0 ? 1 : 0,
    hitAt3: relevantAt(3) > 0 ? 1 : 0,
    hitAt5: relevantAt(5) > 0 ? 1 : 0,
    precisionAt1: relevantAt(1) / 1,
    precisionAt3: relevantAt(3) / 3,
    precisionAt5: relevantAt(5) / 5,
    normalisedPrecisionAt3: relevantAt(3) / Math.min(3, Math.max(1, entry.expected.length)),
    normalisedPrecisionAt5: relevantAt(5) / Math.min(5, Math.max(1, entry.expected.length)),
    reciprocalRank: rank >= 0 ? 1 / (rank + 1) : 0,
    correctlyAbstained: isNegative ? result.abstained : null,
  };
}

export interface EvalReport {
  cases: CaseResult[];
  positives: {
    count: number;
    precisionAt1: number;
    precisionAt3: number;
    precisionAt5: number;
    normalisedPrecisionAt3: number;
    normalisedPrecisionAt5: number;
    hitAt1: number;
    hitAt3: number;
    hitAt5: number;
    meanReciprocalRank: number;
  };
  negatives: {
    count: number;
    /** Fraction of unanswerable questions the retriever refused to answer. */
    abstentionRate: number;
    /** Negative cases that returned any answer at all. Should be zero. */
    falseHighConfidence: string[];
  };
}

const mean = (values: number[]): number =>
  values.length === 0
    ? 0
    : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1e4) / 1e4;

/** Run every evaluation case and summarise. */
export function runEval(index: LoadedIndex = loadIndex()): EvalReport {
  const cases = EVAL_CASES.map((entry) => evaluateCase(entry, index));
  const positives = cases.filter((entry) => entry.expected.length > 0);
  const negatives = cases.filter((entry) => entry.expected.length === 0);

  return {
    cases,
    positives: {
      count: POSITIVE_CASES.length,
      precisionAt1: mean(positives.map((entry) => entry.precisionAt1)),
      precisionAt3: mean(positives.map((entry) => entry.precisionAt3)),
      precisionAt5: mean(positives.map((entry) => entry.precisionAt5)),
      normalisedPrecisionAt3: mean(positives.map((entry) => entry.normalisedPrecisionAt3)),
      normalisedPrecisionAt5: mean(positives.map((entry) => entry.normalisedPrecisionAt5)),
      hitAt1: mean(positives.map((entry) => entry.hitAt1)),
      hitAt3: mean(positives.map((entry) => entry.hitAt3)),
      hitAt5: mean(positives.map((entry) => entry.hitAt5)),
      meanReciprocalRank: mean(positives.map((entry) => entry.reciprocalRank)),
    },
    negatives: {
      count: NEGATIVE_CASES.length,
      abstentionRate: mean(negatives.map((entry) => (entry.correctlyAbstained ? 1 : 0))),
      falseHighConfidence: negatives.filter((entry) => !entry.abstained).map((entry) => entry.id),
    },
  };
}
