/** Separate eligible source-only projection of exact frozen inputs. No prior flags are edited. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LAKE_QUERY_TABLE_SCHEMA_FIELDS } from "../../src/counties/lake/query-table.mjs";
import { LAKE_PERMIT_TABLE_SCHEMA_FIELDS } from "../../src/counties/lake/permit-table.mjs";

const execute = promisify(execFile);
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const TYPES: Readonly<Record<string, string>> = {
  UTF8: "VARCHAR",
  DOUBLE: "DOUBLE",
  INT32: "INTEGER",
  BOOLEAN: "BOOLEAN",
};
const PROPERTY_HOLDS = new Set([
  "property_cid",
  "roof_last_permit_date",
  "roofing_permit_count",
  "open_permit_count",
  "open_roofing_permit_count",
  "longest_open_permit_days",
  "longest_open_roofing_permit_days",
  "bbb_rating",
  "has_bbb_contractor",
  "has_sunbiz_tenant",
]);
const PERMIT_HOLDS = new Set([
  "completed_date",
  "is_roofing",
  "is_open",
  "days_open",
  "contractor_license",
  "bbb_rating",
]);

export interface SourceOnlyExportOptions {
  propertyInput: string;
  propertySha256: string;
  permitInput: string;
  permitSha256: string;
  businessInput: string;
  businessSha256: string;
  output: string;
  runId: string;
  asOfDate: string;
  duckdb?: string;
  expectedProperties?: number;
  expectedPermits?: number;
  expectedBusinesses?: number;
}

export async function buildSourceOnlyExport(
  options: SourceOnlyExportOptions,
): Promise<Record<string, unknown>> {
  if (
    !/^[A-Za-z0-9._-]{1,120}$/.test(options.runId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(options.asOfDate) ||
    new Date(`${options.asOfDate}T00:00:00Z`).toISOString().slice(0, 10) !== options.asOfDate
  )
    throw new Error("Invalid source-only run/as-of identity");
  const year = Number(options.asOfDate.slice(0, 4));
  const inputs = await Promise.all(
    [
      [options.propertyInput, options.propertySha256],
      [options.permitInput, options.permitSha256],
      [options.businessInput, options.businessSha256],
    ].map(async ([input, expected]) => {
      if (!input || !expected || !/^[a-f0-9]{64}$/.test(expected))
        throw new Error("Require exact frozen source input digests");
      const resolved = await realpath(input);
      const bytes = await readFile(resolved);
      if (digest(bytes) !== expected) throw new Error("Frozen source input digest mismatch");
      return { path: resolved, sha256: expected, size: bytes.length };
    }),
  );
  const [properties, permits, businesses] = inputs;
  if (!properties || !permits || !businesses) throw new Error("Missing frozen source-only input");
  const output = path.join(
    await realpath(path.dirname(path.resolve(options.output))),
    path.basename(options.output),
  );
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  if (
    output === repo ||
    output.startsWith(`${repo}${path.sep}`) ||
    inputs.some((input) => output === path.dirname(input.path) || output === input.path)
  )
    throw new Error(
      "Require a new private source-only output directory outside Git and input roots",
    );
  const run = async (sql: string): Promise<Record<string, unknown>[]> => {
    const { stdout } = await execute(options.duckdb ?? "duckdb", ["-json", "-c", sql], {
      maxBuffer: 8 * 1024 * 1024,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(AWS_|DATABASE_URL|FILEBASE_|PINATA_|OPENAI_)/.test(key),
        ),
      ),
    });
    return stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>[]) : [];
  };
  const projection = (
    fields: Readonly<Record<string, { type: string }>>,
    holds: Set<string>,
    property: boolean,
  ): string =>
    Object.entries(fields)
      .map(([name, field]) => {
        let value = holds.has(name) ? "NULL" : name;
        const validYear = `built_year BETWEEN 1700 AND ${year}`;
        if (property && name === "built_year") value = `CASE WHEN ${validYear} THEN built_year END`;
        if (property && name === "roof_age_years")
          value = `CASE WHEN ${validYear} THEN ${year} - built_year END`;
        if (property && name === "roof_age_basis")
          value = `CASE WHEN ${validYear} THEN 'built_year_proxy' END`;
        if (property && name === "enrichment_status")
          value =
            "'source_observations_only;retained_source_observations;current_permit_status_not_revalidated;primary_roof_completion_needs_review;contractor_source_name_only;contractor_absence_not_proven;bbb_policy_api_gated'";
        return `CAST(${value} AS ${TYPES[field.type]}) AS ${name}`;
      })
      .join(", ");
  const [inputGate] = await run(`SELECT
    (SELECT count(*) FROM read_parquet(${quote(properties.path)})) AS properties,
    (SELECT count(DISTINCT request_identifier) FROM read_parquet(${quote(properties.path)})) AS folios,
    (SELECT count(*) FROM read_parquet(${quote(permits.path)})) AS permits,
    (SELECT count(DISTINCT permit_id) FROM read_parquet(${quote(permits.path)})) AS permit_ids,
    (SELECT count(*) FROM read_parquet(${quote(businesses.path)})) AS businesses,
    (SELECT count(DISTINCT business_id) FROM read_parquet(${quote(businesses.path)})) AS business_ids;`);
  if (
    !inputGate ||
    Number(inputGate.properties) !== (options.expectedProperties ?? 215806) ||
    Number(inputGate.folios) !== Number(inputGate.properties) ||
    Number(inputGate.permits) !== (options.expectedPermits ?? 76166) ||
    Number(inputGate.permit_ids) !== Number(inputGate.permits) ||
    Number(inputGate.businesses) !== (options.expectedBusinesses ?? 33346) ||
    Number(inputGate.business_ids) !== Number(inputGate.businesses)
  )
    throw new Error("Frozen source-only input counts/identities failed reconciliation");
  await mkdir(output, { recursive: false, mode: 0o700 });
  const propertyPath = path.join(output, "query-table.parquet");
  const permitPath = path.join(output, "permit-table.parquet");
  const sql = `COPY (SELECT ${projection(LAKE_QUERY_TABLE_SCHEMA_FIELDS, PROPERTY_HOLDS, true)} FROM read_parquet(${quote(properties.path)}) ORDER BY request_identifier) TO ${quote(propertyPath)} (FORMAT PARQUET, COMPRESSION ZSTD);
    COPY (SELECT ${projection(LAKE_PERMIT_TABLE_SCHEMA_FIELDS, PERMIT_HOLDS, false)} FROM read_parquet(${quote(permits.path)}) ORDER BY permit_id) TO ${quote(permitPath)} (FORMAT PARQUET, COMPRESSION ZSTD);
    SELECT (SELECT count(*) FROM read_parquet(${quote(propertyPath)})) AS properties,
      count(*) AS permits,
      count(*) FILTER (WHERE linkage_status = 'linked_to_assessed_roll') AS linked,
      count(*) FILTER (WHERE linkage_status = 'unlinked_to_assessed_roll') AS valid_unlinked,
      count(*) FILTER (WHERE is_open IS NOT NULL OR is_roofing IS NOT NULL OR days_open IS NOT NULL OR completed_date IS NOT NULL OR contractor_license IS NOT NULL OR bbb_rating IS NOT NULL) AS promoted_permit_decisions,
      (SELECT count(*) FROM read_parquet(${quote(propertyPath)}) WHERE roof_last_permit_date IS NOT NULL OR roofing_permit_count IS NOT NULL OR open_permit_count IS NOT NULL OR open_roofing_permit_count IS NOT NULL OR longest_open_permit_days IS NOT NULL OR longest_open_roofing_permit_days IS NOT NULL OR bbb_rating IS NOT NULL OR has_bbb_contractor IS NOT NULL OR has_sunbiz_tenant IS NOT NULL) AS promoted_property_decisions,
      (SELECT count(*) FROM read_parquet(${quote(propertyPath)}) WHERE built_year IS NOT NULL) AS valid_actual_built_year_proxies,
      (SELECT count(*) FROM read_parquet(${quote(propertyPath)}) WHERE roof_age_years >= 15) AS building_age_proxy_at_least_15,
      (SELECT count(*) FROM read_parquet(${quote(propertyPath)}) WHERE latitude IS NOT NULL AND longitude IS NOT NULL) AS coordinate_pairs
      FROM read_parquet(${quote(permitPath)});`;
  const [counts] = await run(sql);
  if (
    !counts ||
    Number(counts.properties) !== Number(inputGate.properties) ||
    Number(counts.permits) !== Number(inputGate.permits) ||
    Number(counts.linked) + Number(counts.valid_unlinked) !== Number(inputGate.permits) ||
    Number(counts.promoted_permit_decisions) !== 0 ||
    Number(counts.promoted_property_decisions) !== 0
  )
    throw new Error("Source-only output failed identity/count/decision-hold reconciliation");
  await copyFile(businesses.path, path.join(output, "business-table.parquet"));
  const semantics = {
    schemaVersion: "oracle.lake-source-semantics.v1",
    runId: options.runId,
    county: "lake",
    datasetKind: "source_only_partial",
    sourceObservationsOnly: true,
    asOfDate: options.asOfDate,
    countyComplete: false,
    sourceProfileAccepted: false,
    observedAt: null,
    currentPermitStatusAccepted: false,
    completionAccepted: false,
    legalIdentityVerified: false,
    roofAge: {
      basis: "valid_actual_built_year",
      confidence: "low",
      thresholdConfigurable: true,
      caveat:
        "Building age is not measured roof age. Partial jurisdiction and predecessor history may omit a later replacement.",
    },
    permitFields: {
      permit_status: "retained historical source text; capture time unknown, not live/current",
      applied_date: "source application/opened observation",
      approved_date: "source approval observation",
      issued_date: "source issue observation",
      last_modified_date: "source last-modified observation, not capture time",
      permit_description: "literal work description, not accepted primary-roof classification",
      contractor_name: "source-listed name only, not verified license/legal company",
      completed_date:
        "unknown accepted completion; source lifecycle observations remain in immutable private inputs",
      is_open: "unknown",
      is_roofing: "unaccepted classification",
      days_open: "unknown",
      contractor_license: "unverified candidates excluded",
      bbb_rating: "policy/API-gated, not a zero score",
    },
    limitations: [
      "Clermont 2015–2026 captures and CD Plus rolling last-modified observations are retained; other jurisdictions/predecessor history remain partial.",
      "No current-status/freshness claim is inherited from undated retained captures.",
      "Inspected DOR sales cover 2025–2026; published appraiser history is not loaded, and ten-year ownership tenure is not demonstrated.",
      "All TPP source accounts remain queryable; parcel associations are address candidates, not legal identity.",
    ],
  };
  await writeFile(
    path.join(output, "source-semantics.json"),
    `${JSON.stringify(semantics, null, 2)}\n`,
    { mode: 0o600 },
  );
  const outputFiles = await Promise.all(
    [
      "query-table.parquet",
      "permit-table.parquet",
      "business-table.parquet",
      "source-semantics.json",
    ].map(async (name) => {
      const bytes = await readFile(path.join(output, name));
      return { name, sha256: digest(bytes), size: bytes.length };
    }),
  );
  for (const input of inputs)
    if (digest(await readFile(input.path)) !== input.sha256)
      throw new Error("Frozen source-only inputs changed during export");
  const receipt = {
    schemaVersion: "oracle.lake-source-only-build.v1",
    runId: options.runId,
    inputs,
    counts,
    outputFiles,
    output,
    sqlSha256: digest(Buffer.from(sql)),
    transformedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(output, "private-source-only-reconciliation.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key || !value) throw new Error("Invalid source-only export arguments");
    args.set(key, value);
  }
  const required = (key: string): string => {
    const value = args.get(key);
    if (!value) throw new Error(`Require ${key}`);
    return value;
  };
  const receipt = await buildSourceOnlyExport({
    propertyInput: required("--property-input"),
    propertySha256: required("--property-sha256"),
    permitInput: required("--permit-input"),
    permitSha256: required("--permit-sha256"),
    businessInput: required("--business-input"),
    businessSha256: required("--business-sha256"),
    output: required("--output"),
    runId: required("--run-id"),
    asOfDate: required("--as-of-date"),
    duckdb: args.get("--duckdb"),
  });
  process.stdout.write(
    `${JSON.stringify({ output: receipt.output, counts: receipt.counts, outputFiles: receipt.outputFiles })}\n`,
  );
}
