/**
 * Lake County adapter: capture + transform, run validation, and publication
 * artifacts. Registers `--county lake` on the same `elephant-county` CLI
 * verbs Pinellas and Duval use.
 *
 * Lake differs from both bundled counties in where a parcel's facts come
 * from. Pinellas and Duval capture one appraiser page per parcel and run
 * transform scripts over the HTML. Lake's appraiser portal and permit detail
 * pages sit behind a Cloudflare managed challenge, so Lake's record of origin
 * is the published DOR bulk roll. `captureAndTransform` therefore transforms
 * the roll record carried on each seed row into the same lexicon-shaped
 * `data/*.json` files plus `transformed.zip` the other counties produce, and
 * a run manifest with the same three-way success / permanent_failure /
 * retryable_failure classification.
 *
 * That per-parcel path is exercised by the pilot. A full county run uses the
 * direct DuckDB consolidation in `scripts/lake/build-query-table.sql`, which
 * is the "Fast Direct Parquet Export" pathway `onboard-county` stage 11
 * offers; it writes the identical column contract and
 * {@link buildPublicationArtifacts} asserts that before publishing.
 *
 * @module counties/lake/adapter
 */

import AdmZipCtor from "adm-zip";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildCoverageSnapshot, readTransformedZipJsonFiles, writeQueryTableParquet } from "../../core/query-table.mjs";
import { appendFailure, classifyFailure } from "../../core/run-state.mjs";
import { lakeEnrichmentProfile } from "./enrichment-profile.mjs";
import {
  assertQueryTableColumns,
  COUNTY_KEY,
  COUNTY_NAME,
  LAKE_QUERY_TABLE_SCHEMA_FIELDS,
  mapJoinedRecordToQueryTableRow,
  STATE_CODE,
} from "./query-table.mjs";
import { buildSeed as buildLakeSeedFiles, isValidLakeParcelId, NAL_SOURCE_FIELDS } from "./seed.mjs";
import { toText } from "./sources.mjs";

const execFileAsync = promisify(execFile);
const RUNTIME_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const TRANSFORMS_DIR = path.join(RUNTIME_ROOT, "counties", "lake", "transforms");
export const CONSOLIDATION_SQL_PATH = path.join(RUNTIME_ROOT, "scripts", "lake", "build-query-table.sql");
export const DEFAULT_JOB_ID = "lake-ingest";
export const MIN_TRANSFORMED_ZIP_BYTES = 200;
export const ZIP_LOCAL_FILE_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Every successful Lake parcel must carry both of these. */
export const REQUIRED_DATA_ARTIFACTS = Object.freeze(["property.json", "address.json"]);

const {
  bucket: QUERY_TABLE_BUCKET,
  queryTableIpnsLabel: QUERY_TABLE_IPNS_LABEL,
  coverageIpnsLabel: COVERAGE_IPNS_LABEL,
} = lakeEnrichmentProfile.publication;

/**
 * @param {string} candidate - Filesystem path.
 * @returns {Promise<boolean>} Whether the path exists.
 */
async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuild the NAL record a seed row carries. The seed stores each retained
 * NAL column as `source_<COLUMN>`; this reverses that so the transform and
 * the query-table mapper can work with the original field names.
 *
 * @param {Record<string, string>} row - Seed row.
 * @returns {Record<string, string>} NAL fields keyed by their DOR names.
 */
export function nalRecordFromSeedRow(row) {
  /** @type {Record<string, string>} */
  const nal = {};
  for (const field of NAL_SOURCE_FIELDS) {
    nal[field] = row[`source_${field}`] ?? "";
  }
  nal.ALT_KEY = row.alt_key ?? "";
  return nal;
}

/**
 * Fail closed unless a seed row carries a canonical Lake parcel id that
 * matches the row's own `source_PARCEL_ID`. A mismatch means the seed join
 * misaligned and the row must not be transformed under the wrong parcel.
 *
 * @param {Record<string, string>} row - Seed row.
 * @returns {string} The validated parcel id.
 */
export function assertSeedRowParcel(row) {
  const parcelId = toText(row.parcel_id);
  if (!isValidLakeParcelId(parcelId)) {
    throw new Error(`Not a canonical Lake parcel id: ${parcelId}`);
  }
  const sourceParcelId = toText(row.source_PARCEL_ID);
  if (sourceParcelId.length > 0 && sourceParcelId !== parcelId) {
    throw new Error(`Seed parcel_id ${parcelId} does not match source_PARCEL_ID ${sourceParcelId}`);
  }
  return parcelId;
}

/**
 * Build the lexicon-shaped `data/*.json` files for one parcel from its roll
 * record. These mirror the file names the other counties' transform scripts
 * emit, so `core/query-table.mjs#readTransformedZipJsonFiles` and every
 * downstream consumer work unchanged.
 *
 * @param {object} params - Inputs.
 * @param {Record<string, string>} params.row - Seed row.
 * @param {readonly Record<string, unknown>[]} params.permits - Normalized permits for the parcel.
 * @returns {Record<string, Record<string, unknown>>} File basename to JSON body.
 */
export function buildLexiconFiles({ row, permits }) {
  const nal = nalRecordFromSeedRow(row);
  const parcelId = toText(row.parcel_id);
  const queryRow = mapJoinedRecordToQueryTableRow({
    nal: { ...nal, OWN_NAME: "", OWN_CITY: "", OWN_STATE: "", OWN_ZIPCD: "" },
    centroid:
      toText(row.latitude) === ""
        ? null
        : { latitude: Number(row.latitude), longitude: Number(row.longitude) },
    permits,
    sales: [],
  });

  /** @type {Record<string, Record<string, unknown>>} */
  const files = {
    "property.json": {
      request_identifier: parcelId,
      parcel_identifier: parcelId,
      property_type: queryRow.property_type,
      property_usage_type: queryRow.property_usage_type,
      property_structure_built_year: queryRow.built_year,
      livable_floor_area: queryRow.livable_floor_area,
      source_system: "lake_dor_roll",
    },
    "address.json": {
      county_name: COUNTY_NAME,
      state_code: STATE_CODE,
      unnormalized_address: toText(row.address),
      city_name: toText(row.city) || null,
      postal_code: toText(row.zip) || null,
      request_identifier: parcelId,
    },
    "lot.json": {
      lot_area_sqft: queryRow.lot_area_sqft,
      lot_size_acre: queryRow.lot_size_acre,
      request_identifier: parcelId,
    },
    "tax_1.json": {
      tax_year: Number(toText(row.source_ASMNT_YR)) || null,
      property_assessed_value_amount: queryRow.assessed_value,
      property_market_value_amount: queryRow.market_value,
      property_land_amount: queryRow.land_value,
      request_identifier: parcelId,
    },
  };
  if (queryRow.latitude !== null && queryRow.longitude !== null) {
    files["geometry.json"] = {
      latitude: queryRow.latitude,
      longitude: queryRow.longitude,
      request_identifier: parcelId,
    };
  }
  if (queryRow.last_sale_date !== null) {
    files["sales_history_1.json"] = {
      ownership_transfer_date: queryRow.last_sale_date,
      purchase_price_amount: queryRow.last_sale_price,
      request_identifier: parcelId,
    };
  }
  permits.forEach((permit, index) => {
    files[`permit_${index + 1}.json`] = { ...permit, request_identifier: parcelId };
  });
  return files;
}

/**
 * Fail closed unless a transformed address carries this county's name.
 *
 * @param {Record<string, unknown> | null | undefined} record - Transformed `data/address.json`.
 * @returns {void}
 */
export function assertTransformedCounty(record) {
  if (!record || typeof record !== "object") {
    throw new Error(`transformed address is missing; expected county_name ${COUNTY_NAME}`);
  }
  if (record.county_name !== COUNTY_NAME) {
    throw new Error(`transformed county_name must be ${COUNTY_NAME}, got ${String(record.county_name)}`);
  }
}

/**
 * Classify a Lake capture/transform failure, layering county-specific
 * permanent patterns on the shared retry rules.
 *
 * @param {unknown} error - Error or message.
 * @returns {"transient" | "permanent" | "unknown"} Retry classification.
 */
export function classifyLakeFailure(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/not a canonical lake parcel id|does not match source_parcel_id|county_name|enoent/.test(message)) {
    return "permanent";
  }
  return classifyFailure(error);
}

/**
 * @param {string} parcelDir - Per-parcel output directory.
 * @returns {Promise<boolean>} Whether a usable `transformed.zip` exists.
 */
export async function hasCompletedTransform(parcelDir) {
  try {
    const buffer = await readFile(path.join(parcelDir, "transformed.zip"));
    return buffer.length >= MIN_TRANSFORMED_ZIP_BYTES && buffer.subarray(0, 4).equals(ZIP_LOCAL_FILE_MAGIC);
  } catch {
    return false;
  }
}

/**
 * @param {string} dataDir - Parcel `data` directory.
 * @param {string} zipPath - Destination zip path.
 * @returns {Promise<void>} Resolves once written.
 */
async function zipDataDirectory(dataDir, zipPath) {
  const zip = new AdmZipCtor();
  for (const name of (await readdir(dataDir)).sort()) {
    zip.addLocalFile(path.join(dataDir, name), "data");
  }
  await new Promise((resolve, reject) => {
    zip.writeZip(zipPath, (error) => (error ? reject(error) : resolve(undefined)));
  });
}

/**
 * Load the permits harvested for the county, indexed by alternate key.
 *
 * @param {string} permitsPath - Path to the normalized permits JSON.
 * @returns {Promise<Map<string, Record<string, unknown>[]>>} Alternate key to permits.
 */
export async function loadPermitIndex(permitsPath) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const index = new Map();
  if (!(await pathExists(permitsPath))) return index;
  const permits = JSON.parse(await readFile(permitsPath, "utf8"));
  for (const permit of permits) {
    const key = toText(permit.alternate_key);
    if (key.length === 0) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(permit);
    else index.set(key, [permit]);
  }
  return index;
}

/**
 * Transform every seed row into per-parcel lexicon artifacts.
 *
 * Unlike the portal-scraping counties this never needs `--live-fetch`: the
 * roll record is already on the seed row, so `htmlDir` and `liveFetch` are
 * accepted for interface compatibility and ignored.
 *
 * @param {object} options - Options.
 * @param {readonly Record<string, string>[]} options.seedRows - Seed rows to ingest.
 * @param {string} options.outputDir - Run directory.
 * @param {string} [options.permitsPath] - Normalized permits JSON to join.
 * @param {string} [options.jobId] - Retry-ledger job id.
 * @returns {Promise<Record<string, unknown>>} Run manifest, also written to `manifest.json`.
 */
export async function captureAndTransform({ seedRows, outputDir, permitsPath, jobId = DEFAULT_JOB_ID }) {
  await mkdir(outputDir, { recursive: true });
  const permitIndex = await loadPermitIndex(
    permitsPath ?? path.join(RUNTIME_ROOT, "data", "downloads", "lake", "permits.json"),
  );
  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const row of seedRows) {
    const parcelId = toText(row.parcel_id);
    const parcelDir = path.join(outputDir, parcelId);
    try {
      assertSeedRowParcel(row);
      await mkdir(path.join(parcelDir, "data"), { recursive: true });
      const permits = permitIndex.get(toText(row.alt_key)) ?? [];
      const files = buildLexiconFiles({ row, permits });
      for (const [name, body] of Object.entries(files)) {
        await writeFile(
          path.join(parcelDir, "data", name),
          `${JSON.stringify(body, null, 2)}\n`,
          "utf8",
        );
      }
      assertTransformedCounty(files["address.json"]);
      await writeFile(
        path.join(parcelDir, "source_record.json"),
        `${JSON.stringify(nalRecordFromSeedRow(row), null, 2)}\n`,
        "utf8",
      );
      await zipDataDirectory(path.join(parcelDir, "data"), path.join(parcelDir, "transformed.zip"));
      results.push({
        parcelId,
        transformSuccess: true,
        classification: "success",
        propertyUsageType: files["property.json"].property_usage_type ?? null,
        permitCount: permits.length,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureClass = classifyLakeFailure(error);
      await appendFailure(outputDir, jobId, {
        parcelId,
        error: message,
        classification: failureClass,
        attempts: 1,
        at: new Date().toISOString(),
        jobId,
      });
      results.push({
        parcelId,
        transformSuccess: false,
        classification: failureClass === "permanent" ? "permanent_failure" : "retryable_failure",
        propertyUsageType: null,
        permitCount: 0,
        error: message,
      });
    }
  }
  const reconciled = {
    seedRows: seedRows.length,
    success: results.filter((row) => row.classification === "success").length,
    permanentFailure: results.filter((row) => row.classification === "permanent_failure").length,
    retryableFailure: results.filter((row) => row.classification === "retryable_failure").length,
  };
  const manifest = { county: COUNTY_KEY, outputDir, jobId, results, reconciled };
  await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/**
 * Structurally validate an ingest run: the manifest reconciles, parcel ids
 * are unique, at least one parcel succeeded, and every successful parcel has
 * a real `transformed.zip` carrying the required artifacts.
 *
 * @param {Record<string, any>} manifest - Ingest run manifest.
 * @param {{ allowEmpty?: boolean }} [options] - Validation options.
 * @returns {Promise<{ valid: boolean, checked: number, issues: { parcelId: string | null, reason: string }[] }>}
 *   Validation summary.
 */
export async function validateRun(manifest, options = {}) {
  /** @type {{ parcelId: string | null, reason: string }[]} */
  const issues = [];
  let checked = 0;
  const reconciled = manifest.reconciled;
  const sum = reconciled.success + reconciled.permanentFailure + reconciled.retryableFailure;
  if (sum !== reconciled.seedRows) {
    issues.push({ parcelId: null, reason: `seed ${reconciled.seedRows} != success + failures ${sum}` });
  }
  const ids = manifest.results.map((/** @type {any} */ result) => result.parcelId);
  if (new Set(ids).size !== ids.length) {
    issues.push({ parcelId: null, reason: "duplicate parcelId in run results" });
  }
  if (reconciled.seedRows > 0 && reconciled.success === 0 && options.allowEmpty !== true) {
    issues.push({
      parcelId: null,
      reason:
        `0 of ${reconciled.seedRows} seed rows produced a successful parcel; refusing to treat an ` +
        "all-failure run as valid. Pass { allowEmpty: true } to permit an empty export.",
    });
  }
  for (const parcel of manifest.results) {
    if (parcel.classification !== "success") continue;
    checked += 1;
    const parcelDir = path.join(manifest.outputDir, parcel.parcelId);
    if (!(await hasCompletedTransform(parcelDir))) {
      issues.push({ parcelId: parcel.parcelId, reason: "transformed.zip missing or not a valid PKZIP" });
      continue;
    }
    const files = readTransformedZipJsonFiles(path.join(parcelDir, "transformed.zip"));
    for (const required of REQUIRED_DATA_ARTIFACTS) {
      if (files[required] === undefined) {
        issues.push({ parcelId: parcel.parcelId, reason: `transformed.zip is missing data/${required}` });
      }
    }
  }
  return { valid: issues.length === 0, checked, issues };
}

/**
 * Read a Parquet file's column names in order, using the DuckDB CLI.
 *
 * @param {string} parquetPath - Parquet path.
 * @returns {Promise<string[]>} Column names in file order.
 */
export async function readParquetColumns(parquetPath) {
  const { stdout } = await execFileAsync("duckdb", [
    "-json",
    "-c",
    `DESCRIBE SELECT * FROM '${parquetPath}';`,
  ]);
  return JSON.parse(stdout).map((/** @type {{ column_name: string }} */ row) => row.column_name);
}

/**
 * Count rows and distinct folios in a Parquet query table.
 *
 * @param {string} parquetPath - Parquet path.
 * @returns {Promise<{ rows: number, distinctFolio: number, nullFolio: number }>} Gate counters.
 */
export async function readQueryTableCounts(parquetPath) {
  const { stdout } = await execFileAsync("duckdb", [
    "-json",
    "-c",
    `SELECT count(*) AS rows, count(DISTINCT request_identifier) AS distinct_folio, ` +
      `count(*) FILTER (WHERE request_identifier IS NULL OR request_identifier = '') AS null_folio ` +
      `FROM '${parquetPath}';`,
  ]);
  const row = JSON.parse(stdout)[0];
  return { rows: Number(row.rows), distinctFolio: Number(row.distinct_folio), nullFolio: Number(row.null_folio) };
}

/**
 * Assert the kit's query-table publication gate against a Parquet file:
 * row count equals distinct folio count, and no folio is null or empty.
 *
 * @param {string} parquetPath - Parquet path.
 * @returns {Promise<{ rows: number, distinctFolio: number, nullFolio: number }>} The counters that passed.
 */
export async function assertQueryTableGate(parquetPath) {
  const counts = await readQueryTableCounts(parquetPath);
  if (counts.nullFolio !== 0) {
    throw new Error(`Query table has ${counts.nullFolio} null or empty request_identifier values`);
  }
  if (counts.rows !== counts.distinctFolio) {
    throw new Error(
      `Query table row count ${counts.rows} != distinct request_identifier ${counts.distinctFolio}`,
    );
  }
  assertQueryTableColumns(await readParquetColumns(parquetPath));
  return counts;
}

/**
 * Build the publication artifacts for a completed Lake run.
 *
 * Two modes. When `parquetPath` is supplied the county-scale Parquet built by
 * the DuckDB consolidation is adopted as-is after passing the publication
 * gate. Otherwise the per-parcel `transformed.zip` output of a pilot run is
 * read and the Parquet is written with the kit's own Parquet writer. Both
 * produce the same three files the `elephant-county publish` verb consumes.
 *
 * @param {object} run - Options.
 * @param {string} run.publishDir - Destination directory.
 * @param {string} [run.parquetPath] - Pre-built county Parquet to adopt.
 * @param {string} [run.outputDir] - Pilot ingest directory.
 * @param {readonly Record<string, string>[]} [run.seedRows] - Pilot seed rows.
 * @param {number} [run.expectedCount] - Denominator for coverage. Defaults to the row count.
 * @param {boolean} [run.allowEmpty] - Permit a zero-row export.
 * @returns {Promise<Record<string, unknown>>} Written artifact paths and counts.
 */
export async function buildPublicationArtifacts(run) {
  await mkdir(run.publishDir, { recursive: true });
  const parquetPath = path.join(run.publishDir, "query-table.parquet");
  const coveragePath = path.join(run.publishDir, "dataset-coverage.json");
  const manifestPath = path.join(run.publishDir, "manifest.json");

  let rowCount;
  if (run.parquetPath !== undefined) {
    if (path.resolve(run.parquetPath) !== path.resolve(parquetPath)) {
      await writeFile(parquetPath, await readFile(run.parquetPath));
    }
    const counts = await assertQueryTableGate(parquetPath);
    rowCount = counts.rows;
  } else {
    const seedRows = run.seedRows ?? [];
    const permitIndex = await loadPermitIndex(
      path.join(RUNTIME_ROOT, "data", "downloads", "lake", "permits.json"),
    );
    /** @type {Record<string, unknown>[]} */
    const rows = [];
    for (const row of seedRows) {
      const zipPath = path.join(run.outputDir ?? "", row.parcel_id, "transformed.zip");
      if (!(await pathExists(zipPath))) continue;
      const nal = nalRecordFromSeedRow(row);
      rows.push(
        mapJoinedRecordToQueryTableRow({
          nal,
          centroid:
            toText(row.latitude) === ""
              ? null
              : { latitude: Number(row.latitude), longitude: Number(row.longitude) },
          permits: permitIndex.get(toText(row.alt_key)) ?? [],
          sales: [],
        }),
      );
    }
    const identifiers = rows.map((row) => row.request_identifier);
    if (new Set(identifiers).size !== identifiers.length) {
      throw new Error("Query table would contain duplicate request_identifier values");
    }
    if (seedRows.length > 0 && rows.length === 0 && run.allowEmpty !== true) {
      throw new Error(
        `Refusing to publish an empty Lake query table: 0 of ${seedRows.length} seed rows produced a ` +
          "successful, complete parcel. Pass { allowEmpty: true } to permit an empty export.",
      );
    }
    await writeQueryTableParquet({
      parquetPath,
      schemaFields: LAKE_QUERY_TABLE_SCHEMA_FIELDS,
      rows,
    });
    rowCount = rows.length;
  }

  const exportedAt = new Date().toISOString();
  const coverage = buildCoverageSnapshot({
    county: COUNTY_KEY,
    source: "appraisal",
    ingestedCount: rowCount,
    expectedCount: run.expectedCount ?? rowCount,
    exportedAt,
    ipnsLabel: COVERAGE_IPNS_LABEL,
  });
  await writeFile(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`, "utf8");

  const artifacts = {
    county: COUNTY_KEY,
    parquetPath,
    coveragePath,
    manifestPath,
    bucket: QUERY_TABLE_BUCKET,
    queryTableIpnsLabel: QUERY_TABLE_IPNS_LABEL,
    coverageIpnsLabel: COVERAGE_IPNS_LABEL,
    rowCount,
    expectedCount: run.expectedCount ?? rowCount,
  };
  await writeFile(manifestPath, `${JSON.stringify(artifacts, null, 2)}\n`, "utf8");
  return artifacts;
}

/** Lake adapter object consumed by the generic CLI/replay orchestration. */
export const lakeAdapter = {
  key: COUNTY_KEY,
  countyName: COUNTY_NAME,
  transformsDir: TRANSFORMS_DIR,
  flowPath: null,
  buildSeed: buildLakeSeedFiles,
  captureAndTransform,
  validateRun,
  buildPublicationArtifacts,
};
