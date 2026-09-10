/**
 * Confidence-policy tests.
 *
 * A retriever that always returns its nearest neighbour is worse than no
 * retriever, because it launders a guess into a citation. These tests pin the
 * behaviour that stops that: the out-of-domain damper, the floor, the bands, and
 * the fact that an abstention comes back with a usable explanation rather than
 * an empty list and no reason.
 */

import { describe, expect, it } from "vitest";
import { loadIndex } from "../src/index/load.js";
import { bandOf, retrieve, THRESHOLDS } from "../src/retrieve.js";
import { NEGATIVE_CASES } from "../src/eval/questions.js";

const index = loadIndex();

describe("thresholds", () => {
  it("are ordered and inside the unit interval", () => {
    expect(THRESHOLDS.floor).toBeGreaterThan(0);
    expect(THRESHOLDS.floor).toBeLessThan(THRESHOLDS.moderate);
    expect(THRESHOLDS.moderate).toBeLessThan(THRESHOLDS.high);
    expect(THRESHOLDS.high).toBeLessThan(1);
  });

  it("band the score at the documented boundaries", () => {
    expect(bandOf(THRESHOLDS.high)).toBe("high");
    expect(bandOf(THRESHOLDS.moderate)).toBe("moderate");
    expect(bandOf(THRESHOLDS.floor)).toBe("low");
    expect(bandOf(THRESHOLDS.floor - 0.001)).toBe("none");
  });
});

describe("abstention", () => {
  it.each(NEGATIVE_CASES.map((entry) => [entry.id, entry.question] as const))(
    "refuses to answer %s",
    (_id, question) => {
      const result = retrieve({ query: question, topK: 5 }, index);
      expect(result.abstained).toBe(true);
      expect(result.chunks).toHaveLength(0);
      expect(result.confidence).toBe("none");
    },
  );

  it("explains an abstention instead of returning an empty result silently", () => {
    const result = retrieve({ query: "give me a recipe for key lime pie", topK: 5 }, index);
    expect(result.note).toContain("No document");
    expect(result.note).toMatch(/never seen/);
    expect(result.unknownTerms.length).toBeGreaterThan(0);
  });

  it("reports how much of the question the corpus even recognises", () => {
    const known = retrieve({ query: "why is contractor_name empty", topK: 3 }, index);
    const unknown = retrieve(
      { query: "median household income mortgage delinquency", topK: 3 },
      index,
    );
    expect(known.queryGrounding).toBe(1);
    expect(unknown.queryGrounding).toBeLessThan(0.6);
  });

  it("still abstains when a known entity is named but the question is not answerable", () => {
    const result = retrieve({ query: "will it rain in Tavares tomorrow", topK: 5 }, index);
    expect(result.abstained).toBe(true);
  });

  it("lets a caller raise the floor without changing the ranking", () => {
    const base = retrieve({ query: "how far back does the permit history go", topK: 5 }, index);
    const strict = retrieve(
      { query: "how far back does the permit history go", topK: 5, minScore: 0.9 },
      index,
    );
    expect(base.chunks.length).toBeGreaterThan(0);
    expect(strict.chunks).toHaveLength(0);
    expect(strict.abstained).toBe(true);
  });

  it("never bands a returned answer as none", () => {
    const result = retrieve({ query: "what is the ongoing infrastructure cost", topK: 5 }, index);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.confidence).not.toBe("none");
    for (const chunk of result.chunks) expect(chunk.score).toBeGreaterThanOrEqual(THRESHOLDS.floor);
  });
});
