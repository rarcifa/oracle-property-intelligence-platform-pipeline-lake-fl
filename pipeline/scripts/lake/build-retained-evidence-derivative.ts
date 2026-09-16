import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  DECISION_EVIDENCE_FIELDS,
  EVIDENCE_STATES,
  createEvidenceStateCounts,
  deriveRetainedPermitEvidence,
  validatedDate,
  validatedBuiltYear,
  type DecisionEvidenceField,
  type EvidenceState,
  type RetainedPermitObservation,
} from "../../src/counties/lake/retained-permit-evidence.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../../..");
export const DERIVATIVE_VERSION = "oracle.lake-retained-evidence.v1";
const BindingSchema = z.object({
  logicalPath: z.string(),
  absolutePath: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const FreezeSchema = z.object({
  candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourceBindings: z.array(BindingSchema.omit({ absolutePath: true })),
  evidenceBindings: z.array(BindingSchema),
  capture: z.object({
    approvedCommit: z.string(),
    baselineSha256: z.string(),
    artifacts: z.array(BindingSchema),
    yearCounts: z.array(
      z.object({
        year: z.number().int(),
        completed: z.number().int(),
        linked: z.number().int(),
        validUnlinked: z.number().int(),
      }),
    ),
  }),
});
const ReadinessSchema = z.object({
  sourceInventory: z.object({
    jurisdictions: z.array(
      z
        .object({
          key: z.string(),
          jurisdiction: z.string(),
          status: z.string(),
        })
        .passthrough(),
    ),
  }),
  sourceInventoryVersion: z.string().optional(),
  permitEvidence: z.object({
    sourcePeriods: z.array(
      z
        .object({
          sourceKey: z.string(),
          historicalPeriod: z
            .object({ permitNumberYear: z.number().int().optional() })
            .passthrough(),
          captured: z.number().int().optional(),
          capturedUnique: z.number().int().optional(),
        })
        .passthrough(),
    ),
  }),
});
const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const RowSchema = z.record(z.string(), ScalarSchema);
type StateCounts = Record<DecisionEvidenceField, Record<EvidenceState, number>>;
type Binding = z.infer<typeof BindingSchema>;

export function sqlLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not a valid local SQL path");
  return "'" + value.replaceAll("'", "''") + "'";
}

export function expandDerivativeSql(template: string, parameters: Record<string, string>): string {
  return template.replace(/\$[A-Z_]+/g, (token) => {
    const value = parameters[token];
    if (value === undefined) throw new Error("Missing SQL parameter: " + token);
    return value;
  });
}

function digest(file: string): { path: string; sizeBytes: number; sha256: string } {
  return {
    path: file,
    sizeBytes: statSync(file).size,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

function verifyBinding(binding: Binding): void {
  const actual = digest(binding.absolutePath);
  assert.equal(actual.sizeBytes, binding.sizeBytes, binding.logicalPath);
  assert.equal(actual.sha256, binding.sha256, binding.logicalPath);
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

function localEnvironment(): NodeJS.ProcessEnv {
  // Do not inherit AWS/Filebase/Pinata/GitHub/model tokens or source credentials.
  return { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR };
}

function physicalPath(filename: string): string {
  let ancestor = path.resolve(filename);
  const remainder: string[] = [];
  while (!existsSync(ancestor)) {
    remainder.unshift(path.basename(ancestor));
    const next = path.dirname(ancestor);
    if (next === ancestor) throw new Error("Cannot establish physical output containment");
    ancestor = next;
  }
  return path.join(realpathSync(ancestor), ...remainder);
}

function duckdb(sql: string, executable: string): string {
  return execFileSync(executable, [":memory:", "-json", "-c", sql], {
    encoding: "utf8",
    env: localEnvironment(),
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function* jsonLines(
  file: string,
): AsyncGenerator<Record<string, z.infer<typeof ScalarSchema>>> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line.trim()) yield RowSchema.parse(JSON.parse(line));
  } finally {
    lines.close();
    stream.destroy();
  }
}

function emptyCounts(): StateCounts {
  return Object.fromEntries(
    DECISION_EVIDENCE_FIELDS.map((field) => [field, createEvidenceStateCounts()]),
  ) as StateCounts;
}

function observeCounts(
  counts: StateCounts,
  evidence: ReturnType<typeof deriveRetainedPermitEvidence>,
): void {
  for (const field of DECISION_EVIDENCE_FIELDS)
    counts[field][evidence.fieldEvidence[field].state]++;
}

export interface DerivativeOptions {
  inputFreeze: string;
  readinessReport: string;
  output: string;
  asOfDate: string;
  duckdbExecutable?: string;
}

export async function buildRetainedEvidenceDerivative(options: DerivativeOptions) {
  if (!/^v22\./.test(process.version)) throw new Error("The retained runtime requires Node 22");
  const asOf = validatedDate(options.asOfDate, { asOfDate: options.asOfDate });
  if (asOf.value === null) throw new Error("A valid explicit as-of date is required");
  const output = path.resolve(options.output);
  if (existsSync(output)) throw new Error("Output must be a new, nonexistent private directory");
  const physicalOutput = physicalPath(output);
  const within = (parent: string) => {
    const physicalParent = physicalPath(parent);
    return (
      physicalOutput === physicalParent || physicalOutput.startsWith(physicalParent + path.sep)
    );
  };
  if (
    [
      REPOSITORY_ROOT,
      path.dirname(path.resolve(options.inputFreeze)),
      path.dirname(path.resolve(options.readinessReport)),
    ].some(within)
  ) {
    throw new Error("Private output must not alter the repository or a prior evidence packet");
  }
  const freeze = FreezeSchema.parse(JSON.parse(readFileSync(options.inputFreeze, "utf8")));
  const readiness = ReadinessSchema.parse(
    JSON.parse(readFileSync(options.readinessReport, "utf8")),
  );
  for (const binding of [...freeze.evidenceBindings, ...freeze.capture.artifacts])
    verifyBinding(binding);
  for (const binding of freeze.sourceBindings) {
    verifyBinding({ ...binding, absolutePath: path.join(REPOSITORY_ROOT, binding.logicalPath) });
  }
  const findInput = (logicalPath: string) => {
    const binding = freeze.evidenceBindings.find((item) => item.logicalPath === logicalPath);
    if (!binding) throw new Error("Missing frozen input: " + logicalPath);
    return binding;
  };
  const properties = findInput("query-table.parquet");
  const permits = findInput("permit-table.parquet");
  const contacts = findInput("inputs/clermont-permits.csv");
  const nal = findInput("inputs/NAL45P202601.csv");
  if (freeze.evidenceBindings.some((binding) => within(path.dirname(binding.absolutePath)))) {
    throw new Error("Output must not be inside a frozen source/analytical input directory");
  }
  const executable = options.duckdbExecutable ?? "duckdb";
  const sourceProof = duckdb(
    "SELECT count(*) AS csv_rows, count(DISTINCT permit_number) AS distinct_permits FROM read_csv_auto(" +
      sqlLiteral(contacts.absolutePath) +
      ", header=true, all_varchar=true);",
    executable,
  );
  const contactRows = z
    .array(
      z.object({
        csv_rows: z.number(),
        distinct_permits: z.number(),
      }),
    )
    .parse(JSON.parse(sourceProof))[0];
  assert.ok(contactRows);
  const certifiedClermont = freeze.capture.yearCounts.reduce(
    (sum, item) => sum + item.completed,
    0,
  );
  assert.equal(contactRows.csv_rows, certifiedClermont);
  assert.equal(contactRows.distinct_permits, certifiedClermont);
  const contactParity = JSON.parse(
    duckdb(
      "SELECT count(*) AS differences FROM read_parquet(" +
        sqlLiteral(permits.absolutePath) +
        ") p FULL OUTER JOIN read_csv_auto(" +
        sqlLiteral(contacts.absolutePath) +
        ", header=true, all_varchar=true) c ON p.source_system='lake_clermont_etrakit_permits' " +
        "AND p.permit_number=c.permit_number WHERE (p.source_system='lake_clermont_etrakit_permits' OR c.permit_number IS NOT NULL) " +
        "AND (p.permit_id IS NULL OR c.permit_number IS NULL OR p.contractor_name IS DISTINCT FROM nullif(trim(c.contractor_name),'') " +
        "OR p.contractor_license IS DISTINCT FROM nullif(trim(c.contractor_license),''));",
      executable,
    ),
  ) as { differences: number }[];
  assert.equal(contactParity[0]?.differences, 0, "Immutable contact-text export parity");
  mkdirSync(output, { mode: 0o700 });
  writeJson(path.join(output, "DO_NOT_PUBLISH.json"), {
    schemaVersion: "oracle.private-derivative-guard.v1",
    version: DERIVATIVE_VERSION,
    publicationApproved: false,
    releaseReady: false,
    countyComplete: false,
    reason:
      "Private retrospective derivative; official identity, source semantics and privacy/public-availability gates remain blocked",
  });
  const rawRows = path.join(output, "source-permit-observations.jsonl");
  const repairedRows = path.join(output, "retained-permit-evidence.jsonl");
  const quarantineFile = path.join(output, "quarantines.jsonl");
  duckdb(
    "COPY (SELECT * FROM read_parquet(" +
      sqlLiteral(permits.absolutePath) +
      ") ORDER BY permit_id) TO " +
      sqlLiteral(rawRows) +
      " (FORMAT JSON);",
    executable,
  );
  const rowsDescriptor = openSync(repairedRows, "wx", 0o600);
  const quarantineDescriptor = openSync(quarantineFile, "wx", 0o600);
  const counts = emptyCounts();
  const periodCounts = new Map<
    string,
    { source: string; period: string; rows: number; fields: StateCounts }
  >();
  const originCounts: Record<string, number> = {};
  const originals = new Map<string, string>();
  let rowCount = 0;
  let quarantineCount = 0;
  try {
    for await (const raw of jsonLines(rawRows)) {
      const row: RetainedPermitObservation = {
        ...raw,
        permit_id: z.string().min(1).parse(raw.permit_id),
        permit_number: z.string().nullable().parse(raw.permit_number),
        source_system: z.string().nullable().parse(raw.source_system),
      };
      assert.equal(originals.has(row.permit_id), false, "Duplicate frozen permit ID");
      originals.set(row.permit_id, JSON.stringify(raw));
      const clermont = row.source_system === "lake_clermont_etrakit_permits";
      const evidence = deriveRetainedPermitEvidence(row, {
        asOfDate: options.asOfDate,
        sourceInput: {
          uri: pathToFileURL(permits.absolutePath).href,
          sha256: permits.sha256,
          capturedAt: null,
        },
        ...(clermont
          ? {
              contactTextInput: {
                uri: pathToFileURL(contacts.absolutePath).href,
                sha256: contacts.sha256,
                capturedAt: null,
              },
            }
          : {}),
      });
      assert.deepEqual(evidence.sourceObservations, raw);
      observeCounts(counts, evidence);
      const period = clermont
        ? String(2000 + Number(row.permit_number?.slice(0, 2)))
        : "rolling-last-modified-window";
      const periodKey = row.source_system + ":" + period;
      const group = periodCounts.get(periodKey) ?? {
        source: row.source_system ?? "unknown",
        period,
        rows: 0,
        fields: emptyCounts(),
      };
      group.rows++;
      observeCounts(group.fields, evidence);
      periodCounts.set(periodKey, group);
      originCounts[evidence.licenseTrace.origin] =
        (originCounts[evidence.licenseTrace.origin] ?? 0) + 1;
      const fieldStates: Record<string, EvidenceState> = {};
      const reasons: Record<string, string> = {};
      for (const field of DECISION_EVIDENCE_FIELDS) {
        const fieldEvidence = evidence.fieldEvidence[field];
        fieldStates[field] = fieldEvidence.state;
        if (fieldEvidence.state !== "confirmed_present") reasons[field] = fieldEvidence.reason;
        if (fieldEvidence.state === "invalid_quarantined") {
          writeSync(
            quarantineDescriptor,
            JSON.stringify({
              permit_id: row.permit_id,
              field,
              ...fieldEvidence,
            }) + "\n",
          );
          quarantineCount++;
        }
      }
      const repaired = {
        ...raw,
        is_open: null,
        is_roofing: null,
        days_open: null,
        completed_date: null,
        contractor_license: null,
        current_permit_status: null,
        contractor_company_id: null,
        accepted_primary_roof_work_class: null,
        accepted_roof_anchor_date: null,
        permit_printed_license: null,
        source_observed_is_open: raw.is_open,
        source_observed_is_roofing: raw.is_roofing,
        source_export_days_open: raw.days_open,
        source_export_completed_date: raw.completed_date,
        source_export_contractor_license: raw.contractor_license,
        completion_source_label: evidence.lifecycleObservation.label,
        validated_source_finaled_or_co_date: evidence.lifecycleObservation.date,
        permit_contact_text_license: evidence.licenseTrace.permitContactTextLicense,
        directory_license_candidate: evidence.licenseTrace.directoryCandidateLicense,
        license_origin: evidence.licenseTrace.origin,
        license_verification: evidence.licenseTrace.verification,
        status_basis: "captured_observation_only; not live/current",
        decisions_outcome: evidence.decisions.outcome,
        evidence_states_json: JSON.stringify(fieldStates),
        evidence_review_reasons_json: JSON.stringify(reasons),
        source_observations_json: JSON.stringify(raw),
        source_input_sha256: permits.sha256,
        contact_text_input_sha256: clermont ? contacts.sha256 : null,
        observation_time: null,
        evidence_contract_version: DERIVATIVE_VERSION,
      };
      writeSync(rowsDescriptor, JSON.stringify(repaired) + "\n");
      rowCount++;
    }
  } finally {
    closeSync(rowsDescriptor);
    closeSync(quarantineDescriptor);
  }
  for (const field of DECISION_EVIDENCE_FIELDS) {
    assert.equal(
      EVIDENCE_STATES.reduce((sum, state) => sum + counts[field][state], 0),
      rowCount,
    );
  }
  for (const group of periodCounts.values())
    for (const field of DECISION_EVIDENCE_FIELDS) {
      assert.equal(
        EVIDENCE_STATES.reduce((sum, state) => sum + group.fields[field][state], 0),
        group.rows,
      );
    }
  for (const partition of readiness.permitEvidence.sourcePeriods) {
    if (partition.sourceKey === "lake_clermont_etrakit_permits") {
      assert.ok(partition.historicalPeriod.permitNumberYear);
      assert.ok(partition.captured !== undefined);
      assert.equal(
        periodCounts.get(partition.sourceKey + ":" + partition.historicalPeriod.permitNumberYear)
          ?.rows,
        partition.captured,
        "Preserved certified Clermont year partition",
      );
    } else if (partition.sourceKey === "lake_cdplus_permits") {
      assert.ok(partition.capturedUnique !== undefined);
      assert.equal(
        periodCounts.get(partition.sourceKey + ":rolling-last-modified-window")?.rows,
        partition.capturedUnique,
        "Preserved CD Plus unique snapshot records",
      );
    }
  }
  const propertyOutput = path.join(output, "query-table-retained-evidence.parquet");
  const permitOutput = path.join(output, "permit-table-retained-evidence.parquet");
  const templateFile = path.join(HERE, "build-retained-evidence-derivative.sql");
  const sql = expandDerivativeSql(readFileSync(templateFile, "utf8"), {
    $PROPERTY_INPUT: sqlLiteral(properties.absolutePath),
    $NAL_INPUT: sqlLiteral(nal.absolutePath),
    $EVIDENCE_INPUT: sqlLiteral(repairedRows),
    $PROPERTY_OUTPUT: sqlLiteral(propertyOutput),
    $PERMIT_OUTPUT: sqlLiteral(permitOutput),
    $AS_OF_YEAR: options.asOfDate.slice(0, 4),
  });
  writeFileSync(path.join(output, "expanded.sql"), sql, { flag: "wx", mode: 0o600 });
  duckdb(sql, executable);
  const verificationSql =
    "SELECT count(*) AS properties, count(DISTINCT request_identifier) AS distinct_folios, " +
    "count(*) FILTER (WHERE request_identifier IS NULL OR request_identifier='') AS null_folios, " +
    "count(*) FILTER (WHERE roof_age_basis NOT IN ('built_year_proxy') OR roof_last_permit_date IS NOT NULL) AS unsafe_roof_anchors, " +
    "count(*) FILTER (WHERE roof_age_years < 0 OR roof_age_years IS NOT NULL AND roof_age_confidence <> 'low') AS unsafe_ages, " +
    "count(*) FILTER (WHERE roof_age_years IS NOT NULL) AS built_year_proxies, " +
    "count(*) FILTER (WHERE roof_age_years >= 15) AS aged_built_year_proxies, " +
    "count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL) AS with_coordinates, " +
    "count(*) FILTER (WHERE open_permit_count IS NOT NULL OR open_roofing_permit_count IS NOT NULL " +
    "OR roofing_permit_count IS NOT NULL OR accepted_primary_roof_permit_count IS NOT NULL OR contractor_company_id IS NOT NULL) AS unsafe_conclusions " +
    "FROM read_parquet(" +
    sqlLiteral(propertyOutput) +
    ");";
  const propertyGate = JSON.parse(duckdb(verificationSql, executable)) as Record<string, number>[];
  const p = propertyGate[0];
  assert.ok(p);
  assert.equal(p.properties, p.distinct_folios);
  assert.equal(p.null_folios, 0);
  assert.equal(p.unsafe_roof_anchors, 0);
  assert.equal(p.unsafe_ages, 0);
  assert.equal(p.unsafe_conclusions, 0);
  const previousPropertyGate = JSON.parse(
    duckdb(
      "SELECT count(*) AS rows FROM read_parquet(" + sqlLiteral(properties.absolutePath) + ");",
      executable,
    ),
  ) as { rows: number }[];
  assert.equal(p.properties, previousPropertyGate[0]?.rows);
  const permitGate = JSON.parse(
    duckdb(
      "SELECT count(*) AS permits, count(DISTINCT permit_id) AS distinct_ids, " +
        "count(*) FILTER (WHERE permit_id IS NULL OR permit_id='') AS null_ids, " +
        "count(*) FILTER (WHERE linkage_status='linked_to_assessed_roll') AS linked, " +
        "count(*) FILTER (WHERE linkage_status='unlinked_to_assessed_roll') AS valid_unlinked, " +
        "count(*) FILTER (WHERE is_open IS NOT NULL OR is_roofing IS NOT NULL OR days_open IS NOT NULL " +
        "OR completed_date IS NOT NULL OR contractor_license IS NOT NULL OR accepted_roof_anchor_date IS NOT NULL " +
        "OR accepted_primary_roof_work_class IS NOT NULL OR contractor_company_id IS NOT NULL OR permit_printed_license IS NOT NULL) AS unsafe_conclusions " +
        "FROM read_parquet(" +
        sqlLiteral(permitOutput) +
        ");",
      executable,
    ),
  ) as Record<string, number>[];
  const m = permitGate[0];
  assert.ok(m);
  assert.equal(m.permits, rowCount);
  assert.equal(m.permits, m.distinct_ids);
  assert.equal(m.null_ids, 0);
  assert.equal(m.unsafe_conclusions, 0);
  assert.equal(m.permits, (m.linked ?? 0) + (m.valid_unlinked ?? 0));
  const readback = path.join(output, "source-observation-readback.jsonl");
  duckdb(
    "COPY (SELECT permit_id, source_observations_json FROM read_parquet(" +
      sqlLiteral(permitOutput) +
      ") ORDER BY permit_id) TO " +
      sqlLiteral(readback) +
      " (FORMAT JSON);",
    executable,
  );
  let readbackRows = 0;
  for await (const row of jsonLines(readback)) {
    assert.equal(row.source_observations_json, originals.get(String(row.permit_id)));
    readbackRows++;
  }
  assert.equal(readbackRows, rowCount);
  const propertyReadback = path.join(output, "property-year-readback.jsonl");
  const propertyQuarantines = path.join(output, "property-year-quarantines.jsonl");
  duckdb(
    "COPY (SELECT request_identifier, source_observed_built_year, source_observed_effective_built_year, " +
      "built_year, effective_built_year, built_year_evidence_state, effective_built_year_evidence_state, " +
      "roof_age_years, roof_age_confidence FROM read_parquet(" +
      sqlLiteral(propertyOutput) +
      ") ORDER BY request_identifier) TO " +
      sqlLiteral(propertyReadback) +
      " (FORMAT JSON);",
    executable,
  );
  const propertyFields = ["built_year", "effective_built_year"] as const;
  const propertyFieldEvidenceCounts = {
    built_year: createEvidenceStateCounts(),
    effective_built_year: createEvidenceStateCounts(),
  };
  let propertyReadbackRows = 0;
  let propertyQuarantineCount = 0;
  const propertyQuarantineDescriptor = openSync(propertyQuarantines, "wx", 0o600);
  try {
    for await (const row of jsonLines(propertyReadback)) {
      for (const field of propertyFields) {
        const validated = validatedBuiltYear(row["source_observed_" + field], {
          asOfDate: options.asOfDate,
          minimumYear: 1700,
        });
        assert.equal(row[field], validated.value, "TypeScript/SQL built-year contract parity");
        assert.equal(
          row[field + "_evidence_state"],
          validated.state,
          "Property field-state parity",
        );
        propertyFieldEvidenceCounts[field][validated.state]++;
        if (validated.state === "invalid_quarantined") {
          writeSync(
            propertyQuarantineDescriptor,
            JSON.stringify({
              request_identifier: row.request_identifier,
              field,
              ...validated,
              sourceField: field === "built_year" ? "ACT_YR_BLT" : "EFF_YR_BLT",
              provenance: {
                uri: pathToFileURL(nal.absolutePath).href,
                sha256: nal.sha256,
                capturedAt: null,
              },
            }) + "\n",
          );
          propertyQuarantineCount++;
        }
        if (field === "built_year") {
          assert.equal(
            row.roof_age_years,
            validated.value === null
              ? null
              : Number(options.asOfDate.slice(0, 4)) - validated.value,
          );
          assert.equal(row.roof_age_confidence, validated.value === null ? null : "low");
        }
      }
      propertyReadbackRows++;
    }
  } finally {
    closeSync(propertyQuarantineDescriptor);
  }
  assert.equal(propertyReadbackRows, p.properties);
  for (const field of propertyFields) {
    assert.equal(
      EVIDENCE_STATES.reduce((sum, state) => sum + propertyFieldEvidenceCounts[field][state], 0),
      propertyReadbackRows,
    );
  }
  for (const binding of [...freeze.evidenceBindings, ...freeze.capture.artifacts])
    verifyBinding(binding);
  const outputs = [
    propertyOutput,
    permitOutput,
    repairedRows,
    quarantineFile,
    rawRows,
    readback,
    propertyReadback,
    propertyQuarantines,
    path.join(output, "expanded.sql"),
    path.join(output, "DO_NOT_PUBLISH.json"),
  ].map(digest);
  const report = {
    schemaVersion: "oracle.local-retained-evidence-handoff.v1",
    version: DERIVATIVE_VERSION,
    result: "PASS_LOCAL_CONSERVATIVE_DERIVATIVE",
    generatedAt: new Date().toISOString(),
    asOfDate: options.asOfDate,
    candidateCommit: freeze.candidateCommit,
    workingTreeSourceBindings: [
      fileURLToPath(import.meta.url),
      templateFile,
      path.resolve(HERE, "../../src/counties/lake/retained-permit-evidence.ts"),
      path.resolve(HERE, "../../tsconfig.evidence.json"),
    ].map(digest),
    captureCommit: freeze.capture.approvedCommit,
    captureBaselineSha256: freeze.capture.baselineSha256,
    inputFreeze: digest(options.inputFreeze),
    inputReadinessReport: digest(options.readinessReport),
    inputs: freeze.evidenceBindings,
    captureEnvelopeBindings: freeze.capture.artifacts,
    rawInputsUnchanged: true,
    originalParquetsUnchanged: true,
    propertyGate: p,
    permitGate: m,
    sourceObservationsReadBackUnchanged: readbackRows,
    fieldEvidenceCounts: counts,
    propertyFieldEvidenceCounts,
    propertyYearReadbackRows: propertyReadbackRows,
    propertyQuarantineFieldObservationCount: propertyQuarantineCount,
    sourcePeriodMatrix: [...periodCounts.values()].map((group) => ({
      ...group,
      coverageBoundary: readiness.permitEvidence.sourcePeriods.find(
        (partition) =>
          partition.sourceKey === group.source &&
          (group.source === "lake_cdplus_permits" ||
            String(partition.historicalPeriod.permitNumberYear) === group.period),
      ),
      sourceAvailabilityRevalidated: false,
    })),
    otherJurisdictionBoundaries: readiness.sourceInventory.jurisdictions
      .filter((item) => !["clermont", "unincorporated"].includes(item.key))
      .map((item) => ({ ...item, counts: null, sevenStateCounts: null, revalidated: false })),
    licenseOriginCounts: originCounts,
    quarantineFieldObservationCount: quarantineCount,
    observationTimes:
      "Per-record capture times not in reused exports; null, never replaced by certification/export time",
    contactTextTrace:
      "Literal selected contractor contact text matches immutable Clermont CSV; not a separate permit license field or official DBPR verification",
    allowedConclusions: [
      "retained source observations",
      "low-confidence valid built-year roof proxies with partial-history caveats",
    ],
    ineligibleConclusions: [
      "current/open status",
      "accepted primary-roof replacement completion",
      "contractor unassigned/confirmed absence",
      "official DBPR license or temporal legal company identity",
      "resolved contractor cohorts",
      "county completeness",
      "public availability",
    ],
    remainingGaps: [
      "Sunbiz and adequate temporal DBPR snapshots",
      "source-profile status/date/work semantics",
      "independent close/completion dates",
      "per-record capturedAt/freshness",
      "contractor role/blank-contact detail proof",
      "justified source-profile chronology rules",
      "privacy/publication/retention/all-object two-gateway proofs",
    ],
    outputs,
    releaseReady: false,
    countyComplete: false,
    publicationApproved: false,
    networkRequests: 0,
    newHarvest: false,
    newCaptureCertification: false,
    cloudWrites: false,
    gitOrPrWrites: false,
    nextAction:
      "Fixture acceptance and deterministic record replay; official identity and source-semantic acquisition are separately scoped",
  };
  writeJson(path.join(output, "handoff.json"), report);
  return report;
}

function cliOptions(argv: string[]): DerivativeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index],
      value = argv[index + 1];
    if (
      !key ||
      !value ||
      !["--input-freeze", "--readiness-report", "--output", "--as-of-date", "--duckdb"].includes(
        key,
      )
    ) {
      throw new Error(
        "Use explicit --input-freeze --readiness-report --output --as-of-date [--duckdb]",
      );
    }
    if (values.has(key)) throw new Error("Duplicate option: " + key);
    values.set(key, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error("Missing required option: " + name);
    return value;
  };
  return {
    inputFreeze: required("--input-freeze"),
    readinessReport: required("--readiness-report"),
    output: required("--output"),
    asOfDate: required("--as-of-date"),
    duckdbExecutable: values.get("--duckdb"),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRetainedEvidenceDerivative(cliOptions(process.argv.slice(2)))
    .then((report) => {
      console.log(
        JSON.stringify({
          result: report.result,
          propertyGate: report.propertyGate,
          permitGate: report.permitGate,
          licenseOriginCounts: report.licenseOriginCounts,
          quarantines: report.quarantineFieldObservationCount,
          releaseReady: false,
        }),
      );
    })
    .catch(() => {
      // Raw source values and paths are private; detailed diagnostics belong in operator-only evidence.
      console.error(
        JSON.stringify({ result: "FAILED_LOCAL_DERIVATIVE", outputRetainedForInspection: true }),
      );
      process.exitCode = 1;
    });
}
