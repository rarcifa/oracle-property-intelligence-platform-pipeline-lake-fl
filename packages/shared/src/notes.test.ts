/**
 * One definition, not two.
 *
 * The business and contractor notes were duplicated between the server and the
 * browser data source, each with a comment promising the wording matched. It
 * stopped matching the moment the business caveat was corrected: the fix landed
 * in the API and the README while the browser — the default data path, and so
 * the one a reader actually sees — kept serving the old text beside the
 * inflated total. These tests pin the corrected content.
 */
import { describe, expect, it } from "vitest";
import { BUSINESS_VIEW_NOTE, CONTRACTOR_VIEW_NOTE } from "./notes.js";

describe("BUSINESS_VIEW_NOTE", () => {
  it("states the measured coverage rather than implying the whole roll is loaded", () => {
    expect(BUSINESS_VIEW_NOTE).toContain("2,060");
    expect(BUSINESS_VIEW_NOTE).toContain("33,346");
    expect(BUSINESS_VIEW_NOTE).toContain("6.2%");
  });

  it("explains that the published total double counts shared addresses", () => {
    expect(BUSINESS_VIEW_NOTE).toContain("4,451");
    expect(BUSINESS_VIEW_NOTE).toMatch(/account-to-parcel matches/i);
  });

  it("records that NAICS is not carried, so the roofing contractors are absent", () => {
    expect(BUSINESS_VIEW_NOTE).toMatch(/NAICS/);
    expect(BUSINESS_VIEW_NOTE).toContain("44 roofing contractors");
  });

  it("keeps the Sunbiz gating statement", () => {
    expect(BUSINESS_VIEW_NOTE).toMatch(/403/);
  });
});

describe("CONTRACTOR_VIEW_NOTE", () => {
  it("says the gated columns stay null rather than being guessed", () => {
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/403/);
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/null/);
  });
});
