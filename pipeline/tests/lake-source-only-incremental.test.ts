import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizePermit } from "../src/counties/lake/sources.mjs";
import { renderCsv } from "../src/core/csv.mjs";
import { buildSourceOnlyExport } from "../scripts/lake/build-source-only-export.js";
import {
  buildIncrementalSourceOnlyTables,
  type IncrementalSourceOnlyOptions,
} from "../scripts/lake/build-source-only-incremental.js";
import { reconcilePermitRefresh } from "../scripts/lake/summarize-permit-refresh.js";
import {
  createLegacyDuckDbFixture,
  removeLegacyDuckDbFixture,
  LEGACY_LAMBDA_COMMAND,
} from "./duckdb-legacy-json-fixture.js";

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const quote = (value: string): string => value.replaceAll("'", "''");
const fixtures = fileURLToPath(
  new URL("./fixtures/lake-query-table-sql-regressions/", import.meta.url),
);
let directory: string;
let options: IncrementalSourceOnlyOptions;
let duckDbFixture: string | undefined;
const originalPath = process.env.PATH;
const sql = (statement: string): Record<string, unknown>[] => {
  // Preserve the frozen input SQL; select DuckDB's explicit legacy-lambda mode
  // so diagnostics are not mixed into JSON. Parsing remains strict.
  const result = execFileSync("duckdb", ["-json", "-cmd", LEGACY_LAMBDA_COMMAND, "-c", statement], {
    encoding: "utf8",
    timeout: 60000,
  });
  return result.trim() ? (JSON.parse(result) as Record<string, unknown>[]) : [];
};
const bound = async (input: string) => {
  const bytes = await readFile(input);
  return { path: input, sizeBytes: bytes.length, sha256: sha(bytes) };
};

beforeAll(async () => {
  duckDbFixture = await createLegacyDuckDbFixture();
  process.env.PATH = `${duckDbFixture}${path.delimiter}${originalPath ?? ""}`;
  directory = await mkdtemp(path.join(tmpdir(), "lake-source-only-incremental-"));
  const names = [
    "NAL45P202601.csv",
    "SDF45P202601.csv",
    "NAP45P202601.csv",
    "centroids.csv",
    "permits.csv",
    "clermont-permits.csv",
    "clermont-permits.meta.json",
  ];
  for (const name of names.slice(0, 6))
    await copyFile(path.join(fixtures, name), path.join(directory, name));
  await writeFile(path.join(directory, names[6]!), "{}\n");
  const attributes = {
    OBJECTID: 1,
    Permit_Number: "CD-1",
    Alternate_Key: "A",
    Parcel_ID: "parcel-A",
    Permit_Type: "ROOF",
    Permit_Desc: "Literal roof source text",
    Permit_Status: "ISSUED",
    PermitApplied_Date: Date.parse("2026-08-01"),
    PermitIssued_Date: Date.parse("2026-08-02"),
    Permit_LastModDate: Date.parse("2026-09-01"),
    PermitURL: "https://example.invalid/CD-1",
  };
  const capturedAt = "2026-09-16T18:05:22.523Z";
  const base = [normalizePermit(attributes, { nowMs: Date.parse(capturedAt) })];
  const features = [
    {
      ...attributes,
      Permit_Status: "FINAL",
      CO_Date: Date.parse("2026-09-15"),
      Permit_LastModDate: Date.parse("2026-09-15"),
    },
    {
      ...attributes,
      OBJECTID: 2,
      Permit_Number: "CD-2",
      Alternate_Key: "MISSING",
      Parcel_ID: "unmatched-parcel",
      PermitURL: "https://example.invalid/CD-2",
    },
    {
      ...attributes,
      OBJECTID: 3,
      Permit_Number: "CD-2",
      Alternate_Key: "MISSING",
      Parcel_ID: "unmatched-parcel",
      PermitURL: "https://example.invalid/CD-2",
    },
  ];
  const window = features.map((feature) =>
    normalizePermit(feature, { nowMs: Date.parse(capturedAt) }),
  );
  const merged = [window[0]!, window[2]!];
  const columns = Object.keys(base[0]!);
  await writeFile(
    path.join(directory, "permits.csv"),
    renderCsv(
      columns,
      base.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, value == null ? "" : String(value)]),
        ),
      ),
    ),
  );
  await writeFile(path.join(directory, "base.json"), JSON.stringify(base));
  await writeFile(path.join(directory, "window.json"), JSON.stringify(window));
  await writeFile(path.join(directory, "merged.json"), JSON.stringify(merged));
  const source = "https://example.invalid/CDPlus";
  const where = "Permit_LastModDate > timestamp '2026-09-09 00:00:00'";
  await writeFile(
    path.join(directory, "observations.json"),
    JSON.stringify({ capturedAt, source, where, objectIds: [1, 2, 3], features }),
  );
  const paths = ["base.json", "window.json", "merged.json", "observations.json"];
  const bindings = await Promise.all(paths.map((name) => bound(path.join(directory, name))));
  const deltas = reconcilePermitRefresh(base, window, merged);
  await writeFile(
    path.join(directory, "refresh.json"),
    JSON.stringify({
      schemaVersion: "elephant.lake-permit-refresh-readback.v1",
      capturedAt,
      source,
      where,
      sourceFeatures: 3,
      distinctWindowPermits: 2,
      deltas,
      bindings: bindings.map((binding, index) => ({
        ...binding,
        role: ["immutable-base", "window", "merged", "source-observations"][index],
      })),
    }),
  );
  const queryInput = path.join(directory, "query-input.parquet");
  const permitInput = path.join(directory, "permit-input.parquet");
  const businessInput = path.join(directory, "business-input.parquet");
  const template = await readFile(
    new URL("../scripts/lake/build-query-table.sql", import.meta.url),
    "utf8",
  );
  sql(
    template
      .replaceAll("$DOWNLOAD_DIR", quote(directory))
      .replaceAll("$OUT_PARQUET", quote(queryInput))
      .replaceAll("$PERMIT_OUT_PARQUET", quote(permitInput))
      .replaceAll("$AS_OF_YEAR", "2026")
      .replaceAll("$AS_OF_DATE", "2026-09-16"),
  );
  sql(
    `COPY (SELECT 'fixture-business'::VARCHAR AS business_id) TO '${quote(businessInput)}' (FORMAT PARQUET)`,
  );
  const counts = sql(
    `SELECT (SELECT count(*) FROM read_parquet('${quote(queryInput)}')) AS properties, (SELECT count(*) FROM read_parquet('${quote(permitInput)}')) AS permits`,
  )[0]!;
  const propertyBinding = await bound(queryInput);
  const permitBinding = await bound(permitInput);
  const businessBinding = await bound(businessInput);
  const original = path.join(directory, "original-source-only");
  await buildSourceOnlyExport({
    propertyInput: queryInput,
    propertySha256: propertyBinding.sha256,
    permitInput,
    permitSha256: permitBinding.sha256,
    businessInput,
    businessSha256: businessBinding.sha256,
    output: original,
    runId: "20260916T181000Z",
    asOfDate: "2026-09-16",
    expectedProperties: Number(counts.properties),
    expectedPermits: Number(counts.permits),
    expectedBusinesses: 1,
  });
  options = {
    runId: "20260917T152549Z",
    asOfDate: "2026-09-17",
    output: path.join(tmpdir(), `lake-incremental-result-${path.basename(directory)}`),
    sourceInputs: await Promise.all(
      names.map(async (name) => ({ ...(await bound(path.join(directory, name))), name })),
    ),
    baseProperty: await bound(path.join(original, "query-table.parquet")),
    basePermit: await bound(path.join(original, "permit-table.parquet")),
    baseBusiness: await bound(path.join(original, "business-table.parquet")),
    basePermitJson: bindings[0]!,
    window: bindings[1]!,
    merged: bindings[2]!,
    sourceObservations: bindings[3]!,
    refreshReceipt: await bound(path.join(directory, "refresh.json")),
    expectedProperties: Number(counts.properties),
    expectedBusinesses: 1,
  };
}, 60000);

afterAll(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (duckDbFixture) await removeLegacyDuckDbFixture(duckDbFixture);
  if (directory) await rm(directory, { recursive: true, force: true });
  if (options) await rm(options.output, { recursive: true, force: true });
});

describe("existing captured CD Plus source-only integration", () => {
  it("integrates insert/update evidence, de-duplicates the window, retains valid unmatched rows and holds decisions", async () => {
    const result = await buildIncrementalSourceOnlyTables(options);
    expect(result.integration.deltas).toMatchObject({
      inserted: 1,
      updated: 1,
      removed: null,
      idempotent: true,
      mergedAssociations: 2,
    });
    expect(result.integration.sourceCapture.observedPermitIds).toEqual([
      "lake_cdplus_permits:CD-1",
      "lake_cdplus_permits:CD-2",
    ]);
    expect(result.integration.recordEquality).toMatchObject({
      unrelated_property_changes: 0,
      retained_clermont_changes: 0,
      clermont: 10,
    });
    expect(result.integration).toMatchObject({
      published: false,
      publicationState: "held_local_candidate",
      currentPermitStatusAccepted: false,
      completionAccepted: false,
      legalIdentityVerified: false,
    });
    const permits = sql(
      `SELECT permit_id, permit_status, linkage_status, is_open, is_roofing, completed_date, days_open, contractor_license, bbb_rating FROM read_parquet('${quote(path.join(result.sourceOnly, "permit-table.parquet"))}') ORDER BY permit_id`,
    );
    expect(permits).toHaveLength(12);
    expect(permits.find((row) => row.permit_id === "lake_cdplus_permits:CD-1")).toMatchObject({
      permit_status: "FINAL",
    });
    expect(permits.find((row) => row.permit_id === "lake_cdplus_permits:CD-2")).toMatchObject({
      linkage_status: "unlinked_to_assessed_roll",
    });
    for (const row of permits)
      for (const column of [
        "is_open",
        "is_roofing",
        "completed_date",
        "days_open",
        "contractor_license",
        "bbb_rating",
      ])
        expect(row[column]).toBeNull();
    expect(sha(await readFile(options.basePermit.path))).toBe(options.basePermit.sha256);
    expect(sha(await readFile(options.baseProperty.path))).toBe(options.baseProperty.sha256);
    expect(sha(await readFile(path.join(result.sourceOnly, "business-table.parquet")))).toBe(
      options.baseBusiness.sha256,
    );
  }, 60000);

  it("refuses immutable input drift before writing output", async () => {
    await expect(
      buildIncrementalSourceOnlyTables({
        ...options,
        merged: { ...options.merged, sha256: "0".repeat(64) },
      }),
    ).rejects.toThrow(/digest\/size mismatch/);
  });

  it("refuses reuse of an existing output instead of overwriting it", async () => {
    await expect(buildIncrementalSourceOnlyTables(options)).rejects.toThrow(/EEXIST/);
  });

  it("refuses output inside immutable inputs", async () => {
    await expect(
      buildIncrementalSourceOnlyTables({
        ...options,
        output: path.join(directory, "forbidden-child"),
      }),
    ).rejects.toThrow(/private incremental output/);
  });

  it("refuses invalid export dates before transforming any input", async () => {
    await expect(
      buildIncrementalSourceOnlyTables({ ...options, asOfDate: "2026-02-30" }),
    ).rejects.toThrow(/as-of date/);
  });

  it("requires exact named source roles rather than arbitrary input paths", async () => {
    await expect(
      buildIncrementalSourceOnlyTables({
        ...options,
        sourceInputs: options.sourceInputs.map((binding, index) =>
          index === 0 ? { ...binding, name: "wrong.csv" } : binding,
        ),
      }),
    ).rejects.toThrow(/ordered frozen/);
  });

  it("refuses a byte-bound but false refresh count claim", async () => {
    const bad = JSON.parse(await readFile(options.refreshReceipt.path, "utf8")) as {
      deltas: { inserted: number };
    };
    bad.deltas.inserted += 1;
    const badPath = path.join(directory, "wrong-refresh.json");
    await writeFile(badPath, JSON.stringify(bad));
    await expect(
      buildIncrementalSourceOnlyTables({ ...options, refreshReceipt: await bound(badPath) }),
    ).rejects.toThrow(/receipt contradicts/);
  });

  it("refuses normalized window text that differs from its actual captured source", async () => {
    const capture = JSON.parse(await readFile(options.sourceObservations.path, "utf8")) as {
      features: Record<string, unknown>[];
    };
    capture.features[0]!.Permit_Status = "DIFFERENT SOURCE TEXT";
    const changedPath = path.join(directory, "changed-observations.json");
    await writeFile(changedPath, JSON.stringify(capture));
    await expect(
      buildIncrementalSourceOnlyTables({
        ...options,
        sourceObservations: await bound(changedPath),
      }),
    ).rejects.toThrow(/contradicts captured source/);
  });

  it("refuses repeated or substituted OBJECTIDs, not just a matching window length", async () => {
    const capture = JSON.parse(await readFile(options.sourceObservations.path, "utf8")) as {
      objectIds: number[];
    };
    capture.objectIds[2] = capture.objectIds[1]!;
    const changedPath = path.join(directory, "duplicate-objectids.json");
    await writeFile(changedPath, JSON.stringify(capture));
    await expect(
      buildIncrementalSourceOnlyTables({
        ...options,
        sourceObservations: await bound(changedPath),
      }),
    ).rejects.toThrow(/OBJECTID window/);
  });
});
