/**
 * Retrieval-quality tests.
 *
 * The evaluation set is the contract: if a change to chunking, weighting or the
 * alias table makes retrieval worse, these fail. The thresholds are set a little
 * below the measured numbers so ordinary corpus growth does not break the build,
 * but not so far below that a real regression slips through.
 */

import { describe, expect, it } from "vitest";
import { loadIndex } from "../src/index/load.js";
import { retrieve } from "../src/retrieve.js";
import { runEval } from "../src/eval/run-eval.js";
import { EVAL_CASES, NEGATIVE_CASES, POSITIVE_CASES } from "../src/eval/questions.js";

const index = loadIndex();
const report = runEval(index);

describe("evaluation set", () => {
  it("has at least fifteen answerable questions and a negative control group", () => {
    expect(POSITIVE_CASES.length).toBeGreaterThanOrEqual(15);
    expect(NEGATIVE_CASES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(EVAL_CASES.map((entry) => entry.id)).size).toBe(EVAL_CASES.length);
  });

  it("ranks the right document first for most questions", () => {
    expect(report.positives.precisionAt1).toBeGreaterThanOrEqual(0.85);
  });

  it("always surfaces a relevant document in the top three", () => {
    expect(report.positives.hitAt3).toBe(1);
  });

  it("keeps mean reciprocal rank high", () => {
    expect(report.positives.meanReciprocalRank).toBeGreaterThanOrEqual(0.9);
  });

  it("fills the top three with relevant documents where relevant documents exist", () => {
    expect(report.positives.normalisedPrecisionAt3).toBeGreaterThanOrEqual(0.8);
  });

  it("answers nothing it should not answer", () => {
    expect(report.negatives.abstentionRate).toBe(1);
    expect(report.negatives.falseHighConfidence).toEqual([]);
  });
});

describe("ranking behaviour", () => {
  it("routes a null-column question to that column's document", () => {
    const result = retrieve(
      { query: "why is contractor_name empty for every property", topK: 5 },
      index,
    );
    expect(result.chunks[0]?.docId).toBe("column:contractor_name");
    expect(result.confidence).toBe("high");
  });

  it("routes a named jurisdiction to that jurisdiction, not to a neighbour", () => {
    const result = retrieve(
      { query: "how do I request permit records from Leesburg", topK: 5 },
      index,
    );
    expect(result.chunks[0]?.docId).toBe("jurisdiction:leesburg");
    expect(result.chunks[0]?.text).toContain("Permits@leesburgflorida.gov");
  });

  it("prefers the source document over the columns that merely cite it", () => {
    const result = retrieve(
      { query: "what does the Lake County CD Plus permit layer cover", topK: 5 },
      index,
    );
    expect(result.chunks[0]?.docId).toBe("source:cdplus");
  });

  it("answers a derivation question with the basis column, not the value column alone", () => {
    const result = retrieve(
      { query: "how was roof age derived and what does the basis mean", topK: 5 },
      index,
    );
    const docs = result.chunks.map((chunk) => chunk.docId);
    expect(docs[0]).toBe("column:roof_age_basis");
    expect(docs).toContain("column:roof_age_years");
  });

  it("returns provenance with every hit", () => {
    const result = retrieve({ query: "which jurisdictions are blocked", topK: 3 }, index);
    for (const chunk of result.chunks) {
      expect(chunk.provenance.sourceFile.length).toBeGreaterThan(0);
      expect(chunk.score).toBeGreaterThan(0);
      expect(chunk.signals.lexical).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not let one document fill the whole answer", () => {
    const result = retrieve({ query: "permit history rolling window archive", topK: 6 }, index);
    const counts = new Map<string, number>();
    for (const chunk of result.chunks) counts.set(chunk.docId, (counts.get(chunk.docId) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(2);
  });

  it("honours a document-type filter", () => {
    const result = retrieve({ query: "permits", topK: 5, docTypes: ["jurisdiction"] }, index);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) expect(chunk.docType).toBe("jurisdiction");
  });

  it("matches a snake_case column name written as plain words", () => {
    const spaced = retrieve({ query: "what does roof age basis mean", topK: 3 }, index);
    const snake = retrieve({ query: "what does roof_age_basis mean", topK: 3 }, index);
    expect(spaced.chunks[0]?.docId).toBe("column:roof_age_basis");
    expect(snake.chunks[0]?.docId).toBe("column:roof_age_basis");
  });
});
