import { describe, expect, it } from "vitest";

import {
  DECISION_EVIDENCE_FIELDS,
  EVIDENCE_STATES,
  RETAINED_EVIDENCE_VERSION,
  countEvidenceStates,
  createEvidenceStateCounts,
  deriveRetainedPermitEvidence,
  validatedBuiltYear,
  validatedDate,
  type RetainedEvidenceContext,
  type RetainedPermitObservation,
} from "../src/counties/lake/retained-permit-evidence.js";

const context: RetainedEvidenceContext = {
  asOfDate: "2026-09-16",
  sourceInput: {
    uri: "file:///private/frozen/permit-table.parquet",
    sha256: "a".repeat(64),
    capturedAt: null,
  },
  contactTextInput: {
    uri: "file:///private/frozen/clermont-permit-load.csv",
    sha256: "b".repeat(64),
    capturedAt: "2026-09-16T10:30:33.823Z",
  },
};

function permit(changes: Partial<RetainedPermitObservation> = {}): RetainedPermitObservation {
  return {
    permit_id: "e".repeat(32),
    permit_number: "20-1001",
    parcel_identifier: "0123456789",
    alt_key: "0012345",
    jurisdiction: "clermont",
    permit_type: "ROOF",
    permit_description: "Re-roof primary dwelling",
    permit_status: "FINALED",
    applied_date: "2020-01-01",
    approved_date: "2020-01-03",
    issued_date: "2020-01-04",
    completed_date: "2020-03-01",
    last_modified_date: null,
    is_roofing: true,
    is_open: false,
    days_open: 57,
    contractor_name: "Fixture Roofing-CCC1335680",
    contractor_license: "CCC1335680",
    bbb_rating: null,
    source_url: "https://official.example/permit/20-1001",
    source_system: "lake_clermont_etrakit_permits",
    linkage_status: "linked_to_assessed_roll",
    ...changes,
  };
}

describe("retained observation versus decision evidence", () => {
  it("retains all 22 original export fields without substituting derived decisions", () => {
    const raw = Object.freeze(permit());
    const original = JSON.stringify(raw);
    const evidence = deriveRetainedPermitEvidence(raw, context);
    expect(Object.keys(evidence.sourceObservations)).toHaveLength(22);
    expect(evidence.sourceObservations).toEqual(raw);
    expect(evidence.sourceObservations).not.toBe(raw);
    expect(JSON.stringify(raw)).toBe(original);
    expect(evidence.version).toBe(RETAINED_EVIDENCE_VERSION);
    expect(evidence.decisions).toEqual({
      isOpen: null,
      isCompleted: null,
      primaryRoofWorkClass: null,
      roofAnchorDate: null,
      contractorCompanyId: null,
      outcome: "needs_review",
    });
  });

  it("is idempotent for identical immutable inputs, version, and as-of date", () => {
    const raw = permit();
    expect(deriveRetainedPermitEvidence(raw, context)).toEqual(
      deriveRetainedPermitEvidence(raw, context),
    );
    expect(JSON.stringify(deriveRetainedPermitEvidence(raw, context))).toBe(
      JSON.stringify(deriveRetainedPermitEvidence(raw, context)),
    );
  });

  it("clones nested retained values rather than sharing mutable source payloads", () => {
    const nested = { raw: ["never-drop", "original"] };
    const raw = permit({ extra_source_payload: nested });
    const evidence = deriveRetainedPermitEvidence(raw, context);
    nested.raw[0] = "changed-after-derivation";
    expect(evidence.sourceObservations.extra_source_payload).toEqual({
      raw: ["never-drop", "original"],
    });
  });

  it("copies immutable source bindings instead of sharing mutable caller metadata", () => {
    const sourceInput = { ...context.sourceInput };
    const contactTextInput = { ...context.sourceInput };
    const evidence = deriveRetainedPermitEvidence(permit(), {
      ...context,
      sourceInput,
      contactTextInput,
    });
    sourceInput.sha256 = "c".repeat(64);
    contactTextInput.sha256 = "d".repeat(64);
    expect(evidence.fieldEvidence.sourceStatusObservation.provenance.sha256).toBe("a".repeat(64));
    expect(evidence.fieldEvidence.contractorContactName.provenance.sha256).toBe("a".repeat(64));
    expect(evidence.fieldEvidence.permitContactTextLicense.provenance.sha256).toBe("a".repeat(64));
  });

  it.each(["VOID", "EXPIRED", "REJECTED", "UNRECOGNIZED", "FINALED", "ISSUED"])(
    "%s plus legacy is_open=false is neither accepted completion nor current status",
    (status) => {
      const evidence = deriveRetainedPermitEvidence(
        permit({ permit_status: status, is_open: false }),
        context,
      );
      expect(evidence.fieldEvidence.sourceStatusObservation.value).toBe(status);
      expect(evidence.fieldEvidence.currentOpenStatus.state).toBe("unknown");
      expect(evidence.fieldEvidence.completionStatus.state).toBe("unknown");
      expect(evidence.decisions.isCompleted).toBeNull();
      expect(evidence.decisions.isOpen).toBeNull();
      expect(evidence.decisions.roofAnchorDate).toBeNull();
    },
  );

  it("does not imply live revalidation when an observation timestamp is unknown", () => {
    const evidence = deriveRetainedPermitEvidence(permit(), context);
    expect(evidence.fieldEvidence.sourceStatusObservation.provenance.capturedAt).toBeNull();
    expect(evidence.fieldEvidence.currentOpenStatus.value).toBeNull();
    expect(evidence.caveats.join(" ")).toMatch(/not current\/live/);
  });

  it.each([
    "Repair roof leak",
    "Roof coating",
    "Gazebo re-roof",
    "Awning replacement",
    "Accessory shed roofing",
    "Re-roof primary dwelling",
    "New construction",
    "UNKNOWN",
  ])("a broad regex hit on %s is not an accepted primary-work class", (description) => {
    const evidence = deriveRetainedPermitEvidence(
      permit({ permit_description: description, is_roofing: true }),
      context,
    );
    expect(evidence.fieldEvidence.primaryRoofWorkClass.state).toBe("unknown");
    expect(evidence.decisions.primaryRoofWorkClass).toBeNull();
    expect(evidence.decisions.roofAnchorDate).toBeNull();
  });

  it("does not synthesize a completion anchor from a valid issuance date", () => {
    const evidence = deriveRetainedPermitEvidence(permit({ completed_date: null }), context);
    expect(evidence.fieldEvidence.issuedDate.value).toBe("2020-01-04");
    expect(evidence.lifecycleObservation.date).toBeNull();
    expect(evidence.decisions.roofAnchorDate).toBeNull();
  });
});

describe("license provenance without identity promotion", () => {
  it("traces one literal contact-text token separately from the raw combined export", () => {
    const evidence = deriveRetainedPermitEvidence(permit(), context);
    expect(evidence.licenseTrace.origin).toBe("permit_contact_text");
    expect(evidence.licenseTrace.permitContactTextLicense).toBe("CCC1335680");
    expect(evidence.fieldEvidence.permitContactTextLicense.state).toBe("confirmed_present");
    expect(evidence.fieldEvidence.permitContactTextLicense.rawValue).toBe(
      "Fixture Roofing-CCC1335680",
    );
    expect(evidence.fieldEvidence.permitContactTextLicense.provenance).toEqual(
      context.contactTextInput,
    );
    expect(evidence.licenseTrace.verification).toBe("not_dbpr_verified");
    expect(evidence.licenseTrace.permitPrintedLicense).toBeNull();
    expect(evidence.fieldEvidence.permitPrintedLicense.state).toBe("unknown");
    expect(evidence.fieldEvidence.officialLicenseIdentity.value).toBeNull();
    expect(evidence.fieldEvidence.contractorRole.value).toBeNull();
  });

  it("keeps a directory fallback candidate separate and leaves omitted raw permit license omitted", () => {
    const raw = permit({ contractor_name: "Fixture Roofing", contractor_license: "CCC1335680" });
    const evidence = deriveRetainedPermitEvidence(raw, context);
    expect(evidence.licenseTrace.origin).toBe("directory_candidate_unverified");
    expect(evidence.licenseTrace.directoryCandidateLicense).toBe("CCC1335680");
    expect(evidence.licenseTrace.permitPrintedLicense).toBeNull();
    expect(evidence.licenseTrace.permitContactTextLicense).toBeNull();
    expect(evidence.sourceObservations.contractor_license).toBe("CCC1335680");
    expect(evidence.fieldEvidence.permitPrintedLicense.value).toBeNull();
    expect(evidence.decisions.contractorCompanyId).toBeNull();
  });

  it("does not fill a missing raw exported license even when contact text contains a token", () => {
    const evidence = deriveRetainedPermitEvidence(permit({ contractor_license: null }), context);
    expect(evidence.licenseTrace.permitContactTextLicense).toBe("CCC1335680");
    expect(evidence.sourceObservations.contractor_license).toBeNull();
    expect(evidence.licenseTrace.permitPrintedLicense).toBeNull();
  });

  it("does not certify contact-text lineage without the exact immutable source binding", () => {
    const { contactTextInput: _contactTextInput, ...noContactLineage } = context;
    const evidence = deriveRetainedPermitEvidence(permit(), noContactLineage);
    expect(evidence.licenseTrace.origin).toBe("unknown");
    expect(evidence.licenseTrace.permitContactTextLicense).toBeNull();
    expect(evidence.fieldEvidence.permitContactTextLicense.state).toBe("unknown");
  });

  it("never claims an omitted contact/name/license is confirmed empty or unassigned", () => {
    const evidence = deriveRetainedPermitEvidence(
      permit({ contractor_name: null, contractor_license: null }),
      context,
    );
    expect(evidence.licenseTrace.origin).toBe("absent");
    expect(evidence.fieldEvidence.contractorContactName.state).toBe("unknown");
    expect(evidence.fieldEvidence.contractorRole.state).toBe("unknown");
    expect(evidence.fieldEvidence.permitPrintedLicense.state).toBe("unknown");
  });

  it("holds divergent legacy and contact-text values apart", () => {
    const evidence = deriveRetainedPermitEvidence(
      permit({ contractor_license: "CCC9999999" }),
      context,
    );
    expect(evidence.licenseTrace.origin).toBe("conflicting");
    expect(evidence.fieldEvidence.permitContactTextLicense.state).toBe("conflicting");
    expect(evidence.licenseTrace.permitContactTextLicense).toBeNull();
    expect(evidence.licenseTrace.contactTextTokens).toEqual(["CCC1335680"]);
  });

  it("does not pick the first of multiple differing contact tokens", () => {
    const evidence = deriveRetainedPermitEvidence(
      permit({ contractor_name: "Fixture-CCC1335680 / CCC9999999" }),
      context,
    );
    expect(evidence.fieldEvidence.permitContactTextLicense.state).toBe("conflicting");
    expect(evidence.licenseTrace.contactTextTokens).toEqual(["CCC1335680", "CCC9999999"]);
    expect(evidence.licenseTrace.permitPrintedLicense).toBeNull();
  });

  it.each(["CCC12", "CCC12345678901"])(
    "quarantines the malformed license-like token %s without dropping raw provenance",
    (token) => {
      const raw = permit({ contractor_name: `Fixture-${token}`, contractor_license: token });
      const evidence = deriveRetainedPermitEvidence(raw, context);
      expect(evidence.fieldEvidence.permitContactTextLicense.state).toBe("invalid_quarantined");
      expect(evidence.fieldEvidence.permitContactTextLicense.value).toBeNull();
      expect(evidence.sourceObservations.contractor_name).toBe(raw.contractor_name);
      expect(evidence.licenseTrace.permitPrintedLicense).toBeNull();
    },
  );

  it("does not fuzzy-merge similarly named companies with different or omitted licenses", () => {
    const first = deriveRetainedPermitEvidence(
      permit({ contractor_name: "Same-Name Roofing-CCC1111111", contractor_license: "CCC1111111" }),
      context,
    );
    const second = deriveRetainedPermitEvidence(
      permit({ contractor_name: "Same Name Roofing-CCC2222222", contractor_license: "CCC2222222" }),
      context,
    );
    const nameOnly = deriveRetainedPermitEvidence(
      permit({ contractor_name: "Same Name Roofing", contractor_license: null }),
      context,
    );
    expect(first.licenseTrace.permitContactTextLicense).not.toBe(
      second.licenseTrace.permitContactTextLicense,
    );
    for (const evidence of [first, second, nameOnly]) {
      expect(evidence.decisions.contractorCompanyId).toBeNull();
      expect(evidence.fieldEvidence.contractorCompanyIdentity.state).toBe("unknown");
    }
  });

  it("does not assume a non-Clermont combined license comes from a directory", () => {
    const evidence = deriveRetainedPermitEvidence(
      permit({
        source_system: "lake_cdplus_permits",
        contractor_name: "Fixture",
        contractor_license: "CCC1335680",
      }),
      context,
    );
    expect(evidence.licenseTrace.origin).toBe("unknown");
    expect(evidence.licenseTrace.directoryCandidateLicense).toBeNull();
    expect(evidence.licenseTrace.permitPrintedLicense).toBeNull();
  });
});

describe("dates and source lifecycle labels", () => {
  it.each([
    "2023-02-29",
    "1900-02-29",
    "2020-02-30",
    "2026-04-31",
    "0000-01-01",
    "2020-00-01",
    "2020-13-01",
    "2020-01-00",
    "2020-1-1",
    "01/01/2020",
    "2020-01-01T00:00:00Z",
    "2027-01-01",
    "2026-09-17",
  ])("quarantines invalid or future date %s instead of Date.parse rollover", (raw) => {
    const date = validatedDate(raw, context);
    expect(date.state).toBe("invalid_quarantined");
    expect(date.value).toBeNull();
    expect(date.rawValue).toBe(raw);
  });

  it.each(["2000-02-29", "2024-02-29", "2026-09-16", "0001-01-01"])(
    "accepts Gregorian observation %s without promoting completion semantics",
    (raw) => {
      expect(validatedDate(raw, context)).toMatchObject({ state: "confirmed_present", value: raw });
    },
  );

  it.each([null, "", "   "])("keeps omitted date %s unknown, not confirmed empty", (raw) => {
    expect(validatedDate(raw, context).state).toBe("unknown");
  });

  it("quarantines an out-of-profile range and preserves its raw date", () => {
    const result = validatedDate("1899-12-31", { ...context, minimumDate: "1900-01-01" });
    expect(result).toMatchObject({
      state: "invalid_quarantined",
      value: null,
      rawValue: "1899-12-31",
    });
  });

  it("does not impose cross-date chronology absent justified source semantics", () => {
    const evidence = deriveRetainedPermitEvidence(
      permit({
        applied_date: "2020-05-01",
        issued_date: "2020-01-01",
        completed_date: "2019-12-31",
      }),
      context,
    );
    expect(evidence.fieldEvidence.appliedDate.state).toBe("confirmed_present");
    expect(evidence.fieldEvidence.issuedDate.state).toBe("confirmed_present");
    expect(evidence.fieldEvidence.sourceFinaledOrCODate.state).toBe("confirmed_present");
    expect(evidence.decisions.roofAnchorDate).toBeNull();
  });

  it("keeps Clermont FinaledDate as one source observation, not three independent dates", () => {
    const evidence = deriveRetainedPermitEvidence(permit(), context);
    expect(evidence.lifecycleObservation.label).toBe("FinaledDate");
    expect(evidence.lifecycleObservation.date).toBe("2020-03-01");
    expect(evidence.lifecycleObservation.independentCloseDate).toBeNull();
    expect(evidence.lifecycleObservation.independentCompletionDate).toBeNull();
    expect(evidence.lifecycleObservation.independentFinalInspectionDate).toBeNull();
    for (const key of ["closeDate", "completionDate", "finalInspectionDate"] as const) {
      expect(evidence.fieldEvidence[key].value).toBeNull();
      expect(evidence.fieldEvidence[key].sourceField).toBe("FinaledDate");
    }
  });

  it("labels CD Plus CODate without claiming universal primary-roof completion", () => {
    const evidence = deriveRetainedPermitEvidence(
      permit({ source_system: "lake_cdplus_permits" }),
      context,
    );
    expect(evidence.lifecycleObservation.label).toBe("Permit_CODate");
    expect(evidence.fieldEvidence.completionDate.state).toBe("unknown");
    expect(evidence.decisions.isCompleted).toBeNull();
  });

  it("preserves malformed dates and provenance but excludes them from observations and anchors", () => {
    const evidence = deriveRetainedPermitEvidence(
      permit({ completed_date: "2020-02-30", issued_date: "2027-01-01" }),
      context,
    );
    expect(evidence.fieldEvidence.sourceFinaledOrCODate.state).toBe("invalid_quarantined");
    expect(evidence.fieldEvidence.sourceFinaledOrCODate.rawValue).toBe("2020-02-30");
    expect(evidence.fieldEvidence.sourceFinaledOrCODate.provenance).toEqual(context.sourceInput);
    expect(evidence.lifecycleObservation.date).toBeNull();
    expect(evidence.sourceObservations.completed_date).toBe("2020-02-30");
    expect(evidence.decisions.roofAnchorDate).toBeNull();
  });

  it.each(["2026-02-30", "2026-9-16"])("rejects an invalid as-of context %s", (asOfDate) => {
    expect(() => deriveRetainedPermitEvidence(permit(), { ...context, asOfDate })).toThrow(
      /asOfDate/,
    );
  });

  it("rejects invalid range context instead of silently accepting it", () => {
    expect(() => validatedDate("2020-01-01", { ...context, minimumDate: "2026-02-30" })).toThrow(
      /minimumDate/,
    );
  });

  it("requires a byte-digest input binding and valid capture timestamp when present", () => {
    expect(() =>
      deriveRetainedPermitEvidence(permit(), {
        ...context,
        sourceInput: { ...context.sourceInput, sha256: "not-a-digest" },
      }),
    ).toThrow(/SHA-256/);
    expect(() =>
      deriveRetainedPermitEvidence(permit(), {
        ...context,
        contactTextInput: { ...context.sourceInput, capturedAt: "2026-02-30T10:00:00Z" },
      }),
    ).toThrow(/capturedAt/);
  });

  it("rejects timestamp midnight rollover rather than accepting Date.parse normalization", () => {
    expect(() =>
      deriveRetainedPermitEvidence(permit(), {
        ...context,
        sourceInput: { ...context.sourceInput, capturedAt: "2026-09-16T24:00:00Z" },
      }),
    ).toThrow(/capturedAt/);
  });
});

describe("built-year proxy and evidence partitions", () => {
  it("allows a valid low-confidence built-year proxy despite partial permit history", () => {
    expect(validatedBuiltYear(1999, { ...context, minimumYear: 1700 })).toMatchObject({
      state: "confirmed_present",
      value: 1999,
      reason: expect.stringMatching(/low-confidence.*partial history/),
    });
  });

  it.each([2027, 1699, 0, 1999.5, "year1999", "1999.5", "2027"])(
    "quarantines invalid, future, or out-of-range built year %s",
    (raw) => {
      expect(validatedBuiltYear(raw, { ...context, minimumYear: 1700 })).toMatchObject({
        state: "invalid_quarantined",
        value: null,
        rawValue: raw,
      });
    },
  );

  it.each([null, ""])("keeps missing built year %s unknown rather than empty", (raw) => {
    expect(validatedBuiltYear(raw, { ...context, minimumYear: 1700 }).state).toBe("unknown");
  });

  it("exposes exactly the seven official field states, with no source/run-state aliases", () => {
    expect(EVIDENCE_STATES).toEqual([
      "confirmed_present",
      "confirmed_empty",
      "unavailable",
      "stale",
      "conflicting",
      "invalid_quarantined",
      "unknown",
    ]);
    expect(Object.keys(createEvidenceStateCounts())).toEqual(EVIDENCE_STATES);
  });

  it("assigns exactly one of seven states per decision-critical field for every retained record", () => {
    const rows = [
      deriveRetainedPermitEvidence(permit(), context),
      deriveRetainedPermitEvidence(
        permit({ issued_date: "2027-01-01", contractor_name: null }),
        context,
      ),
      deriveRetainedPermitEvidence(permit({ contractor_license: "CCC9999999" }), context),
    ];
    const counts = countEvidenceStates(rows);
    expect(Object.keys(counts)).toEqual(DECISION_EVIDENCE_FIELDS);
    for (const field of DECISION_EVIDENCE_FIELDS) {
      expect(Object.keys(counts[field])).toEqual(EVIDENCE_STATES);
      expect(Object.values(counts[field]).reduce((sum, count) => sum + count, 0)).toBe(rows.length);
      expect(counts[field].confirmed_empty).toBe(0);
      for (const row of rows) expect(EVIDENCE_STATES).toContain(row.fieldEvidence[field].state);
    }
    expect(counts.issuedDate.invalid_quarantined).toBe(1);
    expect(counts.permitContactTextLicense.conflicting).toBe(1);
    expect(counts.currentOpenStatus.unknown).toBe(3);
  });
});
