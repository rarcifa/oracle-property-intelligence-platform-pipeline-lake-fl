import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRetainedEvidenceDerivative,
  expandDerivativeSql,
  sqlLiteral,
} from "../scripts/lake/build-retained-evidence-derivative.js";
import {
  EVIDENCE_STATES,
  validatedBuiltYear,
} from "../src/counties/lake/retained-permit-evidence.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function localSql(sql: string): Record<string, string | number | null>[] {
  const result = execFileSync("duckdb", [":memory:", "-json", "-c", sql], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.trim() ? (JSON.parse(result) as Record<string, string | number | null>[]) : [];
}

function binding(logicalPath: string, file: string) {
  return {
    logicalPath,
    absolutePath: file,
    sizeBytes: statSync(file).size,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "lake-private-evidence-test-"));
  temporaryDirectories.push(directory);
  const properties = path.join(directory, "properties.parquet");
  const permits = path.join(directory, "permits.parquet");
  const contacts = path.join(directory, "contacts.csv");
  const nal = path.join(directory, "nal.csv");
  const years = ["1950", "2018", "2027", "0", "2000.2", "", "1700", "2026", " 1999 "];
  writeFileSync(
    nal,
    "PARCEL_ID,ACT_YR_BLT,EFF_YR_BLT\n" +
      years.map((year, index) => "parcel-" + index + "," + year + "," + year).join("\n") +
      "\n",
  );
  localSql(
    "COPY (SELECT 'parcel-' || i::VARCHAR AS request_identifier, 'property-' || i::VARCHAR AS property_id, " +
      "CAST(2000 AS INTEGER) AS built_year, CAST(2000 AS INTEGER) AS effective_built_year, " +
      "CAST(6 AS INTEGER) AS roof_age_years, 'roofing_permit_completed' AS roof_age_basis, " +
      "'2020-02-29' AS roof_last_permit_date, CAST(1 AS INTEGER) AS roofing_permit_count, " +
      "CAST(1 AS INTEGER) AS open_permit_count, CAST(1 AS INTEGER) AS open_roofing_permit_count, " +
      "CAST(100 AS INTEGER) AS longest_open_permit_days, CAST(100 AS INTEGER) AS longest_open_roofing_permit_days, " +
      "'contractor_absent_on_permit' AS enrichment_status, CAST(28.55 AS DOUBLE) AS latitude, " +
      "CAST(-81.75 AS DOUBLE) AS longitude FROM range(9) t(i)) TO " +
      sqlLiteral(properties) +
      " (FORMAT PARQUET);",
  );
  writeFileSync(
    contacts,
    "permit_number,contractor_name,contractor_license\n20-1,Fixture Roofing-CCC1234567,CCC1234567\n20-2,Fixture Roofing,CCC7654321\n",
  );
  localSql(
    "COPY (SELECT 'lake_clermont_etrakit_permits:20-' || i::VARCHAR AS permit_id, " +
      "'20-' || i::VARCHAR AS permit_number, 'parcel-0' AS parcel_identifier, '0012345' AS alt_key, " +
      "'City of Clermont' AS jurisdiction, 'ROOF' AS permit_type, 'Gazebo re-roof repair' AS permit_description, " +
      "'VOID' AS permit_status, '2020-01-01' AS applied_date, CAST(NULL AS VARCHAR) AS approved_date, " +
      "'2020-01-02' AS issued_date, CASE WHEN i=1 THEN '2020-02-30' ELSE '2030-01-01' END AS completed_date, " +
      "CAST(NULL AS VARCHAR) AS last_modified_date, true AS is_roofing, false AS is_open, CAST(10 AS INTEGER) AS days_open, " +
      "CASE WHEN i=1 THEN 'Fixture Roofing-CCC1234567' ELSE 'Fixture Roofing' END AS contractor_name, " +
      "CASE WHEN i=1 THEN 'CCC1234567' ELSE 'CCC7654321' END AS contractor_license, CAST(NULL AS VARCHAR) AS bbb_rating, " +
      "'https://official.example/permit/' || i::VARCHAR AS source_url, 'lake_clermont_etrakit_permits' AS source_system, " +
      "CASE WHEN i=1 THEN 'linked_to_assessed_roll' ELSE 'unlinked_to_assessed_roll' END AS linkage_status " +
      "FROM range(1,3) t(i)) TO " +
      sqlLiteral(permits) +
      " (FORMAT PARQUET);",
  );
  const inputDirectory = path.join(directory, "frozen");
  // Generated fixture metadata is private and does not alter a real capture.
  execFileSync(process.execPath, [
    "-e",
    "require('node:fs').mkdirSync(process.argv[1])",
    inputDirectory,
  ]);
  const freeze = path.join(inputDirectory, "freeze.json");
  const readiness = path.join(inputDirectory, "readiness.json");
  writeFileSync(
    freeze,
    JSON.stringify({
      candidateCommit: "9".repeat(40),
      sourceBindings: [],
      evidenceBindings: [
        binding("query-table.parquet", properties),
        binding("permit-table.parquet", permits),
        binding("inputs/clermont-permits.csv", contacts),
        binding("inputs/NAL45P202601.csv", nal),
      ],
      capture: {
        approvedCommit: "4".repeat(40),
        baselineSha256: "a".repeat(64),
        artifacts: [],
        yearCounts: [{ year: 2020, completed: 2, linked: 1, validUnlinked: 1 }],
      },
    }),
  );
  writeFileSync(
    readiness,
    JSON.stringify({
      sourceInventory: {
        jurisdictions: [
          { key: "clermont", jurisdiction: "Clermont", status: "supported" },
          { key: "groveland", jurisdiction: "Groveland", status: "blocked" },
        ],
      },
      permitEvidence: {
        sourcePeriods: [
          {
            sourceKey: "lake_clermont_etrakit_permits",
            historicalPeriod: { permitNumberYear: 2020 },
            captured: 2,
          },
        ],
      },
    }),
  );
  // Output must not live inside any frozen input directory.
  const output = path.join(os.tmpdir(), path.basename(directory) + "-output");
  const replay = output + "-replay";
  temporaryDirectories.push(output, replay);
  return { directory, properties, permits, contacts, nal, freeze, readiness, output, replay };
}

describe("private retained-evidence DuckDB integration", () => {
  it("escapes local SQL paths without recursively expanding dollar text inside paths", () => {
    expect(sqlLiteral("/private/owner's/$AS_OF_YEAR/input")).toBe(
      "'/private/owner''s/$AS_OF_YEAR/input'",
    );
    expect(
      expandDerivativeSql("SELECT $INPUT, $YEAR", {
        $INPUT: sqlLiteral("/private/$YEAR/file"),
        $YEAR: "2026",
      }),
    ).toBe("SELECT '/private/$YEAR/file', 2026");
    expect(() => expandDerivativeSql("SELECT $MISSING", {})).toThrow(/Missing SQL parameter/);
    expect(() => sqlLiteral("bad\0path")).toThrow(/NUL/);
  });

  it("preserves source observations, valid-unlinked permits and seven-state counts while withholding unsafe conclusions", async () => {
    const f = fixture();
    const before = [f.properties, f.permits, f.contacts, f.nal].map((file) =>
      binding(path.basename(file), file),
    );
    const report = await buildRetainedEvidenceDerivative({
      inputFreeze: f.freeze,
      readinessReport: f.readiness,
      output: f.output,
      asOfDate: "2026-09-16",
    });
    expect(report.result).toBe("PASS_LOCAL_CONSERVATIVE_DERIVATIVE");
    expect(report.propertyGate.properties).toBe(9);
    expect(report.propertyGate.built_year_proxies).toBe(4);
    expect(report.permitGate).toMatchObject({
      permits: 2,
      linked: 1,
      valid_unlinked: 1,
      unsafe_conclusions: 0,
    });
    expect(report.sourceObservationsReadBackUnchanged).toBe(2);
    expect(report.licenseOriginCounts).toEqual({
      permit_contact_text: 1,
      directory_candidate_unverified: 1,
    });
    expect(report.quarantineFieldObservationCount).toBe(2);
    expect(report.releaseReady).toBe(false);
    expect(report.countyComplete).toBe(false);
    expect(report.otherJurisdictionBoundaries[0]).toMatchObject({
      counts: null,
      sevenStateCounts: null,
      revalidated: false,
    });
    for (const counts of Object.values(report.fieldEvidenceCounts)) {
      expect(EVIDENCE_STATES.reduce((sum, state) => sum + counts[state], 0)).toBe(2);
    }
    for (const counts of Object.values(report.propertyFieldEvidenceCounts)) {
      expect(EVIDENCE_STATES.reduce((sum, state) => sum + counts[state], 0)).toBe(9);
      expect(counts.confirmed_present).toBe(4);
      expect(counts.unknown).toBe(1);
      expect(counts.invalid_quarantined).toBe(4);
    }
    expect(report.propertyYearReadbackRows).toBe(9);
    expect(report.propertyQuarantineFieldObservationCount).toBe(8);
    expect(report.fieldEvidenceCounts.permitPrintedLicense.unknown).toBe(2);
    const queried = localSql(
      "SELECT request_identifier, source_observed_built_year, roof_age_years, roof_age_confidence, " +
        "built_year_evidence_state FROM read_parquet(" +
        sqlLiteral(path.join(f.output, "query-table-retained-evidence.parquet")) +
        ") ORDER BY request_identifier;",
    );
    for (const row of queried) {
      const expected = validatedBuiltYear(row.source_observed_built_year, {
        asOfDate: "2026-09-16",
        minimumYear: 1700,
      });
      expect(row.built_year_evidence_state).toBe(expected.state);
      expect(row.roof_age_years).toBe(expected.value === null ? null : 2026 - expected.value);
      expect(row.roof_age_confidence).toBe(expected.value === null ? null : "low");
    }
    expect(
      [f.properties, f.permits, f.contacts, f.nal].map((file) =>
        binding(path.basename(file), file),
      ),
    ).toEqual(before);
    await buildRetainedEvidenceDerivative({
      inputFreeze: f.freeze,
      readinessReport: f.readiness,
      output: f.replay,
      asOfDate: "2026-09-16",
    });
    for (const name of [
      "query-table-retained-evidence.parquet",
      "permit-table-retained-evidence.parquet",
    ]) {
      const a = sqlLiteral(path.join(f.output, name)),
        b = sqlLiteral(path.join(f.replay, name));
      expect(
        localSql(
          "SELECT count(*) AS differences FROM ((SELECT * FROM read_parquet(" +
            a +
            ") EXCEPT ALL SELECT * FROM read_parquet(" +
            b +
            ")) UNION ALL (SELECT * FROM read_parquet(" +
            b +
            ") EXCEPT ALL SELECT * FROM read_parquet(" +
            a +
            ")));",
        )[0]?.differences,
      ).toBe(0);
    }
    expect(readFileSync(path.join(f.output, "retained-permit-evidence.jsonl"), "utf8")).toBe(
      readFileSync(path.join(f.replay, "retained-permit-evidence.jsonl"), "utf8"),
    );
  }, 120_000);

  it("preserves a CD Plus window with capturedUnique rather than a permit-number year", async () => {
    const f = fixture();
    const combinedPermits = path.join(f.directory, "combined-permits.parquet");
    localSql(
      "COPY (SELECT * FROM read_parquet(" +
        sqlLiteral(f.permits) +
        ") UNION ALL SELECT * REPLACE ('lake_cdplus_permits:fixture-1' AS permit_id, " +
        "'fixture-1' AS permit_number, 'Lake County' AS jurisdiction, " +
        "'lake_cdplus_permits' AS source_system, CAST(NULL AS VARCHAR) AS contractor_name, " +
        "CAST(NULL AS VARCHAR) AS contractor_license, '2026-09-01' AS last_modified_date) " +
        "FROM read_parquet(" +
        sqlLiteral(f.permits) +
        ") WHERE permit_number='20-1') TO " +
        sqlLiteral(combinedPermits) +
        " (FORMAT PARQUET);",
    );
    const freeze = JSON.parse(readFileSync(f.freeze, "utf8")) as {
      evidenceBindings: ReturnType<typeof binding>[];
    };
    freeze.evidenceBindings = freeze.evidenceBindings.map((item) =>
      item.logicalPath === "permit-table.parquet"
        ? binding(item.logicalPath, combinedPermits)
        : item,
    );
    writeFileSync(f.freeze, JSON.stringify(freeze));
    const readiness = JSON.parse(readFileSync(f.readiness, "utf8")) as {
      permitEvidence: { sourcePeriods: Record<string, unknown>[] };
    };
    const window = { from: "2025-09-09", through: "2026-09-08" };
    readiness.permitEvidence.sourcePeriods.push({
      sourceKey: "lake_cdplus_permits",
      historicalPeriod: { window },
      capturedUnique: 1,
    });
    writeFileSync(f.readiness, JSON.stringify(readiness));
    const report = await buildRetainedEvidenceDerivative({
      inputFreeze: f.freeze,
      readinessReport: f.readiness,
      output: f.output,
      asOfDate: "2026-09-16",
    });
    expect(report.permitGate.permits).toBe(3);
    expect(report.sourcePeriodMatrix).toHaveLength(2);
    expect(
      report.sourcePeriodMatrix.find((period) => period.source === "lake_cdplus_permits"),
    ).toMatchObject({
      rows: 1,
      coverageBoundary: {
        historicalPeriod: { window },
        capturedUnique: 1,
      },
      sourceAvailabilityRevalidated: false,
    });
    expect(report.fieldEvidenceCounts.currentOpenStatus.unknown).toBe(3);
    expect(report.fieldEvidenceCounts.permitPrintedLicense.unknown).toBe(3);
  }, 120_000);

  it("rejects overwriting an existing output or mutating a prior input packet", async () => {
    const f = fixture();
    await expect(
      buildRetainedEvidenceDerivative({
        inputFreeze: f.freeze,
        readinessReport: f.readiness,
        output: f.directory,
        asOfDate: "2026-09-16",
      }),
    ).rejects.toThrow(/new, nonexistent/);
    await expect(
      buildRetainedEvidenceDerivative({
        inputFreeze: f.freeze,
        readinessReport: f.readiness,
        output: path.join(path.dirname(f.freeze), "new"),
        asOfDate: "2026-09-16",
      }),
    ).rejects.toThrow(/prior evidence packet/);
  });

  it("rejects changed immutable inputs before writing any output", async () => {
    const f = fixture();
    writeFileSync(f.contacts, "\n", { flag: "a" });
    await expect(
      buildRetainedEvidenceDerivative({
        inputFreeze: f.freeze,
        readinessReport: f.readiness,
        output: f.output,
        asOfDate: "2026-09-16",
      }),
    ).rejects.toThrow();
    expect(readFileSync(f.contacts, "utf8")).toMatch(/\n\n$/);
  });

  it("rejects a symlink parent that physically aliases a prior evidence packet", async () => {
    const f = fixture();
    const alias = f.output + "-alias";
    symlinkSync(path.dirname(f.freeze), alias, "dir");
    temporaryDirectories.push(alias);
    await expect(
      buildRetainedEvidenceDerivative({
        inputFreeze: f.freeze,
        readinessReport: f.readiness,
        output: path.join(alias, "must-not-be-created"),
        asOfDate: "2026-09-16",
      }),
    ).rejects.toThrow(/prior evidence packet/);
  });
});
