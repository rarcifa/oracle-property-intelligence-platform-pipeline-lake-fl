import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EVIDENCE_STATES } from "../src/counties/lake/retained-permit-evidence.js";
import {
  OBSERVATION_EVIDENCE_FIELDS,
  RETAINED_OBSERVATIONS_VERSION,
  extractRetainedPermitObservations,
  type ExtractRetainedPermitObservationsInput,
} from "../src/counties/lake/retained-permit-observations.js";

// Every record, person, contact, identifier and description below is synthetic.
// Captured source-structure fixtures and private origin bindings are tested separately.
const SYNTHETIC_PERMIT = "SYNTHETIC-PERMIT-001";
const CONTACT_HEADERS = ["Contact Type", "Name", "Phone", "E-mail", "Address", "City/State/Zip"];
const INSPECTION_HEADERS = [
  "Type",
  "SEQ#",
  "Result",
  "Scheduled Date",
  "Time",
  "Completed",
  "Time",
  "More Info",
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function control(
  suffix: string,
  rawValue: string,
  label: string = suffix,
  prefix: string = "cplMain_ctl97",
): string {
  return `<span id="${prefix}_${suffix}Lbl">${escapeHtml(label)}</span><span id="${prefix}_${suffix}">${escapeHtml(rawValue)}</span>`;
}

function grid(
  name: "rgContactInfo" | "rgInspectionInfo",
  headers: readonly string[],
  rows: readonly (readonly string[] | string)[],
  options: {
    readonly omitHeader?: boolean;
    readonly headerId?: string;
    readonly prefix?: string;
  } = {},
): string {
  const id = `${options.prefix ?? "ctl00_cplMain_ctl97"}_${name}_ctl00`;
  const header = options.omitHeader
    ? ""
    : `<table id="${options.headerId ?? `${id}_Header`}"><thead><tr>${headers.map((heading) => `<th>${escapeHtml(heading)}</th>`).join("")}</tr></thead></table>`;
  const body = rows
    .map((row) =>
      typeof row === "string"
        ? row
        : `<tr class="rgRow">${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
    )
    .join("");
  const dummy = `<thead style="display:none"><tr>${headers.map(() => '<th style="display:none">DUMMY-SYNTHETIC-HEADING</th>').join("")}</tr></thead>`;
  return `${header}<table id="${id}">${dummy}<tbody>${body}</tbody></table>`;
}

function html(
  options: {
    readonly number?: string | null;
    readonly finaled?: string;
    readonly status?: string;
    readonly extra?: string;
    readonly contacts?: string;
    readonly inspections?: string;
    readonly description?: string;
  } = {},
): string {
  const number = options.number === undefined ? SYNTHETIC_PERMIT : options.number;
  return `<html><body>${number === null ? "" : control("lblPermitNo", number, "Permit:")}${control("lblPermitType", "SYNTHETIC-ROOF", "Type:")}${control("lblPermitDesc", options.description ?? "SYNTHETIC replacement primary roof", "Short Description:")}${control("lblPermitStatus", options.status ?? "FINALED", "Status:")}${control("lblPermitAppliedDate", "01/01/2020", "Applied Date:")}${control("lblPermitApprovedDate", "01/02/2020", "Approved Date:")}${control("lblPermitIssuedDate", "01/03/2020", "Issued Date:")}${control("lblPermitFinaledDate", options.finaled ?? "03/01/2020", "Finaled Date:")}${control("lblPermitExpirationDate", "01/03/2030", "Expiration Date:")}${control("lblPermitNotes", " SYNTHETIC retained note \n", "Notes:")}${options.contacts ?? grid("rgContactInfo", CONTACT_HEADERS, [["CONTRACTOR", "SYNTHETIC Roofing-CCC0000000", "", "", "SYNTHETIC ADDRESS", "SYNTHETIC CITY"]])}${options.inspections ?? grid("rgInspectionInfo", INSPECTION_HEADERS, [["SYNTHETIC EVENT", "001", "SYNTHETIC RESULT", "02/29/2020", "08:00 AM", "03/01/2020", "09:00 AM", "More Info"]])}${options.extra ?? ""}</body></html>`;
}

function input(
  bytes: string,
  changes: Partial<ExtractRetainedPermitObservationsInput> = {},
): ExtractRetainedPermitObservationsInput {
  return {
    html: bytes,
    expectedPermitNumber: SYNTHETIC_PERMIT,
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
    asOfDate: "2026-09-16",
    captureReceipt: null,
    ...changes,
  };
}

describe("isolated retained observations and explicit source identity", () => {
  it("checks an explicit unique source number and retains original text/labels", () => {
    const result = extractRetainedPermitObservations(
      input(html({ number: ` ${SYNTHETIC_PERMIT} ` })),
    );
    expect(result.version).toBe(RETAINED_OBSERVATIONS_VERSION);
    expect(result.identity.state).toBe("confirmed_present");
    expect(result.identity.sourcePermitNumber).toBe(SYNTHETIC_PERMIT);
    expect(result.identity.controls[0]?.rawValue).toBe(` ${SYNTHETIC_PERMIT} `);
    expect(result.identity.controls[0]?.sourceLabels[0]?.rawValue).toBe("Permit:");
  });

  it("never substitutes a routing key for a missing source number with populated type", () => {
    const result = extractRetainedPermitObservations(input(html({ number: null })));
    expect(result.sourceFields.type.state).toBe("confirmed_present");
    expect(result.identity.state).toBe("unknown");
    expect(result.identity.sourcePermitNumber).toBeNull();
    expect(result.identity.value).toBeNull();
    expect(result.identity.holds).toContain("explicit_unique_source_permit_number_required");
  });

  it("quarantines a mismatch while preserving the explicit raw source number", () => {
    const result = extractRetainedPermitObservations(
      input(html({ number: "SYNTHETIC-OTHER-PERMIT" })),
    );
    expect(result.identity.state).toBe("invalid_quarantined");
    expect(result.identity.sourcePermitNumber).toBeNull();
    expect(result.identity.controls[0]?.rawValue).toBe("SYNTHETIC-OTHER-PERMIT");
    expect(result.fields.sourcePermitNumber.reason).toMatch(/mismatch/u);
  });

  it("does not case-fold a source identity disagreement", () => {
    expect(
      extractRetainedPermitObservations(input(html({ number: SYNTHETIC_PERMIT.toLowerCase() })))
        .identity.state,
    ).toBe("invalid_quarantined");
  });

  it.each([SYNTHETIC_PERMIT, "SYNTHETIC-OTHER-PERMIT"])(
    "holds duplicate source controls, including duplicate value %s",
    (duplicate) => {
      const result = extractRetainedPermitObservations(
        input(html({ extra: control("lblPermitNo", duplicate, "Permit:", "cplMain_ctl98") })),
      );
      expect(result.identity.state).toBe("conflicting");
      expect(result.identity.controls).toHaveLength(2);
      expect(result.identity.sourcePermitNumber).toBeNull();
    },
  );

  it("returns precise unknown observations for a silent HTTP-200-style partial render", () => {
    const result = extractRetainedPermitObservations(
      input("<html><body>SYNTHETIC portal chrome only</body></html>"),
    );
    expect(result.identity.state).toBe("unknown");
    expect(result.contacts.state).toBe("unknown");
    expect(result.inspections.state).toBe("unknown");
    expect(result.decisions.outcome).toBe("needs_review");
  });

  it("supports renumbered ctl prefixes without choosing the first duplicate", () => {
    const bytes = html().replace(/ctl97/gu, "ctl321");
    const result = extractRetainedPermitObservations(input(bytes));
    expect(result.identity.sourcePermitNumber).toBe(SYNTHETIC_PERMIT);
    expect(result.contacts.headers).toEqual(CONTACT_HEADERS);
  });

  it("validates actual supplied UTF-8 HTML bytes rather than trusting a digest declaration", () => {
    expect(() =>
      extractRetainedPermitObservations(input(html(), { rawSha256: "a".repeat(64) })),
    ).toThrow(/HTML bytes disagree/u);
    expect(() =>
      extractRetainedPermitObservations(input(html(), { rawSha256: "not-a-digest" })),
    ).toThrow(/SHA-256/u);
  });

  it("keeps extracted JSON hash as a caller binding, not an unperformed readback", () => {
    const result = extractRetainedPermitObservations(
      input(html(), { extractedSha256: "sha256:" + "b".repeat(64) }),
    );
    expect(result.provenance.extractedSha256).toBe("b".repeat(64));
    expect(result.provenance.extractedDigestVerification).toBe("caller_binding_only");
  });

  it("rejects blank routing keys and invalid review dates", () => {
    expect(() =>
      extractRetainedPermitObservations(input(html(), { expectedPermitNumber: " " })),
    ).toThrow(/routing key/u);
    expect(() =>
      extractRetainedPermitObservations(input(html(), { asOfDate: "2026-02-30" })),
    ).toThrow(/Gregorian/u);
  });
});

describe("Telerik real headings and every retained row", () => {
  it("keeps same-file contact and inspection frozen-row locators distinct and table-bound", () => {
    const result = extractRetainedPermitObservations(input(html()));
    const contact = result.contacts.rows[1]?.observationLocator;
    const inspection = result.inspections.rows[1]?.observationLocator;
    expect(contact).not.toEqual(inspection);
    expect(contact).toMatchObject({
      kind: "frozen_raw_row_observation",
      gridName: "rgContactInfo",
      dataTableControlId: result.contacts.dataTables[0]?.sourceControlId,
      dataTableIndex: 0,
      rowIndex: 1,
    });
    expect(inspection).toMatchObject({
      kind: "frozen_raw_row_observation",
      gridName: "rgInspectionInfo",
      dataTableControlId: result.inspections.dataTables[0]?.sourceControlId,
      dataTableIndex: 0,
      rowIndex: 1,
    });
    expect(contact?.rawSha256).toBe(inspection?.rawSha256);
    expect(result.decisions.officialLicenseIdentity).toBeNull();
    expect(
      result.inspections.rows[1]?.exposedInspectionControls.every(
        (control) => control.canonicalInspectionId === null,
      ),
    ).toBe(true);
    expect(result.productionEligible).toBe(false);
  });

  it("uses separate real headers, not hidden dummy headings", () => {
    const result = extractRetainedPermitObservations(input(html()));
    expect(result.contacts.headers).toEqual(CONTACT_HEADERS);
    expect(result.contacts.rows[0]?.kind).toBe("dummy_header");
    expect(result.contacts.dataRowCount).toBe(1);
    expect(result.contacts.contactRows).toHaveLength(1);
    expect(result.contacts.contactRows[0]?.rawRole).toBe("CONTRACTOR");
  });

  it("recognizes unique real THEAD headings despite Telerik's blank tbody filler", () => {
    const filler = (bytes: string, columns: number): string =>
      bytes.replace("</thead>", `</thead><tbody><tr><td colspan="${columns}"></td></tr></tbody>`);
    const contacts = filler(
      grid("rgContactInfo", CONTACT_HEADERS, [["CONTRACTOR", "SYNTHETIC FIRM", "", "", "", ""]]),
      6,
    );
    const inspections = filler(
      grid("rgInspectionInfo", INSPECTION_HEADERS, [
        ["SYNTHETIC EVENT", "1", "SYNTHETIC RESULT", "02/29/2020", "", "03/01/2020", "", ""],
      ]),
      8,
    );
    const result = extractRetainedPermitObservations(input(html({ contacts, inspections })));
    expect(result.contacts.headers).toEqual(CONTACT_HEADERS);
    expect(result.inspections.headers).toEqual(INSPECTION_HEADERS);
    expect(result.contacts.headerTables[0]?.rows).toEqual([CONTACT_HEADERS, [""]]);
    expect(result.inspections.headerTables[0]?.rows).toEqual([INSPECTION_HEADERS, [""]]);
    expect(result.contacts.headerTables[0]?.headingRows).toEqual([CONTACT_HEADERS]);
    expect(result.inspections.headerTables[0]?.headingRows).toEqual([INSPECTION_HEADERS]);
    expect(result.contacts.state).toBe("confirmed_present");
    expect(result.inspections.state).toBe("confirmed_present");
    expect(result.contacts.contactRows[0]?.rawRole).toBe("CONTRACTOR");
    expect(result.contacts.dataRowCount).toBe(1);
    expect(result.inspections.dataRowCount).toBe(1);
  });

  it("keeps multiple relevant THEAD heading rows ambiguous, even with a blank tbody filler", () => {
    const contacts = grid("rgContactInfo", CONTACT_HEADERS, [
      ["CONTRACTOR", "SYNTHETIC FIRM", "", "", "", ""],
    ]).replace(
      "</thead>",
      `<tr>${CONTACT_HEADERS.map((heading) => `<th>${heading}</th>`).join("")}</tr></thead><tbody><tr><td colspan="6"></td></tr></tbody>`,
    );
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.headerTables[0]?.rows).toHaveLength(3);
    expect(result.contacts.headerTables[0]?.headingRows).toHaveLength(2);
    expect(result.contacts.headers).toBeNull();
    expect(result.contacts.state).toBe("unknown");
    expect(result.contacts.holds).toContain("real_header_row_missing_or_ambiguous");
  });

  it("does not accept body-only TH rows as proven real THEAD headings", () => {
    const contacts = grid("rgContactInfo", CONTACT_HEADERS, [
      ["CONTRACTOR", "SYNTHETIC FIRM", "", "", "", ""],
    ])
      .replace("<thead>", "<tbody>")
      .replace("</thead>", "</tbody>");
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.headerTables[0]?.rows).toEqual([CONTACT_HEADERS]);
    expect(result.contacts.headerTables[0]?.headingRows).toEqual([]);
    expect(result.contacts.headers).toBeNull();
    expect(result.contacts.state).toBe("unknown");
  });

  it("preserves hidden header rows but does not select them as real visible headings", () => {
    const contacts = grid("rgContactInfo", CONTACT_HEADERS, [
      ["CONTRACTOR", "SYNTHETIC FIRM", "", "", "", ""],
    ]).replace("<thead>", '<thead style="display:none">');
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.headerTables[0]?.rows).toEqual([CONTACT_HEADERS]);
    expect(result.contacts.headerTables[0]?.headingRows).toEqual([]);
    expect(result.contacts.headers).toBeNull();
    expect(result.contacts.state).toBe("unknown");
  });

  it("keeps source headings and data cells positional when columns are reordered", () => {
    const contacts = grid(
      "rgContactInfo",
      ["Name", "Contact Type"],
      [["SYNTHETIC PERSON", "OWNER"]],
    );
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.headers).toEqual(["Name", "Contact Type"]);
    expect(result.contacts.contactRows[0]?.rawRole).toBe("OWNER");
    expect(result.contacts.contactRows[0]?.rawName).toBe("SYNTHETIC PERSON");
    expect(result.contacts.contactRows[0]?.row.cells[1]?.columnIndex).toBe(1);
  });

  it("does not promote a header-only grid into data or confirmed-empty", () => {
    const contacts = grid("rgContactInfo", CONTACT_HEADERS, [
      `<tr class="rgHeader">${CONTACT_HEADERS.map((heading) => `<td>${heading}</td>`).join("")}</tr>`,
    ]);
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.dataRowCount).toBe(0);
    expect(result.contacts.contactRows).toHaveLength(0);
    expect(result.contacts.state).toBe("unknown");
    expect(result.contacts.rows[1]?.kind).toBe("header");
  });

  it("preserves an explicit vendor empty marker without accepting contractor absence", () => {
    const contacts = grid("rgContactInfo", CONTACT_HEADERS, [
      '<tr class="rgNoRecords"><td colspan="6">No records to display.</td></tr>',
    ]);
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.explicitEmptyMarkerObserved).toBe(true);
    expect(result.contacts.dataRowCount).toBe(0);
    expect(result.contacts.state).toBe("unknown");
    expect(result.contacts.holds).toContain("empty_marker_not_accepted_absence_proof");
    expect(result.sourceProfileAccepted).toBe(false);
  });

  it("holds simultaneous data and empty markers as conflicting", () => {
    const contacts = grid(
      "rgContactInfo",
      ["Contact Type", "Name"],
      [
        ["CONTRACTOR", "SYNTHETIC FIRM"],
        '<tr class="rgNoRecords"><td colspan="2">No records</td></tr>',
      ],
    );
    expect(extractRetainedPermitObservations(input(html({ contacts }))).contacts.state).toBe(
      "conflicting",
    );
  });

  it("missing real headers never becomes a source-empty section", () => {
    const contacts = grid("rgContactInfo", CONTACT_HEADERS, [["OWNER", "SYNTHETIC OWNER"]], {
      omitHeader: true,
    });
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.headers).toBeNull();
    expect(result.contacts.rows[1]?.kind).toBe("ambiguous");
    expect(result.contacts.contactRows[0]?.rawRole).toBeNull();
    expect(result.contacts.state).toBe("unknown");
  });

  it.each(["data", "header"])(
    "retains all ambiguous duplicate %s tables without .first() selection",
    (duplicateKind) => {
      const original = grid(
        "rgContactInfo",
        ["Contact Type", "Name"],
        [["OWNER", "SYNTHETIC OWNER"]],
      );
      const duplicate =
        duplicateKind === "data"
          ? original.replace(/<table[^>]+_Header[\s\S]+?<\/table>/u, "")
          : original.slice(0, original.indexOf("</table>") + 8);
      const result = extractRetainedPermitObservations(
        input(html({ contacts: original + duplicate })),
      );
      expect(result.contacts.state).toBe("conflicting");
      if (duplicateKind === "data") expect(result.contacts.dataTables).toHaveLength(2);
      else expect(result.contacts.headerTables).toHaveLength(2);
    },
  );

  it("holds header/data control identities that do not correspond", () => {
    const contacts = grid(
      "rgContactInfo",
      ["Contact Type", "Name"],
      [["OWNER", "SYNTHETIC OWNER"]],
      { headerId: "ctl00_cplMain_ctl98_rgContactInfo_ctl00_Header" },
    );
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.state).toBe("unknown");
    expect(result.contacts.holds).toContain("header_data_control_identity_mismatch");
  });

  it.each([
    { headings: ["Unrecognized Role", "Name"] },
    { headings: ["Contact Type", ""] },
    { headings: ["Name", "Name"] },
  ])("retains unknown/missing/duplicate headings $headings with holds", ({ headings }) => {
    const result = extractRetainedPermitObservations(
      input(
        html({
          contacts: grid("rgContactInfo", headings, [["SYNTHETIC VALUE", "SYNTHETIC VALUE"]]),
        }),
      ),
    );
    expect(result.contacts.state).toBe("unknown");
    expect(result.contacts.headers).toEqual(headings);
    expect(result.contacts.holds.length).toBeGreaterThan(0);
  });

  it("retains a malformed row without assigning positional values to roles/names", () => {
    const contacts = grid("rgContactInfo", CONTACT_HEADERS, [["SYNTHETIC SINGLE CELL"]]);
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.contactRows[0]?.row.cells[0]?.rawValue).toBe("SYNTHETIC SINGLE CELL");
    expect(result.contacts.contactRows[0]?.row.kind).toBe("ambiguous");
    expect(result.contacts.contactRows[0]?.rawRole).toBeNull();
    expect(result.contacts.contactRows[0]?.rawName).toBeNull();
  });

  it("preserves hidden source columns but excludes hidden state inputs from text", () => {
    const contacts = grid(
      "rgContactInfo",
      ["Contact Type", "Name"],
      [
        '<tr class="rgRow"><td>OWNER</td><td style="display:none">SYNTHETIC OWNER<input type="hidden" value="SYNTHETIC-SECRET-STATE"></td></tr>',
      ],
    );
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.contactRows[0]?.row.cells[1]?.hiddenByMarkup).toBe(true);
    expect(result.contacts.contactRows[0]?.rawName).toBe("SYNTHETIC OWNER");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC-SECRET-STATE");
  });
});

describe("original lifecycle labels and calendar-only validation", () => {
  it.each([
    { raw: "1/5/2015", iso: "2015-01-05" },
    { raw: "2/20/2015", iso: "2015-02-20" },
    { raw: "02/1/2015", iso: "2015-02-01" },
    { raw: "2/01/2015", iso: "2015-02-01" },
    { raw: "12/31/2015", iso: "2015-12-31" },
    { raw: "2/29/2020", iso: "2020-02-29" },
    { raw: "02/29/2000", iso: "2000-02-29" },
    { raw: " 1/5/2015 ", iso: "2015-01-05" },
  ])(
    "preserves source M/D/YYYY text $raw while padding calendar observation $iso",
    ({ raw, iso }) => {
      const result = extractRetainedPermitObservations(input(html({ finaled: raw })));
      expect(result.lifecycle.finaled.controls[0]?.rawValue).toBe(raw);
      expect(result.lifecycle.finaled.calendarObservations[0]).toMatchObject({
        rawValue: raw,
        state: "confirmed_present",
        isoDate: iso,
      });
      expect(result.decisions.roofAnchorDate).toBeNull();
      expect(result.decisions.isCompleted).toBeNull();
      expect(result.sourceProfileAccepted).toBe(false);
    },
  );

  it.each([
    "13/1/2015",
    "1/32/2015",
    "2/29/2015",
    "2/30/2020",
    "0/5/2015",
    "1/0/2015",
    "1/5/15",
    "1/5/",
    "1//2015",
    "1/5/2015/00",
    "1-5-2015",
    "05.01.2015",
    "2015/1/5",
    "20/2/2015",
    "0001-1-1",
  ])(
    "quarantines invalid/incomplete/unsupported calendar $raw without date-order guessing: %s",
    (raw) => {
      const result = extractRetainedPermitObservations(input(html({ finaled: raw })));
      expect(result.lifecycle.finaled.controls[0]?.rawValue).toBe(raw);
      expect(result.lifecycle.finaled.calendarObservations[0]).toMatchObject({
        rawValue: raw,
        state: "invalid_quarantined",
        isoDate: null,
      });
      expect(result.decisions.roofAnchorDate).toBeNull();
      expect(result.sourceProfileAccepted).toBe(false);
    },
  );

  it("keeps Applied/Approved/Issued/Finaled/Expiration labels as separate raw controls", () => {
    const result = extractRetainedPermitObservations(input(html()));
    expect(result.lifecycle.finaled.controls[0]?.sourceLabels[0]?.rawValue).toBe("Finaled Date:");
    expect(result.lifecycle.finaled.controls[0]?.rawValue).toBe("03/01/2020");
    expect(result.lifecycle.finaled.calendarObservations[0]?.isoDate).toBe("2020-03-01");
    expect(result.lifecycle.applied.calendarObservations[0]?.isoDate).toBe("2020-01-01");
    expect(result.lifecycle.issued.calendarObservations[0]?.isoDate).toBe("2020-01-03");
    expect(result.decisions.isCompleted).toBeNull();
    expect(result.decisions.roofAnchorDate).toBeNull();
    expect(Object.keys(result.lifecycle)).toEqual([
      "applied",
      "approved",
      "issued",
      "finaled",
      "expiration",
    ]);
  });

  it.each([
    "02/30/2020",
    "02/29/2019",
    "13/01/2020",
    "00/01/2020",
    "03/01/2020 imported",
    "2020-03-01T00:00:00Z",
    "0000-01-01",
  ])("quarantines invalid source calendar or lexical date %s without losing text", (finaled) => {
    const result = extractRetainedPermitObservations(input(html({ finaled })));
    expect(result.lifecycle.finaled.state).toBe("invalid_quarantined");
    expect(result.lifecycle.finaled.controls[0]?.rawValue).toBe(finaled);
    expect(result.lifecycle.finaled.calendarObservations[0]?.isoDate).toBeNull();
    expect(result.decisions.roofAnchorDate).toBeNull();
  });

  it("does not turn a blank labelled Finaled control into confirmed-empty", () => {
    const result = extractRetainedPermitObservations(input(html({ finaled: " " })));
    expect(result.lifecycle.finaled.state).toBe("unknown");
    expect(result.lifecycle.finaled.controls[0]?.rawValue).toBe(" ");
    expect(result.lifecycle.finaled.controls[0]?.sourceLabels[0]?.rawValue).toBe("Finaled Date:");
  });

  it("does not invent retrospective range or chronology rules for future source observations", () => {
    const result = extractRetainedPermitObservations(input(html({ finaled: "03/01/2030" })));
    expect(result.lifecycle.finaled.state).toBe("confirmed_present");
    expect(result.lifecycle.expiration.state).toBe("confirmed_present");
    expect(result.lifecycle.expiration.calendarObservations[0]?.isoDate).toBe("2030-01-03");
    expect(result.decisions.isCompleted).toBeNull();
    expect(result.sourceProfileAccepted).toBe(false);
  });

  it("keeps a valid leap day and equal date observations without requiring three distinct anchors", () => {
    const bytes = html({ finaled: "02/29/2020" }).replace(/01\/0[123]\/2020/gu, "02/29/2020");
    const result = extractRetainedPermitObservations(input(bytes));
    expect(result.lifecycle.finaled.calendarObservations[0]?.isoDate).toBe("2020-02-29");
    expect(result.lifecycle.issued.calendarObservations[0]?.isoDate).toBe("2020-02-29");
    expect(result.lifecycle.finaled.semantics).toBe("source_label_only_not_a_decision_anchor");
    expect(result.decisions.roofAnchorDate).toBeNull();
  });
});

describe("inspection events, times, and frozen-row More Info control observations", () => {
  it("keeps Scheduled Date, Completed and both Time columns labelled and positioned", () => {
    const result = extractRetainedPermitObservations(input(html()));
    expect(result.inspections.headers).toEqual(INSPECTION_HEADERS);
    const event = result.inspections.inspectionRows[0];
    expect(
      event?.dateCells.map((cell) => [
        cell.columnIndex,
        cell.sourceLabel,
        cell.calendarObservation.isoDate,
      ]),
    ).toEqual([
      [3, "Scheduled Date", "2020-02-29"],
      [5, "Completed", "2020-03-01"],
    ]);
    expect(event?.row.cells[4]).toMatchObject({
      columnIndex: 4,
      headerRaw: "Time",
      rawValue: "08:00 AM",
    });
    expect(event?.row.cells[6]).toMatchObject({
      columnIndex: 6,
      headerRaw: "Time",
      rawValue: "09:00 AM",
    });
    expect(event?.eventSemantics).toBe("inspection_events_not_permit_or_roof_completion");
    expect(result.decisions.isCompleted).toBeNull();
  });

  it("future Scheduled Date remains a calendar-valid event observation", () => {
    const inspections = grid("rgInspectionInfo", INSPECTION_HEADERS, [
      ["SYNTHETIC EVENT", "1", "", "01/01/2030", "", "", "", ""],
    ]);
    const result = extractRetainedPermitObservations(input(html({ inspections })));
    expect(result.inspections.inspectionRows[0]?.dateCells[0]?.calendarObservation).toMatchObject({
      state: "confirmed_present",
      isoDate: "2030-01-01",
    });
    expect(result.decisions.isOpen).toBeNull();
  });

  it("keeps impossible inspection calendars quarantined at their source cell", () => {
    const inspections = grid("rgInspectionInfo", INSPECTION_HEADERS, [
      ["SYNTHETIC EVENT", "1", "", "02/30/2020", "", "02/29/2019", "", ""],
    ]);
    const event = extractRetainedPermitObservations(input(html({ inspections }))).inspections
      .inspectionRows[0];
    expect(
      event?.dateCells.every((cell) => cell.calendarObservation.state === "invalid_quarantined"),
    ).toBe(true);
    expect(event?.dateCells[0]?.calendarObservation.rawValue).toBe("02/30/2020");
  });

  it("retains exposed control and frozen-row locators without callback arguments or canonical ID claims", () => {
    const anchor = `<a id="ctl00_cplMain_ctl97_rgInspectionInfo_ctl00_ctl04_lbMoreInfo" onclick="openMoreInfo('INSPECTION','PERMIT','${SYNTHETIC_PERMIT}','JF:0000000000000000'); return false;" href="javascript:__doPostBack('SYNTHETIC-TOKEN','')">More Info</a>`;
    const row = `<tr class="rgRow">${["SYNTHETIC EVENT", "1", "", "", "", "", ""].map((cell) => `<td>${cell}</td>`).join("")}<td>${anchor}</td></tr>`;
    const result = extractRetainedPermitObservations(
      input(html({ inspections: grid("rgInspectionInfo", INSPECTION_HEADERS, [row]) })),
    );
    expect(result.inspections.inspectionRows[0]?.row.exposedInspectionControls).toEqual([
      {
        sourceControlId: "ctl00_cplMain_ctl97_rgInspectionInfo_ctl00_ctl04_lbMoreInfo",
        origin: "source_dom_control_not_canonical_inspection_id",
        canonicalInspectionId: null,
      },
    ]);
    expect(result.inspections.inspectionRows[0]?.row.moreInfoControlIds).toHaveLength(1);
    expect(result.inspections.inspectionRows[0]?.row.observationLocator).toMatchObject({
      kind: "frozen_raw_row_observation",
      rawSha256: input(html({ inspections: grid("rgInspectionInfo", INSPECTION_HEADERS, [row]) }))
        .rawSha256,
      dataTableIndex: 0,
      rowIndex: 1,
    });
    expect(JSON.stringify(result)).not.toContain("openMoreInfo");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC-TOKEN");
    expect(JSON.stringify(result)).not.toContain("__doPostBack");
    expect(JSON.stringify(result)).not.toContain("JF:0000000000000000");
  });

  it.each([
    "TOKEN:0000000000",
    "JF:0000000000'); steal('SYNTHETIC-SECRET",
    "SYNTHETIC-SECRET-OPAQUE",
  ])("does not serialize or infer identity from callback argument %s", (identifier) => {
    const row = `<tr class="rgRow">${["SYNTHETIC EVENT", "1", "", "", "", "", ""].map((cell) => `<td>${cell}</td>`).join("")}<td><a id="ctl00_cplMain_ctl97_rgInspectionInfo_ctl00_ctl04_lbMoreInfo" onclick="openMoreInfo('INSPECTION','PERMIT','${SYNTHETIC_PERMIT}','${identifier}'); return false;">More Info</a></td></tr>`;
    const result = extractRetainedPermitObservations(
      input(html({ inspections: grid("rgInspectionInfo", INSPECTION_HEADERS, [row]) })),
    );
    expect(result.inspections.inspectionRows[0]?.row.exposedInspectionControls).toHaveLength(1);
    expect(
      result.inspections.inspectionRows[0]?.row.exposedInspectionControls[0]?.canonicalInspectionId,
    ).toBeNull();
    expect(result.inspections.inspectionRows[0]?.row.moreInfoControlIds).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(identifier);
  });
});

describe("raw contact roles, license omissions and scope without identity promotion", () => {
  it("preserves all owner/applicant/provider/contractor/sub/unknown roles without defaulting contractor", () => {
    const roles = [
      "OWNER",
      "APPLICANT",
      "PRIVATE PROVIDER",
      "CONTRACTOR",
      "ROOFER",
      "SUBCONTRACTOR",
      "SYNTHETIC UNKNOWN ROLE",
    ];
    const contacts = grid(
      "rgContactInfo",
      ["Contact Type", "Name"],
      roles.map((role, index) => [role, `SYNTHETIC PERSON ${index}`]),
    );
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.contactRows.map((row) => row.rawRole)).toEqual(roles);
    expect(
      result.contacts.contactRows.every(
        (row) => row.roleClassification === "not_accepted" && row.companyId === null,
      ),
    ).toBe(true);
  });

  it("traces literal contact text separately without normalizing a canonical license", () => {
    const row = extractRetainedPermitObservations(input(html())).contacts.contactRows[0];
    expect(row?.contactTextTokens).toEqual([
      { rawToken: "CCC0000000", columnIndex: 1, origin: "permit_contact_text_observation" },
    ]);
    expect(row?.dedicatedLicenseColumnObservations).toHaveLength(0);
    expect(row?.permitPrintedLicense).toBeNull();
    expect(row?.officialLicenseIdentity).toBeNull();
  });

  it("does not fill omitted licenses from contractor login-directory tokens", () => {
    const contacts = grid(
      "rgContactInfo",
      ["Contact Type", "Name"],
      [["CONTRACTOR", "SYNTHETIC FIRM"]],
    );
    const extra =
      '<select name="SYNTHETIC_ddlSelContractor"><option value="CCC0000000">SYNTHETIC FIRM</option></select>';
    const result = extractRetainedPermitObservations(input(html({ contacts, extra })));
    expect(result.contacts.contactRows[0]?.contactTextTokens).toHaveLength(0);
    expect(result.contacts.contactRows[0]?.directoryCandidateLicense).toBeNull();
    expect(result.contacts.contactRows[0]?.permitPrintedLicense).toBeNull();
    expect(JSON.stringify(result)).not.toContain("CCC0000000");
  });

  it("retains multiple contacts, malformed text and dedicated license cells without legal conclusions", () => {
    const contacts = grid(
      "rgContactInfo",
      ["Contact Type", "Name", "License Number"],
      [
        ["CONTRACTOR", "SYNTHETIC FIRM-CCC1", "SYNTHETIC INVALID TOKEN"],
        ["CONTRACTOR", "SYNTHETIC OTHER-CCC0000001 CCC0000002", ""],
      ],
    );
    const result = extractRetainedPermitObservations(input(html({ contacts })));
    expect(result.contacts.contactRows).toHaveLength(2);
    expect(result.contacts.contactRows[0]?.contactTextTokens[0]?.rawToken).toBe("CCC1");
    expect(result.contacts.contactRows[0]?.dedicatedLicenseColumnObservations[0]?.rawValue).toBe(
      "SYNTHETIC INVALID TOKEN",
    );
    expect(result.contacts.contactRows[1]?.contactTextTokens).toHaveLength(2);
    expect(
      result.contacts.contactRows.every(
        (row) =>
          row.permitPrintedLicense === null &&
          row.officialLicenseIdentity === null &&
          row.companyId === null,
      ),
    ).toBe(true);
  });

  it.each([
    "SYNTHETIC primary roof replacement",
    "SYNTHETIC new construction",
    "SYNTHETIC repair/coating",
    "SYNTHETIC gazebo roof",
    "SYNTHETIC awning/carport/accessory",
    "SYNTHETIC ambiguous",
    "",
  ])("retains scope %s but does not accept a work/roof-age classifier", (description) => {
    const result = extractRetainedPermitObservations(input(html({ description })));
    expect(result.sourceFields.description.controls[0]?.rawValue).toBe(description);
    expect(result.decisions.primaryRoofWorkClass).toBeNull();
    expect(result.decisions.roofAnchorDate).toBeNull();
  });
});

describe("timestamps, historical status, privacy and deterministic seven-state evidence", () => {
  it("leaves capture time null despite export/certification/partition/notes-style timestamps", () => {
    const extra =
      '<div data-captured-at="2026-09-16T10:30:33.823Z">SYNTHETIC export timestamp 2026-09-16</div><input name="__VIEWSTATE" value="SYNTHETIC-SECRET-VIEWSTATE"><script>const secret = "SYNTHETIC-SECRET-SCRIPT";</script>';
    const result = extractRetainedPermitObservations(input(html({ extra })));
    expect(result.provenance.capturedAt).toBeNull();
    expect(result.provenance.captureTimeOrigin).toBe("not_established");
    expect(result.fields.perRecordCapturedAt.state).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC-SECRET");
  });

  it("accepts only an explicit caller-verified original per-record receipt bound to these bytes", () => {
    const boundInput = input(html());
    const result = extractRetainedPermitObservations({
      ...boundInput,
      captureReceipt: {
        verified: true,
        rawSha256: boundInput.rawSha256,
        receiptSha256: "c".repeat(64),
        capturedAt: "2026-09-15T12:34:56.123Z",
      },
    });
    expect(result.provenance.capturedAt).toBe("2026-09-15T12:34:56.123Z");
    expect(result.provenance.captureReceiptSha256).toBe("c".repeat(64));
    expect(result.fields.perRecordCapturedAt.state).toBe("confirmed_present");
    expect(result.decisions.isOpen).toBeNull();
  });

  it.each([
    "2026-02-30T12:34:56Z",
    "2026-09-15T24:00:00Z",
    "2026-09-15T00:60:00Z",
    "2026-09-15T00:00:60Z",
    "2026-09-17T00:00:00Z",
    "2026-09-15T00:00:00+00:00",
  ])("rejects invalid/unverified future receipt timestamp %s", (capturedAt) => {
    const boundInput = input(html());
    expect(() =>
      extractRetainedPermitObservations({
        ...boundInput,
        captureReceipt: {
          verified: true,
          rawSha256: boundInput.rawSha256,
          receiptSha256: "c".repeat(64),
          capturedAt,
        },
      }),
    ).toThrow(/timestamp/u);
  });

  it("rejects per-record receipts for another artifact", () => {
    expect(() =>
      extractRetainedPermitObservations(
        input(html(), {
          captureReceipt: {
            verified: true,
            rawSha256: "d".repeat(64),
            receiptSha256: "c".repeat(64),
            capturedAt: "2026-09-15T00:00:00Z",
          },
        }),
      ),
    ).toThrow(/bound to this raw artifact/u);
  });

  it.each(["ISSUED", "FINALED", "EXPIRED", "VOID", "REJECTED", "SYNTHETIC UNMAPPED STATUS"])(
    "status %s stays historical observation, never current open/completed",
    (status) => {
      const result = extractRetainedPermitObservations(input(html({ status })));
      expect(result.sourceFields.status.value).toBe(status);
      expect(result.fields.currentOpenStatus.state).toBe("unknown");
      expect(result.fields.completionStatus.state).toBe("unknown");
      expect(result.decisions.isOpen).toBeNull();
      expect(result.decisions.isCompleted).toBeNull();
    },
  );

  it("requires credential-free provenance rather than returning gateway/session tokens", () => {
    expect(() =>
      extractRetainedPermitObservations(
        input(html(), { sourceUri: "https://official.example/permit?token=SYNTHETIC-SECRET" }),
      ),
    ).toThrow(/credential-free/u);
    expect(() =>
      extractRetainedPermitObservations(
        input(html(), { sourceUri: "https://name:SYNTHETIC-SECRET@official.example/permit" }),
      ),
    ).toThrow(/credential-free/u);
  });

  it("replays identically, never mutates input and conserves every fixed field over seven states", () => {
    const boundInput = Object.freeze(input(html()));
    const before = JSON.stringify(boundInput);
    const first = extractRetainedPermitObservations(boundInput);
    const second = extractRetainedPermitObservations(boundInput);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(boundInput)).toBe(before);
    expect(Object.keys(first.fields)).toEqual([...OBSERVATION_EVIDENCE_FIELDS]);
    for (const field of OBSERVATION_EVIDENCE_FIELDS) {
      expect(Object.keys(first.counts[field])).toEqual([...EVIDENCE_STATES]);
      expect(Object.values(first.counts[field]).reduce((sum, count) => sum + count, 0)).toBe(1);
      expect(first.counts[field][first.fields[field].state]).toBe(1);
    }
    expect(first.sourceProfileAccepted).toBe(false);
    expect(first.decisionPromotion).toBe(false);
    expect(first.productionEligible).toBe(false);
    expect(first.decisions).toEqual({
      isOpen: null,
      isCompleted: null,
      primaryRoofWorkClass: null,
      roofAnchorDate: null,
      permitPrintedLicense: null,
      officialLicenseIdentity: null,
      contractorCompanyId: null,
      outcome: "needs_review",
    });
  });
});
