#!/usr/bin/env node
/**
 * Acquire every Lake County bulk source into `data/downloads/lake/`:
 * the Florida DOR NAL, SDF and TPP roll files, the Florida GIO parcel
 * centroids, and the Lake County CD Plus permit layer.
 *
 * This is the live-network half of the Lake adapter, kept out of
 * `src/counties/lake/` for the same reason the Duval adapter keeps its roll
 * download out of `seed.mjs`: the modules under `src/` must stay importable
 * and testable with no network and no credentials.
 *
 * Permits support an incremental window. `--since <ISO date>` narrows the
 * scan to features whose `Permit_LastModDate` moved after that instant,
 * which is the only field that changes when an existing permit changes
 * status. A run without `--since` performs a full scan.
 *
 * Usage:
 *   node scripts/lake/fetch-sources.mjs [--only rolls|centroids|permits]
 *                                       [--since 2026-09-01]
 *                                       [--concurrency 4]
 *                                       [--limit 2000]
 *
 * @module scripts/lake/fetch-sources
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CDPLUS_PERMIT_LAYER,
  GIO_CENTROID_LAYER,
  dorDownloadUrl,
  fetchObjectIdRange,
  fetchObjectIds,
  listDorFiles,
  mapWithConcurrency,
  normalizePermit,
  permitWindowClause,
  selectLakeRollFile,
  toObjectIdRanges,
} from "../../src/counties/lake/sources.mjs";
import { renderCsv } from "../../src/core/csv.mjs";

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOWNLOAD_DIR = path.join(RUNTIME_ROOT, "data", "downloads", "lake");

const ROLLS = Object.freeze([
  { dataset: "NAL", match: "NAL", file: "nal.zip" },
  { dataset: "SDF", match: "SDF", file: "sdf.zip" },
  { dataset: "NAP", match: "TPP", file: "tpp.zip" },
]);

const CENTROID_FIELDS = "OBJECTID,PARCEL_ID,ALT_KEY,CO_NO";
const PERMIT_FIELDS =
  "OBJECTID,Permit_Number,Alternate_Key,Parcel_ID,Permit_Type,Permit_Desc,Permit_Status," +
  "PermitApplied_Date,PermitApproved_Date,PermitIssued_Date,CO_Date,Permit_LastModDate,PermitURL";

/**
 * @param {readonly string[]} argv - Raw CLI arguments.
 * @returns {Record<string, string | boolean>} Parsed flags.
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return flags;
}

/**
 * @param {string} message - Structured log line.
 * @param {Record<string, unknown>} [fields] - Additional fields.
 * @returns {void}
 */
function log(message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: message, ...fields })}\n`);
}

/**
 * Download one DOR roll file and record its sha256 as the source revision.
 *
 * @param {{ dataset: string, match: string, file: string }} roll - Roll descriptor.
 * @returns {Promise<{ dataset: string, name: string, path: string, bytes: number, sha256: string }>} Download record.
 */
async function downloadRoll(roll) {
  const files = await listDorFiles(roll.dataset);
  const selected = selectLakeRollFile(files, roll.match);
  const url = dorDownloadUrl(selected.serverRelativeUrl);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`DOR download HTTP ${response.status} for ${selected.name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const target = path.join(DOWNLOAD_DIR, roll.file);
  await writeFile(target, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  log("roll_downloaded", { dataset: roll.dataset, name: selected.name, bytes: bytes.length, sha256 });

  // Extract here, not somewhere else later. The DOR ships these as ZIPs and
  // build-query-table.sql reads the CSVs inside them by name, so a machine that
  // only ran this script had the archives and none of the files the next step
  // opens. It worked locally because the CSVs had been extracted by hand once,
  // and would have failed on the first clean CI runner.
  //
  // System `unzip` on purpose: streaming unzip libraries cannot read every
  // method the state uses, and this is the same reason the kit's Sunbiz skill
  // calls out Deflate64.
  const extracted = execFileSync("unzip", ["-o", "-j", target, "-d", DOWNLOAD_DIR], {
    encoding: "utf8",
  });
  const csvNames = [...extracted.matchAll(/inflating:\s+\S*?([^/\s]+\.csv)/gi)].map((m) => m[1]);
  if (csvNames.length === 0) {
    throw new Error(`${roll.file} contained no CSV; build-query-table.sql would fail on it`);
  }
  log("roll_extracted", { dataset: roll.dataset, files: csvNames });

  return {
    dataset: roll.dataset,
    name: selected.name,
    path: target,
    bytes: bytes.length,
    sha256,
    extracted: csvNames,
  };
}

/**
 * Fetch every Lake parcel centroid using the ids-only + OBJECTID-range
 * strategy the GIO service requires past 20,000 rows.
 *
 * @param {object} options - Fetch options.
 * @param {number} options.concurrency - Parallel range requests.
 * @param {number | null} options.limit - Stop after this many rows (bounded probe).
 * @returns {Promise<{ rows: Record<string, string>[], path: string }>} Centroid rows and the CSV written.
 */
async function fetchCentroids(options) {
  const started = Date.now();
  const objectIds = await fetchObjectIds(GIO_CENTROID_LAYER, "CO_NO=45");
  log("centroid_ids_fetched", { count: objectIds.length, elapsedMs: Date.now() - started });
  const selected = options.limit === null ? objectIds : objectIds.slice(0, options.limit);
  const ranges = toObjectIdRanges(selected);
  const pages = await mapWithConcurrency(ranges, options.concurrency, async (range, index) => {
    const features = await fetchObjectIdRange(GIO_CENTROID_LAYER, range, {
      outFields: CENTROID_FIELDS,
      where: "CO_NO=45",
      returnGeometry: true,
    });
    if ((index + 1) % 20 === 0) log("centroid_page", { page: index + 1, of: ranges.length });
    return features;
  });
  const rows = pages.flat().map((feature) => {
    const geometry = /** @type {{ x?: number, y?: number } | null} */ (feature.geometry);
    return {
      parcel_id: String(feature.PARCEL_ID ?? "").trim(),
      alt_key: String(feature.ALT_KEY ?? "").trim(),
      latitude: geometry?.y === undefined || geometry?.y === null ? "" : String(geometry.y),
      longitude: geometry?.x === undefined || geometry?.x === null ? "" : String(geometry.x),
    };
  });
  const target = path.join(DOWNLOAD_DIR, "centroids.csv");
  await writeFile(target, renderCsv(["parcel_id", "alt_key", "latitude", "longitude"], rows), "utf8");
  log("centroids_fetched", { rows: rows.length, elapsedMs: Date.now() - started, path: target });
  return { rows, path: target };
}

/**
 * Fetch CD Plus permits, optionally windowed on `Permit_LastModDate`.
 *
 * @param {object} options - Fetch options.
 * @param {number} options.concurrency - Parallel range requests.
 * @param {Date | null} options.since - Incremental lower bound, or null for a full scan.
 * @param {number | null} options.limit - Stop after this many rows (bounded probe).
 * @returns {Promise<{ permits: Record<string, unknown>[], path: string }>} Normalized permits and the JSON written.
 */
async function fetchPermits(options) {
  const started = Date.now();
  const where = permitWindowClause(options.since);
  const objectIds = await fetchObjectIds(CDPLUS_PERMIT_LAYER, where);
  log("permit_ids_fetched", { count: objectIds.length, where, elapsedMs: Date.now() - started });
  const selected = options.limit === null ? objectIds : objectIds.slice(0, options.limit);
  const ranges = toObjectIdRanges(selected, 1000);
  const pages = await mapWithConcurrency(ranges, options.concurrency, async (range, index) => {
    const features = await fetchObjectIdRange(CDPLUS_PERMIT_LAYER, range, {
      outFields: PERMIT_FIELDS,
      where,
    });
    if ((index + 1) % 5 === 0) log("permit_page", { page: index + 1, of: ranges.length });
    return features;
  });
  const permits = pages.flat().map((feature) => normalizePermit(feature));
  const suffix = options.since === null ? "" : "-window";
  const target = path.join(DOWNLOAD_DIR, `permits${suffix}.json`);
  await writeFile(target, `${JSON.stringify(permits, null, 2)}\n`, "utf8");
  // An incremental window is merged into the canonical permit set by permit
  // number, so a windowed refresh is idempotent: re-running the same window
  // upserts the same records and leaves everything else untouched. Without
  // this the window would be a partial snapshot pretending to be the county.
  let merged = permits;
  if (options.since !== null) {
    merged = await mergePermitWindow(permits);
    log("permit_window_merged", { windowed: permits.length, total: merged.length });
  }
  // A CSV twin is written alongside the JSON so the DuckDB consolidation can
  // read permits without a JSON reader. Booleans render as lowercase `true`/
  // `false` so SQL predicates can compare them literally.
  const permitColumns = [
    "permit_number", "alternate_key", "parcel_id", "permit_type", "permit_desc",
    "permit_status", "applied_date", "approved_date", "issued_date", "co_date",
    "last_modified", "permit_url", "is_roofing", "is_open", "days_open",
  ];
  const csvRows = merged.map((permit) => {
    /** @type {Record<string, string>} */
    const row = {};
    for (const column of permitColumns) {
      const value = /** @type {Record<string, unknown>} */ (permit)[column];
      row[column] = value === null || value === undefined ? "" : String(value);
    }
    return row;
  });
  await writeFile(path.join(DOWNLOAD_DIR, "permits.csv"), renderCsv(permitColumns, csvRows), "utf8");
  if (options.since !== null) {
    await writeFile(path.join(DOWNLOAD_DIR, "permits.json"), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }
  const distinct = new Set(permits.map((permit) => permit.permit_number)).size;
  log("permits_fetched", {
    features: permits.length,
    distinctPermits: distinct,
    roofing: permits.filter((permit) => permit.is_roofing).length,
    open: permits.filter((permit) => permit.is_open).length,
    elapsedMs: Date.now() - started,
    path: target,
  });
  return { permits, path: target };
}

/**
 * Upsert a windowed permit fetch into the canonical permit set, keyed by
 * permit number and parcel so a multi-parcel permit keeps each of its rows.
 *
 * @param {readonly Record<string, unknown>[]} windowed - Permits from the window fetch.
 * @returns {Promise<Record<string, unknown>[]>} The merged permit set.
 */
export async function mergePermitWindow(windowed) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byKey = new Map();
  const key = (permit) => `${permit.permit_number}::${permit.alternate_key}`;
  try {
    const existing = JSON.parse(await readFile(path.join(DOWNLOAD_DIR, "permits.json"), "utf8"));
    for (const permit of existing) byKey.set(key(permit), permit);
  } catch {
    // No prior full scan; the window becomes the whole set.
  }
  for (const permit of windowed) byKey.set(key(permit), permit);
  return [...byKey.values()];
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves when every requested source is on disk.
 */
async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const only = typeof flags.only === "string" ? flags.only : "all";
  const concurrency = Number(flags.concurrency ?? 4);
  const limit = flags.limit === undefined ? null : Number(flags.limit);
  const since = typeof flags.since === "string" ? new Date(flags.since) : null;
  await mkdir(DOWNLOAD_DIR, { recursive: true });

  /** @type {Record<string, unknown>} */
  const summary = { startedAt: new Date().toISOString(), only, since: since?.toISOString() ?? null };

  if (only === "all" || only === "rolls") {
    summary.rolls = [];
    for (const roll of ROLLS) {
      summary.rolls.push(await downloadRoll(roll));
    }
  }
  if (only === "all" || only === "centroids") {
    const centroids = await fetchCentroids({ concurrency, limit });
    summary.centroids = { rows: centroids.rows.length, path: centroids.path };
  }
  if (only === "all" || only === "permits") {
    const permits = await fetchPermits({ concurrency, since, limit });
    summary.permits = { features: permits.permits.length, path: permits.path };
  }

  summary.finishedAt = new Date().toISOString();
  const summaryPath = path.join(DOWNLOAD_DIR, "fetch-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  log("fetch_complete", { summaryPath });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

export { downloadRoll, fetchCentroids, fetchPermits, parseArgs };
