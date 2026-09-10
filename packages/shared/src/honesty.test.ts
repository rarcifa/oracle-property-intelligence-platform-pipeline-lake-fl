/** Tests that a null column always carries its reason. */
import { describe, expect, it } from "vitest";
import {
  ALWAYS_NULL_COLUMNS,
  gatedFieldNotices,
  parseEnrichmentStatus,
  TENURE_CAVEAT,
} from "./honesty.js";

const WITH_PERMITS = "permits_loaded;contractor_gated_403;bbb_gated_403";
const WITHOUT_PERMITS = "no_permits_in_source;contractor_gated_403;bbb_gated_403";

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
});

describe("always-null columns", () => {
  it("explains every column the pipeline can never fill", () => {
    for (const column of [
      "contractor_name",
      "bbb_rating",
      "has_bbb_contractor",
      "has_sunbiz_tenant",
    ]) {
      expect(ALWAYS_NULL_COLUMNS[column]?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("states the tenure caveat as a lower bound", () => {
    expect(TENURE_CAVEAT).toContain("lower bound");
  });
});
