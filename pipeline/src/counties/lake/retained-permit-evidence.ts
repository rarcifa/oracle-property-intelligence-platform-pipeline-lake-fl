/**
 * Private, versioned inspection of retained permit observations. This module
 * performs no ingestion, identity resolution, status refresh, or publication.
 * Exported observations are not a live detail response or an accepted source
 * profile: preserve them and keep unsupported decision fields null.
 */
export const RETAINED_EVIDENCE_VERSION = "lake-retained-permit-evidence/v1";

export const EVIDENCE_STATES = [
  "confirmed_present",
  "confirmed_empty",
  "unavailable",
  "stale",
  "conflicting",
  "invalid_quarantined",
  "unknown",
] as const;

export type EvidenceState = (typeof EVIDENCE_STATES)[number];
export type RetainedValue =
  | string
  | number
  | boolean
  | null
  | readonly RetainedValue[]
  | { readonly [key: string]: RetainedValue | undefined };

export interface EvidenceProvenance {
  readonly uri: string;
  /** SHA-256 of immutable input bytes, not a name-derived identifier. */
  readonly sha256: string;
  /** null means the original observation timestamp is not established. */
  readonly capturedAt: string | null;
}

export interface RetainedPermitObservation {
  readonly permit_id: string;
  readonly permit_number: string | null;
  readonly source_system: string | null;
  readonly parcel_identifier?: string | null;
  readonly alt_key?: string | null;
  readonly jurisdiction?: string | null;
  readonly permit_type?: string | null;
  readonly permit_description?: string | null;
  readonly permit_status?: string | null;
  readonly applied_date?: string | null;
  readonly approved_date?: string | null;
  readonly issued_date?: string | null;
  readonly completed_date?: string | null;
  readonly last_modified_date?: string | null;
  readonly is_roofing?: boolean | null;
  readonly is_open?: boolean | null;
  readonly days_open?: number | null;
  readonly contractor_name?: string | null;
  readonly contractor_license?: string | null;
  readonly bbb_rating?: string | null;
  readonly source_url?: string | null;
  readonly linkage_status?: string | null;
  readonly [key: string]: RetainedValue | undefined;
}

export interface RetainedEvidenceContext {
  readonly asOfDate: string;
  readonly sourceInput: EvidenceProvenance;
  /**
   * Supply only after the selected raw contact name has been matched exactly to
   * an immutable Clermont capture/CSV. This is text provenance, not DBPR proof,
   * a contractor-role lookup, or a separately observed printed-license field.
   */
  readonly contactTextInput?: EvidenceProvenance;
  /** Optional range established by the caller's explicit source profile. */
  readonly minimumDate?: string;
}

export interface ValidatedValue<T> {
  readonly state: EvidenceState;
  readonly value: T | null;
  readonly rawValue: RetainedValue;
  readonly reason: string;
}

export interface FieldEvidence<T = string | number | boolean> extends ValidatedValue<T> {
  readonly sourceField: string | null;
  readonly provenance: EvidenceProvenance;
}

export const DECISION_EVIDENCE_FIELDS = [
  "permitIdentifier",
  "sourceUrl",
  "sourceStatusObservation",
  "currentOpenStatus",
  "completionStatus",
  "primaryRoofWorkClass",
  "roofAnchorDate",
  "appliedDate",
  "approvedDate",
  "issuedDate",
  "sourceFinaledOrCODate",
  "closeDate",
  "completionDate",
  "finalInspectionDate",
  "lastModifiedDate",
  "contractorContactName",
  "contractorRole",
  "permitContactTextLicense",
  "permitPrintedLicense",
  "officialLicenseIdentity",
  "contractorCompanyIdentity",
] as const;

export type DecisionEvidenceField = (typeof DECISION_EVIDENCE_FIELDS)[number];
export type EvidenceStateCounts = Record<EvidenceState, number>;
export type DecisionEvidenceCounts = Record<DecisionEvidenceField, EvidenceStateCounts>;

export type LicenseTraceOrigin =
  "permit_contact_text" | "directory_candidate_unverified" | "absent" | "conflicting" | "unknown";

export interface RetainedLicenseTrace {
  readonly origin: LicenseTraceOrigin;
  readonly permitContactTextLicense: string | null;
  /** Always null: no separately captured authoritative license field is supplied. */
  readonly permitPrintedLicense: null;
  readonly directoryCandidateLicense: string | null;
  readonly rawCombinedExportLicense: string | null;
  readonly rawContactName: string | null;
  readonly contactTextTokens: readonly string[];
  readonly verification: "not_dbpr_verified";
  readonly reason: string;
  readonly provenance: EvidenceProvenance;
}

export interface RetainedPermitEvidence {
  readonly version: typeof RETAINED_EVIDENCE_VERSION;
  readonly permitId: string;
  readonly asOfDate: string;
  readonly sourceObservations: RetainedPermitObservation;
  readonly fieldEvidence: Record<DecisionEvidenceField, FieldEvidence>;
  readonly licenseTrace: RetainedLicenseTrace;
  readonly lifecycleObservation: {
    readonly label: "FinaledDate" | "Permit_CODate" | "unclassified_export_date";
    readonly date: string | null;
    readonly independentCloseDate: null;
    readonly independentCompletionDate: null;
    readonly independentFinalInspectionDate: null;
    readonly reason: string;
  };
  readonly decisions: {
    readonly isOpen: null;
    readonly isCompleted: null;
    readonly primaryRoofWorkClass: null;
    readonly roofAnchorDate: null;
    readonly contractorCompanyId: null;
    readonly outcome: "needs_review";
  };
  readonly caveats: readonly string[];
}

const CLERMONT_SOURCE = "lake_clermont_etrakit_permits";
const CDPLUS_SOURCE = "lake_cdplus_permits";
// This is a literal-token tracer, not DBPR normalization or license validation.
// Prefixes and token shape mirror the frozen capture parser's extraction only.
const CONTACT_LICENSE_TOKEN = /\b(?:CCC|CGC|CBC|CRC|CFC|CMC|CAC|CVC|AEC|EC|CPC|CUC)\s?\d+\b/giu;
const CAPTURED_LICENSE_SHAPE = /^(?:CCC|CGC|CBC|CRC|CFC|CMC|CAC|CVC|AEC|EC|CPC|CUC)\d{4,10}$/u;

function parsedCalendarDate(raw: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > (daysInMonth[month - 1] ?? 0)) return null;
  return raw;
}

function requireAsOfDate(asOfDate: string): string {
  const parsed = parsedCalendarDate(asOfDate);
  if (parsed === null) throw new Error("asOfDate must be a valid Gregorian YYYY-MM-DD date");
  return parsed;
}

function nullResult<T>(
  state: EvidenceState,
  rawValue: RetainedValue,
  reason: string,
): ValidatedValue<T> {
  return { state, value: null, rawValue, reason };
}

/** Calendar validation only; usable observation dates are not completion anchors. */
export function validatedDate(
  raw: RetainedValue | undefined,
  options: { readonly asOfDate: string; readonly minimumDate?: string },
): ValidatedValue<string> {
  const asOfDate = requireAsOfDate(options.asOfDate);
  const minimumDate = options.minimumDate ?? "0001-01-01";
  if (parsedCalendarDate(minimumDate) === null || minimumDate > asOfDate) {
    throw new Error("minimumDate must be a valid Gregorian date no later than asOfDate");
  }
  const rawValue = raw ?? null;
  if (raw == null || raw === "" || (typeof raw === "string" && raw.trim() === "")) {
    return nullResult("unknown", rawValue, "blank export value does not prove source absence");
  }
  if (typeof raw !== "string" || parsedCalendarDate(raw) === null) {
    return nullResult("invalid_quarantined", rawValue, "invalid Gregorian YYYY-MM-DD date");
  }
  if (raw < minimumDate) {
    return nullResult("invalid_quarantined", rawValue, "date precedes the explicit accepted range");
  }
  if (raw > asOfDate) {
    return nullResult(
      "invalid_quarantined",
      rawValue,
      "date is in the future relative to asOfDate",
    );
  }
  return {
    state: "confirmed_present",
    value: raw,
    rawValue,
    reason: "valid retained date observation; source lifecycle semantics remain separate",
  };
}

/** A valid built/home year supports only a low-confidence proxy, never replacement absence. */
export function validatedBuiltYear(
  raw: RetainedValue | undefined,
  options: { readonly asOfDate: string; readonly minimumYear?: number },
): ValidatedValue<number> {
  const asOfYear = Number(requireAsOfDate(options.asOfDate).slice(0, 4));
  const minimumYear = options.minimumYear ?? 1;
  if (!Number.isInteger(minimumYear) || minimumYear < 1 || minimumYear > asOfYear) {
    throw new Error("minimumYear must be a positive integer no later than asOfYear");
  }
  const rawValue = raw ?? null;
  if (raw == null || raw === "" || (typeof raw === "string" && raw.trim() === "")) {
    return nullResult(
      "unknown",
      rawValue,
      "missing built year does not prove an empty source field",
    );
  }
  const year =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d{4}$/u.test(raw)
        ? Number(raw)
        : NaN;
  if (!Number.isInteger(year) || year < minimumYear || year > asOfYear) {
    return nullResult(
      "invalid_quarantined",
      rawValue,
      "invalid, out-of-range, or future built year",
    );
  }
  return {
    state: "confirmed_present",
    value: year,
    rawValue,
    reason: "low-confidence built-year proxy; partial history may hide a later roof replacement",
  };
}

function requireProvenance(value: EvidenceProvenance): void {
  if (value.uri.trim() === "" || !/^(?:sha256:)?[a-f0-9]{64}$/iu.test(value.sha256)) {
    throw new Error("evidence provenance requires an immutable URI and SHA-256 byte digest");
  }
  if (value.capturedAt !== null) {
    const day = value.capturedAt.slice(0, 10);
    const hour = Number(value.capturedAt.slice(11, 13));
    const minute = Number(value.capturedAt.slice(14, 16));
    const second = Number(value.capturedAt.slice(17, 19));
    if (
      parsedCalendarDate(day) === null ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value.capturedAt) ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      !Number.isFinite(Date.parse(value.capturedAt))
    ) {
      throw new Error("capturedAt must be a valid UTC observation timestamp or null");
    }
  }
}

function observation(
  raw: RetainedValue | undefined,
  sourceField: string,
  provenance: EvidenceProvenance,
): FieldEvidence<string> {
  const rawValue = raw ?? null;
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ...nullResult<string>("unknown", rawValue, "blank export is not confirmed source absence"),
      sourceField,
      provenance,
    };
  }
  return {
    state: "confirmed_present",
    value: raw,
    rawValue,
    sourceField,
    provenance,
    reason:
      "retained literal source observation only; not a current/live or legal-identity conclusion",
  };
}

function unsupported(
  raw: RetainedValue | undefined,
  sourceField: string | null,
  provenance: EvidenceProvenance,
  reason: string,
): FieldEvidence {
  return { ...nullResult("unknown", raw ?? null, reason), sourceField, provenance };
}

function licenseEvidence(
  row: RetainedPermitObservation,
  context: RetainedEvidenceContext,
): { trace: RetainedLicenseTrace; field: FieldEvidence<string> } {
  const rawName = row.contractor_name ?? null;
  const rawCombined = row.contractor_license ?? null;
  const provenance = context.contactTextInput ?? context.sourceInput;
  const base = {
    permitPrintedLicense: null,
    rawCombinedExportLicense: rawCombined,
    rawContactName: rawName,
    verification: "not_dbpr_verified",
    provenance,
  } as const;
  const unknown = (origin: "unknown" | "absent", reason: string) => ({
    trace: {
      ...base,
      origin,
      permitContactTextLicense: null,
      directoryCandidateLicense: null,
      contactTextTokens: [],
      reason,
    },
    field: unsupported(rawName, "contractor_name", provenance, reason) as FieldEvidence<string>,
  });
  if (row.source_system !== CLERMONT_SOURCE || context.contactTextInput === undefined) {
    return unknown(
      "unknown",
      "exact immutable Clermont contact-text lineage has not been supplied",
    );
  }
  if (rawName === null || rawName.trim() === "") {
    return unknown(
      rawCombined == null || rawCombined.trim() === "" ? "absent" : "unknown",
      "contact text is omitted; this does not prove no contractor or no printed license",
    );
  }
  const tokens = [
    ...new Set(
      [...rawName.matchAll(CONTACT_LICENSE_TOKEN)].map((match) =>
        match[0].toUpperCase().replace(/\s/gu, ""),
      ),
    ),
  ];
  const malformed = tokens.some((token) => !CAPTURED_LICENSE_SHAPE.test(token));
  const combined = rawCombined === null ? null : rawCombined.toUpperCase().replace(/\s/gu, "");
  const soleToken = tokens.length === 1 ? (tokens[0] ?? null) : null;
  if (
    malformed ||
    tokens.length > 1 ||
    (soleToken !== null && combined !== null && combined !== "" && combined !== soleToken)
  ) {
    const state = malformed ? "invalid_quarantined" : "conflicting";
    const reason = malformed
      ? "contact-text license-like token fails the frozen extraction shape; quarantined"
      : "multiple contact tokens or disagreement with combined legacy export; no precedence proven";
    return {
      trace: {
        ...base,
        origin: "conflicting",
        permitContactTextLicense: null,
        directoryCandidateLicense: null,
        contactTextTokens: tokens,
        reason,
      },
      field: {
        ...nullResult<string>(state, rawName, reason),
        sourceField: "contractor_name",
        provenance,
      },
    };
  }
  if (soleToken !== null) {
    const reason =
      "literal license token printed in retained contact text only; not a dedicated permit-license field or DBPR verification";
    return {
      trace: {
        ...base,
        origin: "permit_contact_text",
        permitContactTextLicense: soleToken,
        directoryCandidateLicense: null,
        contactTextTokens: tokens,
        reason,
      },
      field: {
        state: "confirmed_present",
        value: soleToken,
        rawValue: rawName,
        sourceField: "contractor_name",
        provenance,
        reason,
      },
    };
  }
  if (rawCombined !== null && rawCombined.trim() !== "") {
    const reason =
      "legacy Clermont directory fallback candidate only; raw permit license omission stays omitted and company identity remains unresolved";
    return {
      trace: {
        ...base,
        origin: "directory_candidate_unverified",
        permitContactTextLicense: null,
        directoryCandidateLicense: rawCombined,
        contactTextTokens: [],
        reason,
      },
      field: unsupported(rawName, "contractor_name", provenance, reason) as FieldEvidence<string>,
    };
  }
  return unknown(
    "absent",
    "no license token observed in retained selected contact text; authoritative printed-license field not established",
  );
}

/** Produce a deterministic retained-observation ledger with fail-closed decisions. */
export function deriveRetainedPermitEvidence(
  row: RetainedPermitObservation,
  context: RetainedEvidenceContext,
): RetainedPermitEvidence {
  const asOfDate = requireAsOfDate(context.asOfDate);
  requireProvenance(context.sourceInput);
  if (context.contactTextInput !== undefined) requireProvenance(context.contactTextInput);
  if (row.permit_id.trim() === "") throw new Error("retained permit requires its frozen permit_id");
  const provenance = { ...context.sourceInput };
  const contactProvenance =
    context.contactTextInput === undefined ? undefined : { ...context.contactTextInput };
  const sourceObservations = structuredClone(row);
  const lifecycleLabel =
    row.source_system === CLERMONT_SOURCE
      ? "FinaledDate"
      : row.source_system === CDPLUS_SOURCE
        ? "Permit_CODate"
        : "unclassified_export_date";
  const dateOptions = { asOfDate, minimumDate: context.minimumDate };
  const date = (raw: RetainedValue | undefined, field: string): FieldEvidence<string> => ({
    ...validatedDate(raw, dateOptions),
    sourceField: field,
    provenance,
  });
  const lifecycleDate = date(row.completed_date, lifecycleLabel);
  const licenses = licenseEvidence(row, {
    ...context,
    sourceInput: provenance,
    contactTextInput: contactProvenance,
  });
  const unknown = (raw: RetainedValue | undefined, field: string | null, reason: string) =>
    unsupported(raw, field, provenance, reason);
  const statusReason =
    "no accepted source-profile status semantics or live-detail revalidation; legacy !is_open is not completion";
  const completionReason = `${lifecycleLabel} is one retained source field, not independent close/completion/final-inspection evidence; no accepted completion semantics`;
  const fields: Record<DecisionEvidenceField, FieldEvidence> = {
    permitIdentifier: observation(row.permit_id, "permit_id", provenance),
    sourceUrl: observation(row.source_url, "source_url", provenance),
    sourceStatusObservation: observation(row.permit_status, "permit_status", provenance),
    currentOpenStatus: unknown(row.is_open, "is_open", statusReason),
    completionStatus: unknown(row.permit_status, "permit_status", statusReason),
    primaryRoofWorkClass: unknown(
      row.permit_description,
      "permit_description",
      "regex roofing flag and broad type are discovery observations only; no profile-tested primary-roof classifier",
    ),
    roofAnchorDate: unknown(
      row.completed_date,
      lifecycleLabel,
      "no accepted completed primary-roof work or lifecycle anchor; issue dates and !is_open cannot reset roof age",
    ),
    appliedDate: date(row.applied_date, "applied_date"),
    approvedDate: date(row.approved_date, "approved_date"),
    issuedDate: date(row.issued_date, "issued_date"),
    sourceFinaledOrCODate: lifecycleDate,
    closeDate: unknown(row.completed_date, lifecycleLabel, completionReason),
    completionDate: unknown(row.completed_date, lifecycleLabel, completionReason),
    finalInspectionDate: unknown(row.completed_date, lifecycleLabel, completionReason),
    lastModifiedDate: date(row.last_modified_date, "last_modified_date"),
    contractorContactName: observation(
      row.contractor_name,
      "contractor_name",
      contactProvenance ?? provenance,
    ),
    contractorRole: unknown(
      null,
      null,
      "selected contact role is not in the retained flat export; no role may be fabricated from name or selection",
    ),
    permitContactTextLicense: licenses.field,
    permitPrintedLicense: unknown(
      null,
      null,
      "no separately captured authoritative printed-license field; directory fallback and contact-text token must not populate raw license",
    ),
    officialLicenseIdentity: unknown(
      null,
      null,
      "adequate dated official DBPR license/qualifier/qualified-business history has not been provided",
    ),
    contractorCompanyIdentity: unknown(
      null,
      null,
      "no accepted Sunbiz plus temporally adequate DBPR resolution ledger; never merge or link similarly named companies",
    ),
  };
  return {
    version: RETAINED_EVIDENCE_VERSION,
    permitId: row.permit_id,
    asOfDate,
    sourceObservations,
    fieldEvidence: fields,
    licenseTrace: structuredClone(licenses.trace),
    lifecycleObservation: {
      label: lifecycleLabel,
      date: lifecycleDate.value,
      independentCloseDate: null,
      independentCompletionDate: null,
      independentFinalInspectionDate: null,
      reason: completionReason,
    },
    decisions: {
      isOpen: null,
      isCompleted: null,
      primaryRoofWorkClass: null,
      roofAnchorDate: null,
      contractorCompanyId: null,
      outcome: "needs_review",
    },
    caveats: [
      "Historical immutable export observations are not current/live detail evidence.",
      "A blank export field is not confirmed empty, unassigned, or proof of longitudinal absence.",
      "Partial permit history may hide a later primary-roof replacement; built-year proxies are low confidence only.",
      "Sunbiz and adequate temporal DBPR identity history are required before a new permit harvest or identity resolution.",
      "No acceptance of current open status, completed work, company identity, or a primary-roof anchor is implied.",
    ],
  };
}

export function createEvidenceStateCounts(): EvidenceStateCounts {
  return {
    confirmed_present: 0,
    confirmed_empty: 0,
    unavailable: 0,
    stale: 0,
    conflicting: 0,
    invalid_quarantined: 0,
    unknown: 0,
  };
}

/** Include zeroes for known partitions, not zeroes for unknown source inventories. */
export function countEvidenceStates(
  rows: readonly RetainedPermitEvidence[],
): DecisionEvidenceCounts {
  const counts = Object.fromEntries(
    DECISION_EVIDENCE_FIELDS.map((field) => [field, createEvidenceStateCounts()]),
  ) as DecisionEvidenceCounts;
  for (const row of rows) {
    for (const field of DECISION_EVIDENCE_FIELDS) {
      const state = row.fieldEvidence[field].state;
      if (!EVIDENCE_STATES.includes(state))
        throw new Error(`invalid evidence partition for ${field}`);
      counts[field][state] += 1;
    }
  }
  return counts;
}
