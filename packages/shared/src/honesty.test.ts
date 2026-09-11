/** Tests that a null column always carries its reason. */
import { describe, expect, it } from "vitest";
import {
  ALWAYS_NULL_COLUMNS,
  gatedFieldNotices,
  PARTIALLY_POPULATED_COLUMNS,
  parseEnrichmentStatus,
  TENURE_CAVEAT,
} from "./honesty.js";

const WITH_PERMITS = "permits_loaded;contractor_gated_403;bbb_gated_403";
const WITHOUT_PERMITS = "no_permits_in_source;contractor_gated_403;bbb_gated_403";
/** A Clermont parcel whose permit named a contractor: the column is populated. */
const CLERMONT_NAMED = "permits_loaded;contractor_from_clermont_etrakit;bbb_gated_403";
/** A Clermont parcel whose permits named nobody: an established absence. */
const CLERMONT_UNNAMED = "permits_loaded;contractor_absent_on_permit;bbb_gated_403";

describe("parseEnrichmentStatus", () => {
  it("decodes the permits-loaded status the pipeline writes", () => {
    const notices = parseEnrichmentStatus(WITH_PERMITS);
    expect(notices.map((notice) => notice.token)).toEqual([
      "permits_loaded",
      "contractor_gated_403",
      "bbb_gated_403",
    ]);
    expect(notices[0]?.severity).toBe("present");
  });

  it("decodes the no-permits status", () => {
    const notices = parseEnrichmentStatus(WITHOUT_PERMITS);
    expect(notices[0]?.severity).toBe("absent");
    expect(notices[0]?.detail).toContain("365-day");
  });

  it("returns nothing for a null status", () => {
    expect(parseEnrichmentStatus(null)).toEqual([]);
  });

  it("reports an unknown token verbatim rather than dropping it", () => {
    const notices = parseEnrichmentStatus("something_new");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.headline).toBe("something_new");
  });

  it("decodes a harvested contractor as a present value, not a gated one", () => {
    const notice = parseEnrichmentStatus(CLERMONT_NAMED).find(
      (entry) => entry.token === "contractor_from_clermont_etrakit",
    );
    expect(notice?.field).toBe("contractor_name");
    expect(notice?.severity).toBe("present");
    // The name is the contractor on the latest permit, not every contractor
    // who has ever worked the parcel, and the notice has to say so.
    expect(notice?.detail).toContain("Clermont");
    expect(notice?.detail).toContain("most recently dated permit");
  });

  it("decodes an unnamed Clermont permit as an established absence", () => {
    const notice = parseEnrichmentStatus(CLERMONT_UNNAMED).find(
      (entry) => entry.token === "contractor_absent_on_permit",
    );
    expect(notice?.field).toBe("contractor_name");
    expect(notice?.severity).toBe("absent");
    // The distinction the whole three-token scheme exists for: the source
    // carries contractors and named none, which a gated null never proves.
    expect(notice?.detail).toContain("established absence");
  });

  it("keeps the three contractor tokens mutually exclusive in meaning", () => {
    const severities = [
      "contractor_gated_403",
      "contractor_from_clermont_etrakit",
      "contractor_absent_on_permit",
    ].map((token) => parseEnrichmentStatus(token)[0]?.severity);
    expect(severities).toEqual(["gated", "present", "absent"]);
  });
});

describe("gatedFieldNotices", () => {
  it("names both gated fields and the HTTP status for each", () => {
    const gated = gatedFieldNotices(WITH_PERMITS);
    expect(gated.map((notice) => notice.field)).toEqual(["contractor_name", "bbb_rating"]);
    for (const notice of gated) {
      expect(notice.detail).toContain("403");
    }
  });

  it("still names the gated fields when there are no permits", () => {
    expect(gatedFieldNotices(WITHOUT_PERMITS)).toHaveLength(2);
  });

  it("does not call a Clermont parcel's contractor column gated", () => {
    // Neither of the Clermont tokens is a gating notice: one explains a value
    // that is there and the other an absence the source established. Treating
    // either as gated would put "the source refuses this request" next to a
    // column the source answered.
    for (const status of [CLERMONT_NAMED, CLERMONT_UNNAMED]) {
      const gated = gatedFieldNotices(status);
      expect(gated.map((notice) => notice.field)).toEqual(["bbb_rating"]);
    }
  });
});

describe("always-null columns", () => {
  it("explains every column the pipeline can never fill", () => {
    for (const column of [
      "bbb_rating",
      "has_bbb_contractor",
      "has_sunbiz_tenant",
      "property_cid",
    ]) {
      expect(ALWAYS_NULL_COLUMNS[column]?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("no longer claims contractor_name is always null", () => {
    // Clermont publishes a contractor of record, so the column is populated on
    // part of the county. Listing it here would make the UI print "always
    // null" beside a cell that has a name in it.
    expect(ALWAYS_NULL_COLUMNS.contractor_name).toBeUndefined();
  });

  it("states the tenure caveat as a lower bound", () => {
    expect(TENURE_CAVEAT).toContain("lower bound");
  });
});

describe("partially populated columns", () => {
  it("explains contractor_name as one jurisdiction rather than the county", () => {
    const note = PARTIALLY_POPULATED_COLUMNS.contractor_name ?? "";
    expect(note.length).toBeGreaterThan(10);
    expect(note).toContain("Clermont");
    // The boundary is the point: a note that named Clermont without saying the
    // rest of the county is null would read as county-wide coverage.
    expect(note).toMatch(/fifteen|15/);
    expect(note).toContain("Null elsewhere");
  });

  it("keeps the two maps disjoint", () => {
    // A column cannot be both always null and partially populated, and a
    // consumer that merged the maps would get whichever it merged last.
    for (const column of Object.keys(PARTIALLY_POPULATED_COLUMNS)) {
      expect(ALWAYS_NULL_COLUMNS[column]).toBeUndefined();
    }
  });
});
