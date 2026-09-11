/**
 * Natural language to the published table's own filter contract.
 *
 * Retrieval indexed the dataset's *metadata* — column definitions, docs, sample
 * extracts — so a semantic question about the data was answered well and a
 * semantic question about the 215,806 parcels was not answered at all. BM25 over
 * a per-parcel text profile was tried first and was worse than nothing: "aged
 * roof with an open roofing permit in Clermont" returned a Clermont parcel with
 * zero open roofing permits, because a bag of words cannot honour a constraint.
 *
 * So constraints are resolved structurally against the filter contract the query
 * layer already exposes, and only the leftover words are treated as free text.
 * Every filter carries the phrase that produced it, so the interpretation is
 * shown rather than guessed at.
 */
import { describe, expect, it } from "vitest";
import { interpretParcelQuery } from "../src/parcels/interpret.js";

const VOCAB = {
  cities: ["CLERMONT", "LEESBURG", "MOUNT DORA", "THE VILLAGES", "EUSTIS"],
  propertyTypes: ["SingleFamily", "Commercial", "MobileHome"],
};

/** Filters only, for terse assertions. */
const filtersOf = (text: string) => interpretParcelQuery(text, VOCAB).filters;

describe("interpretParcelQuery", () => {
  it("reads an explicit roof-age threshold", () => {
    expect(filtersOf("roofs 20 years or older")).toMatchObject({ minRoofAge: 20 });
    expect(filtersOf("roof older than 30 years")).toMatchObject({ minRoofAge: 30 });
    expect(filtersOf("roofs over 25 years")).toMatchObject({ minRoofAge: 25 });
  });

  it("treats a bare 'aged roof' as the documented 15-year threshold", () => {
    expect(filtersOf("aged roofs")).toMatchObject({ minRoofAge: 15 });
  });

  it("reads open roofing permits", () => {
    expect(filtersOf("parcels with an open roofing permit")).toMatchObject({
      hasOpenRoofingPermit: true,
    });
  });

  it("reads a stalled permit as a day threshold", () => {
    expect(filtersOf("roofing permits still open more than five years")).toMatchObject({
      minOpenRoofingPermitDays: 1825,
    });
  });

  it("keeps the generic duration field for a non-roofing permit query", () => {
    expect(filtersOf("permits open more than five years")).toMatchObject({
      minOpenPermitDays: 1825,
    });
  });

  it("reads owner locality", () => {
    expect(filtersOf("out of state owners")).toMatchObject({ ownerOutOfState: true });
    expect(filtersOf("absentee owners outside the county")).toMatchObject({
      ownerOutOfCounty: true,
    });
  });

  it("matches a city from the roll's own vocabulary, including a two-word city", () => {
    expect(filtersOf("aged roofs in Clermont")).toMatchObject({ city: "CLERMONT" });
    expect(filtersOf("old roofs in Mount Dora")).toMatchObject({ city: "MOUNT DORA" });
  });

  it("does not invent a city that is not in the roll", () => {
    expect(filtersOf("aged roofs in Orlando").city).toBeUndefined();
  });

  it("reads a money threshold written the way people write it", () => {
    expect(filtersOf("worth more than $300k")).toMatchObject({ minMarketValue: 300_000 });
    expect(filtersOf("market value over $1.5m")).toMatchObject({ minMarketValue: 1_500_000 });
  });

  it("reads a built-year bound", () => {
    expect(filtersOf("built before 1990")).toMatchObject({ maxBuiltYear: 1989 });
  });

  it("reads the remaining flags", () => {
    expect(filtersOf("parcels with no recorded sale")).toMatchObject({ noRecordedSale: true });
    expect(filtersOf("properties with a business account")).toMatchObject({
      hasBusinessAccount: true,
    });
  });

  it("combines every constraint in one question", () => {
    expect(
      filtersOf("aged roofs with an open roofing permit in Clermont owned out of state"),
    ).toMatchObject({
      minRoofAge: 15,
      hasOpenRoofingPermit: true,
      city: "CLERMONT",
      ownerOutOfState: true,
    });
  });

  it("explains itself: every filter names the phrase that produced it", () => {
    const result = interpretParcelQuery("aged roofs in Clermont", VOCAB);
    expect(result.interpretation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filter: "minRoofAge", phrase: expect.stringMatching(/aged/i) }),
        expect.objectContaining({ filter: "city", phrase: expect.stringMatching(/clermont/i) }),
      ]),
    );
  });

  it("keeps the roofing filter when the stalled-permit phrase is also present", () => {
    // The named acceptance query. Matching the stalled phrase used to consume
    // the word "open", so the roofing check never fired and the answer widened
    // from 2 parcels to 20 — silently, which is worse than failing.
    expect(filtersOf("roofing permits still open more than five years")).toMatchObject({
      minOpenRoofingPermitDays: 1825,
      hasOpenRoofingPermit: true,
    });
    expect(filtersOf("parcels with roofing permits open more than 5 years")).toMatchObject({
      minOpenRoofingPermitDays: 1825,
      hasOpenRoofingPermit: true,
    });
  });

  it("does not leak auxiliary verbs into the free-text term", () => {
    // "been" survived as q:"been" and matched no address, so a correct question
    // returned zero rows.
    const result = interpretParcelQuery(
      "which parcels have roofing permits that have been open more than five years",
      VOCAB,
    );
    expect(result.filters.q).toBeUndefined();
    expect(result.filters).toMatchObject({
      minOpenRoofingPermitDays: 1825,
      hasOpenRoofingPermit: true,
    });
  });

  it("keeps unmatched words as free text rather than silently dropping them", () => {
    const result = interpretParcelQuery("aged roofs on Nicolette Court", VOCAB);
    expect(result.filters.q).toMatch(/nicolette/i);
  });

  it("does not silently invert a negated constraint", () => {
    // "not in Clermont" used to produce { city: "CLERMONT" } — the exact
    // complement of what was asked, returned with full confidence. The filter
    // contract has no NOT, so the honest move is to decline the parcel half
    // rather than answer the opposite question.
    const result = interpretParcelQuery("aged roofs not in Clermont", VOCAB);
    expect(result.filters.city).toBeUndefined();
    expect(result.answersAboutParcels).toBe(false);
    expect(result.declined).toMatch(/negat/i);
  });

  it("declines rather than guessing when the question excludes a place", () => {
    for (const q of [
      "aged roofs outside Clermont",
      "parcels other than Clermont",
      "aged roofs excluding Clermont",
      "roofs that are not in Mount Dora",
    ]) {
      expect(interpretParcelQuery(q, VOCAB).answersAboutParcels).toBe(false);
    }
  });

  it("leaves ordinary questions untouched", () => {
    expect(interpretParcelQuery("aged roofs in Clermont", VOCAB).answersAboutParcels).toBe(true);
    // "no recorded sale" is a documented flag, not a negation of a constraint.
    expect(filtersOf("parcels with no recorded sale")).toMatchObject({ noRecordedSale: true });
  });

  it("shows the free-text term in the interpretation, because it filters", () => {
    // `q` is applied as a LIKE against the address. It used to be set without
    // ever appearing in the interpretation, so "aged roofs on Nicolette Court"
    // returned zero rows while the panel showed only the roof-age filter — a
    // silent filter is worse than a wrong one, because nothing on screen
    // explains the zero.
    const result = interpretParcelQuery("aged roofs on Nicolette Court", VOCAB);
    expect(result.filters.q).toMatch(/nicolette/i);
    expect(result.interpretation.map((entry) => entry.filter)).toContain("q");
    const term = result.interpretation.find((entry) => entry.filter === "q");
    expect(term?.value).toMatch(/nicolette/i);
  });

  it("returns no filters for a question about the data rather than the parcels", () => {
    const result = interpretParcelQuery("why is contractor_name empty", VOCAB);
    // A leftover free-text term is recorded (it would filter, so it must be
    // visible) but never on its own makes this a question about the parcels.
    expect(result.answersAboutParcels).toBe(false);
    expect(result.interpretation.every((entry) => entry.filter === "q")).toBe(true);
  });

  it("marks a constrained question as answerable over the parcels", () => {
    expect(interpretParcelQuery("aged roofs in Clermont", VOCAB).answersAboutParcels).toBe(true);
  });
});
