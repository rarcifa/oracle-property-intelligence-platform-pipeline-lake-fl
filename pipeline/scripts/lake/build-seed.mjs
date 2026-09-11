#!/usr/bin/env node
/**
 * Build the Lake County parcel seed CSV at `data/seeds/lake.csv`.
 *
 * The seed is the input of record for every later stage: refresh, repair and
 * pilot selection all read it rather than re-deriving work from the published
 * table. It is produced by joining the DOR NAL roll to the GIO centroids, the
 * SDF sale counts and the CD Plus permit counts, then handed to the county
 * adapter's `buildSeed`, which enforces the no-PII rule and the row/uniqueness
 * reconciliation before anything is written.
 *
 * Usage:
 *   node scripts/lake/build-seed.mjs [--limit 25] [--output <path>] [--commercial-first]
 *
 * @module scripts/lake/build-seed
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildSeed, NAL_SOURCE_FIELDS } from "../../src/counties/lake/seed.mjs";

const execFileAsync = promisify(execFile);
const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOWNLOAD_DIR = path.join(RUNTIME_ROOT, "data", "downloads", "lake");
const DEFAULT_OUTPUT = path.join(RUNTIME_ROOT, "data", "seeds", "lake.csv");

/**
 * @param {string} message - Event name.
 * @param {Record<string, unknown>} [fields] - Extra fields.
 * @returns {void}
 */
function log(message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: message, ...fields })}\n`);
}

/**
 * Join the roll to geometry, sales and permits with DuckDB and return one
 * record per parcel in the shape the adapter's `buildSeed` expects.
 *
 * @param {object} options - Options.
 * @param {number | null} options.limit - Row cap, for a pilot seed.
 * @param {boolean} options.commercialFirst - Sort commercial and industrial parcels first.
 * @returns {Promise<any[]>} Joined records.
 */
export async function loadJoinedRecords({ limit, commercialFirst }) {
  const order = commercialFirst
    ? "ORDER BY CASE WHEN TRY_CAST(n.DOR_UC AS INTEGER) BETWEEN 10 AND 49 THEN 0 ELSE 1 END, n.PARCEL_ID"
    : "ORDER BY n.PARCEL_ID";
  const columns = ["PARCEL_ID", "ALT_KEY", ...NAL_SOURCE_FIELDS.filter((field) => field !== "PARCEL_ID")]
    .map((field) => `n."${field}"`)
    .join(", ");
  const sql = `
    WITH centroid AS (
      SELECT alt_key, min(TRY_CAST(latitude AS DOUBLE)) lat, min(TRY_CAST(longitude AS DOUBLE)) lon
      FROM read_csv_auto('${DOWNLOAD_DIR}/centroids.csv', header=true, all_varchar=true)
      WHERE latitude <> '' AND longitude <> '' GROUP BY alt_key
    ), sale AS (
      SELECT PARCEL_ID, count(*) AS sale_count
      FROM read_csv_auto('${DOWNLOAD_DIR}/SDF45P202601.csv', header=true, all_varchar=true) GROUP BY 1
    ), permit AS (
      SELECT alternate_key, count(DISTINCT permit_number) AS permit_count
      FROM read_csv_auto('${DOWNLOAD_DIR}/permits.csv', header=true, all_varchar=true)
      WHERE alternate_key IS NOT NULL AND alternate_key <> '' GROUP BY 1
    )
    SELECT ${columns}, c.lat, c.lon,
           coalesce(s.sale_count, 0) AS sale_count,
           coalesce(p.permit_count, 0) AS permit_count
    FROM read_csv_auto('${DOWNLOAD_DIR}/NAL45P202601.csv', header=true, all_varchar=true) n
    LEFT JOIN centroid c ON c.alt_key = n.ALT_KEY
    LEFT JOIN sale s ON s.PARCEL_ID = n.PARCEL_ID
    LEFT JOIN permit p ON p.alternate_key = n.ALT_KEY
    ${order}
    ${limit === null ? "" : `LIMIT ${limit}`};`;
  const { stdout } = await execFileAsync("duckdb", ["-json", "-c", sql], {
    maxBuffer: 1024 * 1024 * 1024 * 2,
  });
  const rows = JSON.parse(stdout);
  return rows.map((row) => {
    /** @type {Record<string, unknown>} */
    const nal = {};
    for (const field of ["PARCEL_ID", "ALT_KEY", ...NAL_SOURCE_FIELDS]) {
      nal[field] = row[field] ?? "";
    }
    return {
      nal,
      centroid: row.lat === null ? null : { latitude: row.lat, longitude: row.lon },
      sdfSaleCount: Number(row.sale_count ?? 0),
      permitCount: Number(row.permit_count ?? 0),
    };
  });
}

/**
 * @returns {Promise<string>} sha256 of the NAL roll, used as the seed's source revision.
 */
export async function rollRevision() {
  const bytes = await readFile(path.join(DOWNLOAD_DIR, "nal.zip"));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const limitIndex = argv.indexOf("--limit");
  const outputIndex = argv.indexOf("--output");
  const limit = limitIndex > -1 ? Number(argv[limitIndex + 1]) : null;
  const outputPath = outputIndex > -1 ? argv[outputIndex + 1] : DEFAULT_OUTPUT;
  const commercialFirst = argv.includes("--commercial-first");

  (async () => {
    await mkdir(path.dirname(outputPath), { recursive: true });
    const started = Date.now();
    const records = await loadJoinedRecords({ limit, commercialFirst });
    log("records_joined", { records: records.length, elapsedMs: Date.now() - started });
    const result = await buildSeed({
      records,
      sourceRevision: await rollRevision(),
      snapshotAt: new Date().toISOString(),
      outputPath,
    });
    const written = await stat(outputPath);
    log("seed_built", {
      rows: result.rows.length,
      outputPath,
      bytes: written.size,
      withGeometry: result.rows.filter((row) => row.latitude !== "").length,
      withPermits: result.rows.filter((row) => row.source_permit_count !== "0").length,
      elapsedMs: Date.now() - started,
    });
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
