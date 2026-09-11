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

  it("records that NAICS and names are now carried, and how many match", () => {
    expect(BUSINESS_VIEW_NOTE).toMatch(/business_naics_codes/);
    expect(BUSINESS_VIEW_NOTE).toMatch(/business_names/);
    expect(BUSINESS_VIEW_NOTE).toContain("44 roofing contractors");
    expect(BUSINESS_VIEW_NOTE).toMatch(/\b10\b/);
  });

  it("says why Sunbiz is absent without blaming the wrong endpoint", () => {
    // The note used to say "Sunbiz search answers HTTP 403". Measured with a
    // real browser, that search is reachable — and it is not the ingest channel
    // either. The bulk portal is the challenged one.
    expect(BUSINESS_VIEW_NOTE).toMatch(/bulk data-download portal/i);
    expect(BUSINESS_VIEW_NOTE).not.toMatch(/Sunbiz search answers HTTP 403/i);
  });
});

describe("CONTRACTOR_VIEW_NOTE", () => {
  it("says the gated columns stay null rather than being guessed", () => {
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/403/);
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/null/);
  });

  it("names the one jurisdiction that publishes a contractor, and its bounds", () => {
    // The note said both columns were permanently null until Clermont's
    // eTRAKiT portal was harvested. Naming Clermont without naming the
    // denominator would trade an understatement for an overstatement.
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/Clermont/);
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/fifteen jurisdictions/i);
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/never read a non-zero contractor count/i);
    expect(CONTRACTOR_VIEW_NOTE).not.toMatch(/[Bb]oth columns are published and stay null/);
  });

  it("distinguishes the two kinds of null contractor_name carries", () => {
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/contractor_gated_403/);
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/contractor_absent_on_permit/);
  });

  it("separates the technical block from the policy one", () => {
    // Verified with a real browser: the county permit pages are 403 to every
    // method tried, while a BBB profile loads. BBB is withheld because the
    // kit's bbb-harvest skill forbids working around the block, not because it
    // cannot be reached — and conflating the two overstates one and
    // understates the other.
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/robots\.txt/i);
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/official BBB API/i);
    expect(CONTRACTOR_VIEW_NOTE).toMatch(/permit detail pages/i);
  });
});
