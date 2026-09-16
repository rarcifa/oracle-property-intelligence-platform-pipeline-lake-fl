import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EVIDENCE_STATES } from "../src/counties/lake/retained-permit-evidence.js";
import {
  extractRetainedPermitObservations,
  OBSERVATION_EVIDENCE_FIELDS,
  RETAINED_OBSERVATIONS_VERSION,
} from "../src/counties/lake/retained-permit-observations.js";

interface SyntheticCaptureFixture {
  readonly id: string;
  readonly synthetic: true;
  readonly expectedPermitNumber: string;
  readonly html: string;
  readonly expected: {
    readonly contactRows: number | null;
    readonly inspectionRows: number | null;
    readonly contactHeaderLabels: readonly string[];
    readonly inspectionHeaderLabels: readonly string[] | null;
    readonly syntheticInspectionIdentifier: string;
    readonly headerTableFillerPreserved: true;
  };
}

const packet = JSON.parse(
  readFileSync(
    new URL("./fixtures/clermont-retained-observations/sanitized-captures.json", import.meta.url),
    "utf8",
  ),
) as { readonly synthetic: true; readonly fixtures: readonly SyntheticCaptureFixture[] };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const extract = (fixture: SyntheticCaptureFixture, html = fixture.html) =>
  extractRetainedPermitObservations({
    html,
    expectedPermitNumber: fixture.expectedPermitNumber,
    rawSha256: sha256(html),
    sourceUri: `memory:synthetic-fixture/${fixture.id}`,
    asOfDate: "2026-09-16",
    captureReceipt: null,
  });

describe.each(packet.fixtures)("sanitized retained structure: $id", (fixture) => {
  it("is explicitly synthetic and verifies its rendered source key", () => {
    expect(packet.synthetic).toBe(true);
    expect(fixture.synthetic).toBe(true);
    expect(fixture.html).toContain("SANITIZED SYNTHETIC FIXTURE");
    expect(fixture.expectedPermitNumber).toMatch(/^SYNTHETIC-PERMIT-/u);
    expect(extract(fixture).identity.sourcePermitNumber).toBe(fixture.expectedPermitNumber);
  });

  it("reads real Telerik headings instead of the data-table dummy header", () => {
    const result = extract(fixture);
    expect(result.contacts.headers).toEqual(fixture.expected.contactHeaderLabels);
    expect(result.contacts.dataRowCount).toBe(fixture.expected.contactRows);
    expect(result.inspections.headers).toEqual(fixture.expected.inspectionHeaderLabels);
    expect(result.inspections.dataRowCount).toBe(fixture.expected.inspectionRows ?? 0);
  });

  it("keeps source lifecycle labels without legacy close/completion aliases", () => {
    const result = extract(fixture);
    expect(Object.keys(result.lifecycle)).toEqual([
      "applied",
      "approved",
      "issued",
      "finaled",
      "expiration",
    ]);
    expect(result.lifecycle.finaled.controls[0]?.sourceLabels[0]?.rawValue).toBe("Finaled Date:");
    expect(result.lifecycle.finaled.semantics).toBe("source_label_only_not_a_decision_anchor");
    expect(result).not.toHaveProperty("completion_date");
    expect(result).not.toHaveProperty("permit_close_date");
    expect(result).not.toHaveProperty("final_inspection_date");
  });

  it("retains the real header-table blank tbody filler without treating it as a heading", () => {
    const result = extract(fixture);
    expect(fixture.expected.headerTableFillerPreserved).toBe(true);
    expect(result.contacts.headerTables[0]?.rows).toHaveLength(2);
    expect(result.contacts.headerTables[0]?.headingRows).toHaveLength(1);
    expect(result.contacts.headers).toEqual(fixture.expected.contactHeaderLabels);
    for (const header of result.inspections.headerTables) {
      expect(header.rows).toHaveLength(2);
      expect(header.headingRows).toHaveLength(1);
    }
  });

  it("preserves multiple raw contacts while holding license and company identity", () => {
    const result = extract(fixture);
    expect(result.contacts.contactRows).toHaveLength(fixture.expected.contactRows ?? 0);
    for (const contact of result.contacts.contactRows) {
      expect(contact.rawName).toMatch(/^SYNTHETIC CONTACT/u);
      expect(contact.rawRole).not.toBeNull();
      expect(contact.directoryCandidateLicense).toBeNull();
      expect(contact.permitPrintedLicense).toBeNull();
      expect(contact.officialLicenseIdentity).toBeNull();
      expect(contact.companyId).toBeNull();
      expect(contact.roleClassification).toBe("not_accepted");
    }
  });

  it("keeps inspection event dates and both time columns distinct", () => {
    const result = extract(fixture);
    for (const inspection of result.inspections.inspectionRows) {
      expect(inspection.dateCells.map((cell) => cell.sourceLabel)).toEqual([
        "Scheduled Date",
        "Completed",
      ]);
      expect(
        inspection.row.cells
          .filter((cell) => cell.headerRaw === "Time")
          .map((cell) => cell.columnIndex),
      ).toEqual([4, 6]);
      expect(inspection.eventSemantics).toBe("inspection_events_not_permit_or_roof_completion");
      expect(inspection.row.sourceRowControlId).not.toBeNull();
      expect(inspection.row.moreInfoControlIds).toHaveLength(1);
      expect(inspection.row.exposedInspectionControls).toHaveLength(1);
      for (const control of inspection.row.exposedInspectionControls) {
        expect(control.sourceControlId).toMatch(/_lbMoreInfo$/u);
        expect(control.origin).toBe("source_dom_control_not_canonical_inspection_id");
        expect(control.canonicalInspectionId).toBeNull();
      }
      expect(inspection.row.observationLocator.rawSha256).toBe(sha256(fixture.html));
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("onclick");
    expect(serialized).not.toContain("__doPostBack");
    expect(serialized).not.toContain("SYNTHETIC-EVENT-TIME");
    expect(serialized).not.toContain(fixture.expected.syntheticInspectionIdentifier);
  });

  it("conserves all seven field states with production conclusions held", () => {
    const result = extract(fixture);
    expect(result.version).toBe(RETAINED_OBSERVATIONS_VERSION);
    for (const field of OBSERVATION_EVIDENCE_FIELDS) {
      expect(EVIDENCE_STATES.reduce((total, state) => total + result.counts[field][state], 0)).toBe(
        1,
      );
    }
    expect(result.provenance.capturedAt).toBeNull();
    expect(result.fields.perRecordCapturedAt.state).toBe("unknown");
    expect(result.decisions).toEqual({
      isOpen: null,
      isCompleted: null,
      primaryRoofWorkClass: null,
      roofAnchorDate: null,
      permitPrintedLicense: null,
      officialLicenseIdentity: null,
      contractorCompanyId: null,
      outcome: "needs_review",
    });
    expect(result.sourceProfileAccepted).toBe(false);
    expect(result.decisionPromotion).toBe(false);
    expect(result.productionEligible).toBe(false);
  });

  it("replays deterministically without changing its input bytes", () => {
    const before = sha256(fixture.html);
    expect(JSON.stringify(extract(fixture))).toBe(JSON.stringify(extract(fixture)));
    expect(sha256(fixture.html)).toBe(before);
  });
});

describe("explicitly synthetic adversarial mutations of minimized captured structures", () => {
  const fixture = packet.fixtures[0];
  if (fixture === undefined) throw new Error("synthetic capture fixture is required");

  it("does not fill a missing source number from the expected work key", () => {
    const html = fixture.html.replace(/<span id="[^"]+_lblPermitNo">[\s\S]*?<\/span>/u, "");
    const result = extract(fixture, html);
    expect(result.identity.sourcePermitNumber).toBeNull();
    expect(result.identity.state).toBe("unknown");
    expect(result.identity.holds).toContain("explicit_unique_source_permit_number_required");
  });

  it("retains duplicate source controls instead of choosing the first", () => {
    const html =
      fixture.html +
      `<span id="synthetic_other_lblPermitNo">${fixture.expectedPermitNumber}</span>`;
    const result = extract(fixture, html);
    expect(result.identity.controls).toHaveLength(2);
    expect(result.identity.sourcePermitNumber).toBeNull();
    expect(result.identity.state).toBe("conflicting");
  });

  it("rejects a rendered source number that disagrees with the work key", () => {
    const result = extractRetainedPermitObservations({
      html: fixture.html,
      expectedPermitNumber: "SYNTHETIC-OTHER-WORK-KEY",
      rawSha256: sha256(fixture.html),
      asOfDate: "2026-09-16",
    });
    expect(result.identity.state).toBe("invalid_quarantined");
    expect(result.identity.sourcePermitNumber).toBeNull();
    expect(result.identity.controls[0]?.rawValue).toBe(fixture.expectedPermitNumber);
  });

  it("requires the immutable digest of the actual supplied HTML", () => {
    expect(() =>
      extractRetainedPermitObservations({
        html: fixture.html,
        expectedPermitNumber: fixture.expectedPermitNumber,
        rawSha256: "0".repeat(64),
        asOfDate: "2026-09-16",
      }),
    ).toThrow("supplied HTML bytes disagree");
  });
});
