import { createHash } from "node:crypto";

import { load, type CheerioAPI } from "cheerio";

import {
  createEvidenceStateCounts,
  validatedDate,
  type EvidenceState,
  type EvidenceStateCounts,
} from "./retained-permit-evidence.js";

/** Isolated retrospective extraction. Never a live response or accepted profile. */
export const RETAINED_OBSERVATIONS_VERSION = "lake-retained-permit-observations/v1";

export const OBSERVATION_EVIDENCE_FIELDS = [
  "sourcePermitNumber",
  "capturedStatusObservation",
  "permitTypeObservation",
  "descriptionObservation",
  "notesObservation",
  "appliedDateObservation",
  "approvedDateObservation",
  "issuedDateObservation",
  "finaledDateObservation",
  "expirationDateObservation",
  "contactSectionObservation",
  "inspectionSectionObservation",
  "perRecordCapturedAt",
  "currentOpenStatus",
  "completionStatus",
  "primaryRoofWorkClass",
  "roofAnchorDate",
  "permitPrintedLicense",
  "officialLicenseIdentity",
  "contractorCompanyIdentity",
] as const;

export type ObservationEvidenceField = (typeof OBSERVATION_EVIDENCE_FIELDS)[number];

export interface VerifiedPerRecordCaptureReceipt {
  /** Caller attestation to a separately verified original per-record receipt. */
  readonly verified: true;
  readonly capturedAt: string;
  readonly receiptSha256: string;
  readonly rawSha256: string;
}

export interface ExtractRetainedPermitObservationsInput {
  readonly html: string;
  readonly expectedPermitNumber: string;
  readonly rawSha256: string;
  /** Binding only: this pure extractor is not supplied the extracted bytes. */
  readonly extractedSha256?: string | null;
  readonly sourceUri?: string | null;
  readonly asOfDate: string;
  readonly captureReceipt?: VerifiedPerRecordCaptureReceipt | null;
}

export interface SourceControlObservation {
  readonly sourceControlId: string;
  readonly sourceLabels: readonly { readonly sourceControlId: string; readonly rawValue: string }[];
  /** Decoded source text, without trimming or replacing the source bytes. */
  readonly rawValue: string;
}

export interface LiteralSourceObservation {
  readonly state: EvidenceState;
  readonly controls: readonly SourceControlObservation[];
  readonly value: string | null;
  readonly reason: string;
}

export interface CalendarObservation {
  readonly state: EvidenceState;
  readonly rawValue: string;
  readonly isoDate: string | null;
  readonly reason: string;
}

export interface SourceDateObservation extends LiteralSourceObservation {
  readonly calendarObservations: readonly CalendarObservation[];
  readonly semantics: "source_label_only_not_a_decision_anchor";
}

export interface RawGridCell {
  readonly columnIndex: number;
  readonly headerRaw: string | null;
  readonly rawValue: string;
  readonly hiddenByMarkup: boolean;
  readonly colspan: number;
}

export interface ExposedInspectionControlObservation {
  readonly sourceControlId: string;
  readonly origin: "source_dom_control_not_canonical_inspection_id";
  readonly canonicalInspectionId: null;
}

export interface RawGridRow {
  readonly dataTableIndex: number;
  readonly rowIndex: number;
  readonly sourceRowControlId: string | null;
  readonly kind: "data" | "header" | "dummy_header" | "empty_marker" | "ambiguous";
  readonly cells: readonly RawGridCell[];
  readonly holds: readonly string[];
  readonly exposedInspectionControls: readonly ExposedInspectionControlObservation[];
  readonly moreInfoControlIds: readonly string[];
  readonly observationLocator: {
    readonly kind: "frozen_raw_row_observation";
    readonly rawSha256: string;
    readonly gridName: "rgContactInfo" | "rgInspectionInfo";
    readonly dataTableControlId: string;
    readonly dataTableIndex: number;
    readonly rowIndex: number;
  };
}

export interface RawHeaderTable {
  readonly sourceControlId: string;
  /** Every observed row, including Telerik's blank tbody/colspan filler. */
  readonly rows: readonly (readonly string[])[];
  /** Real visible THEAD column-heading rows, not tbody layout/filler rows. */
  readonly headingRows: readonly (readonly string[])[];
}

export interface RawDataTable {
  readonly sourceControlId: string;
  readonly rows: readonly RawGridRow[];
}

export interface RawGridObservation {
  readonly state: EvidenceState;
  readonly headerTables: readonly RawHeaderTable[];
  readonly dataTables: readonly RawDataTable[];
  /** Includes hidden source columns, in order; never the dummy data-table thead. */
  readonly headers: readonly string[] | null;
  readonly rows: readonly RawGridRow[];
  readonly dataRowCount: number;
  readonly explicitEmptyMarkerObserved: boolean;
  readonly holds: readonly string[];
}

export interface ContactRowObservation {
  readonly row: RawGridRow;
  readonly rawRole: string | null;
  readonly rawName: string | null;
  readonly dedicatedLicenseColumnObservations: readonly RawGridCell[];
  readonly contactTextTokens: readonly {
    readonly rawToken: string;
    readonly columnIndex: number;
    readonly origin: "permit_contact_text_observation";
  }[];
  readonly directoryCandidateLicense: null;
  readonly permitPrintedLicense: null;
  readonly officialLicenseIdentity: null;
  readonly companyId: null;
  readonly roleClassification: "not_accepted";
}

export interface InspectionRowObservation {
  readonly row: RawGridRow;
  /** Column index distinguishes the two differently placed Time headings. */
  readonly dateCells: readonly {
    readonly columnIndex: number;
    readonly sourceLabel: string;
    readonly calendarObservation: CalendarObservation;
  }[];
  readonly eventSemantics: "inspection_events_not_permit_or_roof_completion";
}

export interface RetainedPermitObservations {
  readonly version: typeof RETAINED_OBSERVATIONS_VERSION;
  readonly asOfDate: string;
  readonly provenance: {
    readonly sourceUri: string | null;
    readonly rawSha256: string;
    readonly rawDigestVerification: "verified_against_supplied_html_utf8_bytes";
    readonly extractedSha256: string | null;
    readonly extractedDigestVerification: "caller_binding_only" | "not_supplied";
    readonly capturedAt: string | null;
    readonly captureReceiptSha256: string | null;
    readonly captureTimeOrigin: "caller_verified_per_record_receipt" | "not_established";
  };
  readonly identity: LiteralSourceObservation & {
    readonly expectedPermitNumber: string;
    readonly sourcePermitNumber: string | null;
    readonly holds: readonly string[];
  };
  readonly sourceFields: {
    readonly status: LiteralSourceObservation;
    readonly type: LiteralSourceObservation;
    readonly subtype: LiteralSourceObservation;
    readonly description: LiteralSourceObservation;
    readonly notes: LiteralSourceObservation;
  };
  readonly lifecycle: {
    readonly applied: SourceDateObservation;
    readonly approved: SourceDateObservation;
    readonly issued: SourceDateObservation;
    readonly finaled: SourceDateObservation;
    readonly expiration: SourceDateObservation;
  };
  readonly contacts: RawGridObservation & {
    readonly contactRows: readonly ContactRowObservation[];
  };
  readonly inspections: RawGridObservation & {
    readonly inspectionRows: readonly InspectionRowObservation[];
  };
  readonly fields: Record<
    ObservationEvidenceField,
    { readonly state: EvidenceState; readonly reason: string }
  >;
  readonly counts: Record<ObservationEvidenceField, EvidenceStateCounts>;
  readonly decisions: {
    readonly isOpen: null;
    readonly isCompleted: null;
    readonly primaryRoofWorkClass: null;
    readonly roofAnchorDate: null;
    readonly permitPrintedLicense: null;
    readonly officialLicenseIdentity: null;
    readonly contractorCompanyId: null;
    readonly outcome: "needs_review";
  };
  readonly sourceProfileAccepted: false;
  readonly decisionPromotion: false;
  readonly productionEligible: false;
  readonly holds: readonly string[];
}

type Selection = ReturnType<CheerioAPI>;

const CONTACT_TOKEN = /\b(?:CCC|CGC|CBC|CRC|CFC|CMC|CAC|CVC|AEC|EC|CPC|CUC)\s?\d+\b/giu;
const EMPTY_MARKER = /^\s*no records(?: to display| found)?[.!]?\s*$/iu;

function digest(value: string): string {
  if (!/^(?:sha256:)?[a-f0-9]{64}$/iu.test(value)) {
    throw new Error("immutable binding requires a SHA-256 digest");
  }
  return value.replace(/^sha256:/iu, "").toLowerCase();
}

function sourceText(selection: Selection): string {
  const copy = selection.clone();
  // No script/event-handler, ViewState, cookie, input, or login-directory payload.
  copy.find("script,style,noscript,input,textarea,select").remove();
  return copy.text();
}

function hiddenByMarkup(selection: Selection): boolean {
  return (
    selection.attr("hidden") !== undefined ||
    selection.attr("aria-hidden") === "true" ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/iu.test(
      selection.attr("style") ?? "",
    )
  );
}

function observeControl($: CheerioAPI, suffix: string): LiteralSourceObservation {
  const controls = $(`[id$="${suffix}"]`)
    .toArray()
    .map((element): SourceControlObservation => {
      const selection = $(element);
      const id = selection.attr("id") ?? "";
      // Exact label-control identities, not a neighboring arbitrary DOM text guess.
      const sourceLabels = $("[id$='Lbl'],[id$='Label'],label")
        .toArray()
        .filter(
          (label) =>
            $(label).attr("id") === `${id}Lbl` ||
            $(label).attr("id") === `${id}Label` ||
            ($(label).is("label") && $(label).attr("for") === id),
        )
        .map((label) => ({
          sourceControlId: $(label).attr("id") ?? "",
          rawValue: sourceText($(label)),
        }));
      return { sourceControlId: id, sourceLabels, rawValue: sourceText(selection) };
    });
  if (controls.length === 0)
    return {
      state: "unknown",
      controls,
      value: null,
      reason: "required source control was not observed",
    };
  if (controls.length !== 1)
    return {
      state: "conflicting",
      controls,
      value: null,
      reason: "duplicate source controls have no accepted precedence",
    };
  const rawValue = controls[0]?.rawValue ?? "";
  if (rawValue.trim() === "")
    return {
      state: "unknown",
      controls,
      value: null,
      reason: "blank retained source value is not proven absence",
    };
  return {
    state: "confirmed_present",
    controls,
    value: rawValue.trim(),
    reason: "literal retained source observation only; profile unaccepted",
  };
}

function calendarObservation(rawValue: string): CalendarObservation {
  const text = rawValue.trim();
  const usDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(text);
  const iso =
    usDate === null
      ? text
      : `${usDate[3]}-${usDate[1]?.padStart(2, "0")}-${usDate[2]?.padStart(2, "0")}`;
  // Maximum calendar date removes the validator's future-date restriction.
  // Scheduled events and expiration can legitimately lie after the review date.
  // No source chronology or lifecycle meaning is accepted by this module.
  const result = validatedDate(iso, { asOfDate: "9999-12-31" });
  return {
    state: result.state,
    rawValue,
    isoDate: result.value,
    reason:
      result.value === null
        ? result.reason
        : "calendar-valid retained text only; no chronology, freshness or lifecycle acceptance",
  };
}

function observeDate($: CheerioAPI, suffix: string): SourceDateObservation {
  const observation = observeControl($, suffix);
  const calendarObservations = observation.controls.map((control) =>
    calendarObservation(control.rawValue),
  );
  const calendar = calendarObservations[0];
  return {
    ...observation,
    state: observation.state === "conflicting" ? "conflicting" : (calendar?.state ?? "unknown"),
    // The literal text stays literal. Calendar ISO is separately labelled.
    value:
      observation.state === "conflicting" || calendar?.isoDate == null ? null : observation.value,
    reason:
      observation.state === "conflicting"
        ? observation.reason
        : (calendar?.reason ?? observation.reason),
    calendarObservations,
    semantics: "source_label_only_not_a_decision_anchor",
  };
}

function tableRows($: CheerioAPI, table: Selection): Selection[] {
  const element = table.get(0);
  return table
    .find("tr")
    .toArray()
    .filter((row) => $(row).closest("table").get(0) === element)
    .map((row) => $(row));
}

function inspectionControls($: CheerioAPI, row: Selection): ExposedInspectionControlObservation[] {
  // Exposed DOM IDs locate controls only within this immutable HTML. The
  // callback's many arg4 namespaces have no accepted canonical identity profile.
  // Never read, serialize, evaluate, or fetch onclick/href handler arguments.
  return row
    .find("[id$='_lbMoreInfo']")
    .toArray()
    .map((element) => $(element).attr("id") ?? "")
    .filter((id) =>
      /^(?:ctl\d+_)?cplMain_ctl\d+_rgInspectionInfo_ctl\d+(?:_ctl\d+)*_lbMoreInfo$/u.test(id),
    )
    .map((sourceControlId) => ({
      sourceControlId,
      origin: "source_dom_control_not_canonical_inspection_id",
      canonicalInspectionId: null,
    }));
}

function observeGrid(
  $: CheerioAPI,
  gridName: "rgContactInfo" | "rgInspectionInfo",
  rawSha256: string,
): RawGridObservation {
  const dataSelections = $(`table[id*='${gridName}'][id$='_ctl00']`)
    .toArray()
    .map((element) => $(element));
  const headerSelections = $(`table[id*='${gridName}'][id$='_ctl00_Header']`)
    .toArray()
    .map((element) => $(element));
  const headerTables = headerSelections.map((table): RawHeaderTable => {
    const rows = tableRows($, table);
    const values = (row: Selection): string[] =>
      row
        .children("th,td")
        .toArray()
        .map((cell) => sourceText($(cell)));
    return {
      sourceControlId: table.attr("id") ?? "",
      rows: rows.map(values),
      headingRows: rows
        .filter(
          (row) =>
            row.parents("thead").length !== 0 &&
            row.children("th").length !== 0 &&
            !hiddenByMarkup(row) &&
            !row
              .parents("thead")
              .toArray()
              .some((element) => hiddenByMarkup($(element))),
        )
        .map(values),
    };
  });
  const headerRows = headerTables[0]?.headingRows ?? [];
  const headers =
    headerTables.length === 1 && headerRows.length === 1 ? (headerRows[0] ?? null) : null;
  const holds: string[] = [];
  if (dataSelections.length !== 1)
    holds.push(dataSelections.length === 0 ? "data_table_missing" : "data_table_ambiguous");
  if (headerSelections.length !== 1)
    holds.push(
      headerSelections.length === 0 ? "real_header_table_missing" : "real_header_table_ambiguous",
    );
  if (headers === null || headers.length === 0 || headers.some((header) => header.trim() === ""))
    holds.push("real_header_row_missing_or_ambiguous");
  if (
    dataSelections.length === 1 &&
    headerSelections.length === 1 &&
    headerSelections[0]?.attr("id") !== `${dataSelections[0]?.attr("id")}_Header`
  )
    holds.push("header_data_control_identity_mismatch");
  if (headers !== null) {
    const knownHeadings =
      gridName === "rgContactInfo"
        ? [
            "Contact Type",
            "Role",
            "Contact Role",
            "Name",
            "Phone",
            "E-mail",
            "Address",
            "City/State/Zip",
            "License",
            "License Number",
            "License #",
          ]
        : ["Type", "SEQ#", "Result", "Scheduled Date", "Time", "Completed", "More Info"];
    if (headers.some((header) => !knownHeadings.includes(header.trim())))
      holds.push("unrecognized_source_heading");
    const duplicates = headers.filter(
      (header, index) =>
        headers.findIndex((candidate) => candidate.trim() === header.trim()) !== index,
    );
    if (
      duplicates.some((header) => gridName !== "rgInspectionInfo" || header.trim() !== "Time") ||
      headers.filter((header) => header.trim() === "Time").length > 2
    )
      holds.push("source_heading_ambiguous");
    if (
      gridName === "rgContactInfo" &&
      (!headers.some((header) =>
        ["Contact Type", "Role", "Contact Role"].includes(header.trim()),
      ) ||
        !headers.some((header) => header.trim() === "Name"))
    )
      holds.push("required_source_heading_missing");
    if (
      gridName === "rgInspectionInfo" &&
      ["Type", "SEQ#", "Result", "Scheduled Date", "Completed", "More Info"].some(
        (required) => !headers.some((header) => header.trim() === required),
      )
    )
      holds.push("required_source_heading_missing");
  }
  const dataTables = dataSelections.map((table, dataTableIndex): RawDataTable => ({
    sourceControlId: table.attr("id") ?? "",
    rows: tableRows($, table).map((row, rowIndex): RawGridRow => {
      const cells = row
        .children("th,td")
        .toArray()
        .map((cell, columnIndex): RawGridCell => ({
          columnIndex,
          headerRaw: headers?.[columnIndex] ?? null,
          rawValue: sourceText($(cell)),
          hiddenByMarkup: hiddenByMarkup($(cell)),
          colspan: /^\d+$/u.test($(cell).attr("colspan") ?? "")
            ? Number($(cell).attr("colspan"))
            : 1,
        }));
      const inThead = row.parents("thead").length !== 0;
      const dummy =
        inThead &&
        (hiddenByMarkup(row) ||
          row
            .parents("thead")
            .toArray()
            .some((element) => hiddenByMarkup($(element))) ||
          cells.every((cell) => cell.hiddenByMarkup));
      const explicitEmpty =
        /(?:^|\s)rgNoRecords(?:\s|$)/u.test(row.attr("class") ?? "") ||
        (cells.length === 1 && EMPTY_MARKER.test(cells[0]?.rawValue ?? ""));
      const copiedHeader =
        headers !== null &&
        cells.length === headers.length &&
        cells.every((cell, index) => cell.rawValue.trim() === headers[index]?.trim());
      const isHeader =
        inThead ||
        row.children("th").length !== 0 ||
        /(?:^|\s)rgHeader(?:\s|$)/u.test(row.attr("class") ?? "") ||
        copiedHeader;
      const rowHolds: string[] = [];
      let kind: RawGridRow["kind"] = dummy
        ? "dummy_header"
        : isHeader
          ? "header"
          : explicitEmpty
            ? "empty_marker"
            : "data";
      if (
        kind === "data" &&
        (headers === null ||
          cells.length !== headers.length ||
          cells.some((cell) => cell.colspan !== 1) ||
          cells.every((cell) => cell.rawValue.trim() === ""))
      ) {
        kind = "ambiguous";
        rowHolds.push("row_layout_or_value_ambiguous");
      }
      const exposedInspectionControls =
        gridName === "rgInspectionInfo" ? inspectionControls($, row) : [];
      return {
        dataTableIndex,
        rowIndex,
        sourceRowControlId: row.attr("id") ?? null,
        kind,
        cells,
        holds: rowHolds,
        exposedInspectionControls,
        moreInfoControlIds: exposedInspectionControls.map(
          (observation) => observation.sourceControlId,
        ),
        observationLocator: {
          kind: "frozen_raw_row_observation",
          rawSha256,
          gridName,
          dataTableControlId: table.attr("id") ?? "",
          dataTableIndex,
          rowIndex,
        },
      };
    }),
  }));
  const rows = dataTables.flatMap((table) => table.rows);
  const dataRowCount = rows.filter((row) => row.kind === "data").length;
  const explicitEmptyMarkerObserved = rows.some((row) => row.kind === "empty_marker");
  if (rows.some((row) => row.kind === "ambiguous")) holds.push("ambiguous_data_rows");
  if (explicitEmptyMarkerObserved && dataRowCount > 0) holds.push("empty_marker_and_data_disagree");
  if (dataRowCount === 0)
    holds.push(
      explicitEmptyMarkerObserved
        ? "empty_marker_not_accepted_absence_proof"
        : "no_data_rows_is_not_proven_empty",
    );
  const duplicate = dataSelections.length > 1 || headerSelections.length > 1;
  const state: EvidenceState =
    duplicate || (explicitEmptyMarkerObserved && dataRowCount > 0)
      ? "conflicting"
      : holds.length === 0
        ? "confirmed_present"
        : "unknown";
  return {
    state,
    headerTables,
    dataTables,
    headers,
    rows,
    dataRowCount,
    explicitEmptyMarkerObserved,
    holds,
  };
}

function uniquelyLabelledCell(row: RawGridRow, labels: readonly string[]): RawGridCell | null {
  if (row.kind !== "data") return null;
  const cells = row.cells.filter(
    (cell) => cell.headerRaw !== null && labels.includes(cell.headerRaw.trim()),
  );
  return cells.length === 1 ? (cells[0] ?? null) : null;
}

function contactObservations(grid: RawGridObservation): ContactRowObservation[] {
  return grid.rows
    .filter((row) => row.kind === "data" || row.kind === "ambiguous")
    .map((row) => {
      const role = uniquelyLabelledCell(row, ["Contact Type", "Role", "Contact Role"]);
      const name = uniquelyLabelledCell(row, ["Name"]);
      const dedicatedLicenseColumnObservations = row.cells.filter((cell) =>
        ["License", "License Number", "License #"].includes(cell.headerRaw?.trim() ?? ""),
      );
      // Trace literal tokens only in explicitly labelled Name cells, not addresses,
      // phone/email, login options, or a directory-derived legacy JSON field.
      const contactTextTokens =
        name === null
          ? []
          : [...name.rawValue.matchAll(CONTACT_TOKEN)].map((match) => ({
              rawToken: match[0],
              columnIndex: name.columnIndex,
              origin: "permit_contact_text_observation" as const,
            }));
      return {
        row,
        rawRole: role?.rawValue ?? null,
        rawName: name?.rawValue ?? null,
        dedicatedLicenseColumnObservations,
        contactTextTokens,
        directoryCandidateLicense: null,
        permitPrintedLicense: null,
        officialLicenseIdentity: null,
        companyId: null,
        roleClassification: "not_accepted",
      };
    });
}

function receiptTime(
  input: ExtractRetainedPermitObservationsInput,
  rawSha256: string,
): { capturedAt: string | null; receiptSha256: string | null } {
  const receipt = input.captureReceipt;
  if (receipt == null) return { capturedAt: null, receiptSha256: null };
  if (receipt.verified !== true || digest(receipt.rawSha256) !== rawSha256)
    throw new Error("capture receipt must be caller-verified and bound to this raw artifact");
  const timestamp = receipt.capturedAt;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(timestamp);
  if (
    match === null ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59 ||
    validatedDate(match[1], { asOfDate: input.asOfDate }).state !== "confirmed_present"
  )
    throw new Error(
      "capture receipt timestamp must be a valid UTC per-record timestamp no later than asOfDate",
    );
  return { capturedAt: timestamp, receiptSha256: digest(receipt.receiptSha256) };
}

function sourceUri(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value.trim() === "") throw new Error("sourceUri must be nonblank or null");
  // Provenance must not turn an authenticated gateway locator into a token dump.
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    const uri = new URL(value);
    if (
      !["file:", "https:", "http:", "memory:"].includes(uri.protocol) ||
      uri.username !== "" ||
      uri.password !== "" ||
      uri.search !== "" ||
      uri.hash !== ""
    )
      throw new Error(
        "sourceUri requires a credential-free immutable locator without query or fragment",
      );
  }
  return value;
}

/** Pure, deterministic, private observations; no network, files, matching, or writes. */
export function extractRetainedPermitObservations(
  input: ExtractRetainedPermitObservationsInput,
): RetainedPermitObservations {
  if (validatedDate(input.asOfDate, { asOfDate: input.asOfDate }).state !== "confirmed_present")
    throw new Error("asOfDate requires a valid Gregorian YYYY-MM-DD date");
  if (input.expectedPermitNumber.trim() === "")
    throw new Error("expectedPermitNumber must be a nonblank routing key");
  const rawSha256 = digest(input.rawSha256);
  if (createHash("sha256").update(input.html, "utf8").digest("hex") !== rawSha256)
    throw new Error("supplied HTML bytes disagree with immutable raw digest");
  const extractedSha256 = input.extractedSha256 == null ? null : digest(input.extractedSha256);
  const time = receiptTime(input, rawSha256);
  const $ = load(input.html);
  const sourceNumber = observeControl($, "_lblPermitNo");
  const identityHolds: string[] = [];
  let identityState = sourceNumber.state;
  let sourcePermitNumber = sourceNumber.value;
  if (sourceNumber.state !== "confirmed_present")
    identityHolds.push("explicit_unique_source_permit_number_required");
  if (sourceNumber.value !== null && sourceNumber.value !== input.expectedPermitNumber) {
    identityState = "invalid_quarantined";
    sourcePermitNumber = null;
    identityHolds.push("source_permit_number_mismatch");
  }
  const identity = {
    ...sourceNumber,
    state: identityState,
    value: sourcePermitNumber,
    sourcePermitNumber,
    expectedPermitNumber: input.expectedPermitNumber,
    holds: identityHolds,
    reason: identityHolds.length === 0 ? sourceNumber.reason : identityHolds.join("; "),
  };
  const sourceFields = {
    status: observeControl($, "_lblPermitStatus"),
    type: observeControl($, "_lblPermitType"),
    subtype: observeControl($, "_lblPermitSubtype"),
    description: observeControl($, "_lblPermitDesc"),
    notes: observeControl($, "_lblPermitNotes"),
  };
  const lifecycle = {
    applied: observeDate($, "_lblPermitAppliedDate"),
    approved: observeDate($, "_lblPermitApprovedDate"),
    issued: observeDate($, "_lblPermitIssuedDate"),
    finaled: observeDate($, "_lblPermitFinaledDate"),
    expiration: observeDate($, "_lblPermitExpirationDate"),
  };
  const contactGrid = observeGrid($, "rgContactInfo", rawSha256);
  const contacts = { ...contactGrid, contactRows: contactObservations(contactGrid) };
  const inspectionGrid = observeGrid($, "rgInspectionInfo", rawSha256);
  const inspections = {
    ...inspectionGrid,
    inspectionRows: inspectionGrid.rows
      .filter((row) => row.kind === "data" || row.kind === "ambiguous")
      .map((row): InspectionRowObservation => ({
        row,
        dateCells: row.cells
          .filter((cell) => ["Scheduled Date", "Completed"].includes(cell.headerRaw?.trim() ?? ""))
          .map((cell) => ({
            columnIndex: cell.columnIndex,
            sourceLabel: cell.headerRaw ?? "",
            calendarObservation: calendarObservation(cell.rawValue),
          })),
        eventSemantics: "inspection_events_not_permit_or_roof_completion",
      })),
  };
  const held = {
    state: "unknown",
    reason:
      "retrospective observations, unaccepted source profile and unresolved freshness/identity; no production decision promotion",
  } as const;
  const fields: RetainedPermitObservations["fields"] = {
    sourcePermitNumber: { state: identity.state, reason: identity.reason },
    capturedStatusObservation: sourceFields.status,
    permitTypeObservation: sourceFields.type,
    descriptionObservation: sourceFields.description,
    notesObservation: sourceFields.notes,
    appliedDateObservation: lifecycle.applied,
    approvedDateObservation: lifecycle.approved,
    issuedDateObservation: lifecycle.issued,
    finaledDateObservation: lifecycle.finaled,
    expirationDateObservation: lifecycle.expiration,
    contactSectionObservation: {
      state: contacts.state,
      reason: contacts.holds.join("; ") || "retained contact section observation only",
    },
    inspectionSectionObservation: {
      state: inspections.state,
      reason: inspections.holds.join("; ") || "retained inspection section observation only",
    },
    perRecordCapturedAt:
      time.capturedAt === null
        ? {
            state: "unknown",
            reason: "no verified original per-record capture timestamp; no substitute timestamps",
          }
        : {
            state: "confirmed_present",
            reason: "caller-verified original per-record receipt; not live freshness acceptance",
          },
    currentOpenStatus: held,
    completionStatus: held,
    primaryRoofWorkClass: held,
    roofAnchorDate: held,
    permitPrintedLicense: held,
    officialLicenseIdentity: held,
    contractorCompanyIdentity: held,
  };
  const counts = Object.fromEntries(
    OBSERVATION_EVIDENCE_FIELDS.map((field) => {
      const count = createEvidenceStateCounts();
      count[fields[field].state] = 1;
      return [field, count];
    }),
  ) as Record<ObservationEvidenceField, EvidenceStateCounts>;
  return {
    version: RETAINED_OBSERVATIONS_VERSION,
    asOfDate: input.asOfDate,
    provenance: {
      sourceUri: sourceUri(input.sourceUri),
      rawSha256,
      rawDigestVerification: "verified_against_supplied_html_utf8_bytes",
      extractedSha256,
      extractedDigestVerification:
        extractedSha256 === null ? "not_supplied" : "caller_binding_only",
      capturedAt: time.capturedAt,
      captureReceiptSha256: time.receiptSha256,
      captureTimeOrigin:
        time.capturedAt === null ? "not_established" : "caller_verified_per_record_receipt",
    },
    identity,
    sourceFields,
    lifecycle,
    contacts,
    inspections,
    fields,
    counts,
    decisions: {
      isOpen: null,
      isCompleted: null,
      primaryRoofWorkClass: null,
      roofAnchorDate: null,
      permitPrintedLicense: null,
      officialLicenseIdentity: null,
      contractorCompanyId: null,
      outcome: "needs_review",
    },
    sourceProfileAccepted: false,
    decisionPromotion: false,
    productionEligible: false,
    holds: [
      ...identityHolds,
      "source_profile_draft_unaccepted",
      "historical_status_not_current_live_status",
      "inspection_completed_is_not_permit_completion",
      "no_accepted_roof_anchor_or_legal_identity",
      "local_private_observations_not_submission_readiness",
    ],
  };
}
