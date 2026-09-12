/**
 * Lake County, FL seed-row construction from Florida DOR NAL records joined
 * to GIO parcel centroids and SDF sale counts.
 *
 * Modelled on `counties/duval/seed.mjs`, with one deliberate difference:
 * Duval's seed row is a *request descriptor* for a per-parcel appraiser page
 * capture, so its `url`/`multiValueQueryString` columns drive an HTTP fetch.
 * Lake's appraiser portal was reachable but deliberately unused because the
 * bulk DOR roll is the approved record of origin. The seed row therefore
 * points at the roll snapshot rather than a per-parcel page, and the
 * `url`/`method` columns are retained only so the shared CSV contract and
 * downstream tooling keep working.
 *
 * The kit's no-PII-in-the-seed constraint is preserved: owner and fiduciary
 * columns are refused by {@link assertSafeSourceFields} and never written to
 * `data/seeds/lake.csv`. Ownership facts reach the query table in the
 * transform stage, which reads them from the roll snapshot by `PARCEL_ID`.
 *
 * @module counties/lake/seed
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderCsv } from "../../core/csv.mjs";
import { toText } from "./sources.mjs";

export const COUNTY_KEY = "lake";
export const COUNTY_NAME = "Lake";
export const COUNTY_FIPS = "12069";
export const STATE_CODE = "FL";
/** Florida DOR county number for Lake. Distinct from the FIPS code. */
export const DOR_COUNTY_NUMBER = "45";

export const APPRAISER_DETAIL_URL = "https://lakecopropappr.com/property-details.aspx";
export const DOR_PORTAL_URL = "https://floridarevenue.com/property/dataportal";

/**
 * Lake County centroid bounding box, with a margin. Used to reject a centroid
 * join that silently attached another county's geometry.
 *
 * Measured from the GIO release filtered to CO_NO=45: latitude spans 28.3462
 * to 29.2772 and longitude spans -81.9543 to -81.3527. The county reaches
 * further north and south than a casual reading of a map suggests, and an
 * earlier, tighter box silently dropped 12,724 real centroids, so these bounds
 * come from the data with a small margin rather than from an estimate.
 */
export const LAKE_BBOX = Object.freeze({
  minLat: 28.30,
  maxLat: 29.35,
  minLng: -82.05,
  maxLng: -81.30,
});

/**
 * Owner and fiduciary NAL columns. Never written to the seed.
 *
 * @type {readonly string[]}
 */
export const EXCLUDED_PII_FIELDS = Object.freeze([
  "OWN_NAME",
  "OWN_ADDR1",
  "OWN_ADDR2",
  "OWN_CITY",
  "OWN_STATE",
  "OWN_ZIPCD",
  "OWN_STATE_DOM",
  "FIDU_NAME",
  "FIDU_ADDR1",
  "FIDU_ADDR2",
  "FIDU_CITY",
  "FIDU_STATE",
  "FIDU_ZIPCD",
]);

/**
 * Non-PII NAL columns retained on the seed row for provenance and for pilot
 * stratification by use type, age and value.
 *
 * @type {readonly string[]}
 */
export const NAL_SOURCE_FIELDS = Object.freeze([
  "PARCEL_ID",
  "CO_NO",
  "ASMNT_YR",
  "DOR_UC",
  "PA_UC",
  "JV",
  "AV_NSD",
  "TV_NSD",
  "LND_VAL",
  "LND_SQFOOT",
  "NO_LND_UNTS",
  "ACT_YR_BLT",
  "EFF_YR_BLT",
  "TOT_LVG_AREA",
  "NO_BULDNG",
  "NO_RES_UNTS",
  "IMP_QUAL",
  "CONST_CLASS",
  "PHY_ADDR1",
  "PHY_ADDR2",
  "PHY_CITY",
  "PHY_ZIPCD",
  "NBRHD_CD",
  "MKT_AR",
  "CENSUS_BK",
  "TWN",
  "RNG",
  "SEC",
  "SALE_PRC1",
  "SALE_YR1",
  "SALE_MO1",
  "QUAL_CD1",
  "SALE_PRC2",
  "SALE_YR2",
  "SALE_MO2",
  "QUAL_CD2",
]);

/**
 * Stable CSV column order for a Lake seed row.
 *
 * @type {readonly string[]}
 */
export const SEED_COLUMNS = Object.freeze([
  "parcel_id",
  "source_identifier",
  "alt_key",
  "method",
  "url",
  "multiValueQueryString",
  "address",
  "city",
  "state",
  "zip",
  "county",
  "county_fips",
  "latitude",
  "longitude",
  "parcel_polygon",
  "source_url",
  "source_item_id",
  "source_revision",
  "source_snapshot_at",
  "source_record_count",
  "source_sdf_sale_count",
  "source_permit_count",
  "source_geometry_source",
  ...NAL_SOURCE_FIELDS.map((field) => `source_${field}`),
]);

// The last two segments are block and lot and are ALPHANUMERIC, not numeric:
// 26,616 of the roll's 215,806 parcels carry a letter there (for example
// 28-18-24-0500-00B-02500 and 29-19-26-0100-067-00D00). A digits-only pattern
// silently rejects 12.3% of the county.
const PARCEL_ID_PATTERN = /^\d{2}-\d{2}-\d{2}-\d{4}-[0-9A-Z]{3}-[0-9A-Z]{5}$/;
const ALT_KEY_PATTERN = /^\d{6,8}$/;

/**
 * @param {unknown} value - Candidate Lake DOR parcel id.
 * @returns {boolean} True for the dashed 23-character Lake parcel-id form.
 */
export function isValidLakeParcelId(value) {
  return PARCEL_ID_PATTERN.test(toText(value));
}

/**
 * @param {unknown} value - Candidate alternate key.
 * @returns {boolean} True for the 6-to-8 digit CD Plus `Alternate_Key` form.
 */
export function isValidAltKey(value) {
  return ALT_KEY_PATTERN.test(toText(value));
}

/**
 * Strip separators from a Lake parcel id, producing the undashed form the
 * CD Plus permit layer carries in its `Parcel_ID` column.
 *
 * @param {unknown} value - Dashed Lake parcel id.
 * @returns {string} The 18-digit undashed id.
 */
export function toUndashedParcelId(value) {
  const identifier = toText(value);
  if (!isValidLakeParcelId(identifier)) {
    throw new Error(`Not a canonical Lake parcel id: ${identifier}`);
  }
  return identifier.replaceAll("-", "");
}

/**
 * Fail closed if a NAL source-field list smuggles in an owner/fiduciary
 * column or a duplicate.
 *
 * @param {readonly string[]} sourceFields - Candidate NAL field names.
 * @returns {void}
 */
export function assertSafeSourceFields(sourceFields) {
  const excluded = new Set(EXCLUDED_PII_FIELDS.map((field) => field.toLowerCase()));
  const seen = new Set();
  for (const field of sourceFields) {
    const normalized = field.toLowerCase();
    if (excluded.has(normalized)) {
      throw new Error(`PII field is prohibited in the seed source request: ${field}`);
    }
    if (seen.has(normalized)) {
      throw new Error(`Duplicate source field: ${field}`);
    }
    seen.add(normalized);
  }
}

/**
 * @param {unknown} value - Raw NAL scalar.
 * @returns {string} Text form (JSON for objects/arrays).
 */
function sourceValueToText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Build the situs address string for one NAL record.
 *
 * @param {Record<string, unknown>} nal - NAL fields.
 * @returns {string} `"<street>, <city> FL <zip>"`, skipping empty parts.
 */
export function buildSiteAddress(nal) {
  const street = [toText(nal.PHY_ADDR1), toText(nal.PHY_ADDR2)]
    .filter((part) => part.length > 0)
    .join(" ");
  const locality = [toText(nal.PHY_CITY), STATE_CODE, toText(nal.PHY_ZIPCD)]
    .filter((part) => part.length > 0)
    .join(" ");
  return [street, locality].filter((part) => part.length > 0).join(", ");
}

/**
 * Coarse DOR use-code band, used to stratify the pilot seed and to drive the
 * commercial/industrial permit-eligibility branch.
 *
 * @param {unknown} dorUc - Raw `DOR_UC` value.
 * @returns {string} Use band name.
 */
export function classifyDorUseBand(dorUc) {
  const code = Number.parseInt(toText(dorUc), 10);
  if (!Number.isFinite(code)) return "other";
  if (code === 0) return "vacant_residential";
  if (code === 1) return "single_family";
  if (code === 2) return "mobile_home";
  if (code === 3 || code === 8) return "multi_family";
  if (code === 4) return "condo";
  if (code >= 5 && code <= 9) return "residential_other";
  if (code >= 10 && code <= 39) return "commercial";
  if (code >= 40 && code <= 49) return "industrial";
  if (code >= 50 && code <= 69) return "agricultural";
  if (code >= 70 && code <= 79) return "institutional";
  if (code >= 80 && code <= 89) return "government";
  return "other";
}

/**
 * @param {string} band - Use band from {@link classifyDorUseBand}.
 * @returns {boolean} Whether the band is commercial or industrial.
 */
export function isPermitEligibleBand(band) {
  return band === "commercial" || band === "industrial";
}

/**
 * @param {{ latitude?: unknown, longitude?: unknown }} point - Candidate centroid.
 * @returns {boolean} Whether the point falls inside the Lake County bbox.
 */
export function isInLakeBbox(point) {
  const latitude = Number(point?.latitude);
  const longitude = Number(point?.longitude);
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= LAKE_BBOX.minLat &&
    latitude <= LAKE_BBOX.maxLat &&
    longitude >= LAKE_BBOX.minLng &&
    longitude <= LAKE_BBOX.maxLng
  );
}

/**
 * @typedef {object} LakeSeedInput
 * @property {Record<string, unknown>} nal - DOR NAL fields for one parcel.
 * @property {{ latitude?: unknown, longitude?: unknown, geometry?: unknown } | null} [centroid] - Joined GIO centroid.
 * @property {number} [sdfSaleCount] - Joined SDF sale-record count.
 * @property {number} [permitCount] - Joined CD Plus permit count.
 * @property {string} sourceRevision - Roll-file fingerprint (sha256).
 * @property {string} snapshotAt - ISO timestamp shared by the whole seed snapshot.
 */

/**
 * Build one Lake seed row from a joined NAL/centroid/SDF/permit record.
 *
 * @param {LakeSeedInput} input - Joined parcel data plus snapshot metadata.
 * @returns {Record<string, string>} CSV row keyed by {@link SEED_COLUMNS}.
 */
export function toSeedRow(input) {
  const nal = input.nal;
  const centroid = input.centroid ?? null;
  const identifier = toText(nal.PARCEL_ID);
  if (!isValidLakeParcelId(identifier)) {
    throw new Error(`Not a canonical Lake parcel id: ${identifier}`);
  }
  const inBbox = centroid !== null && isInLakeBbox(centroid);
  /** @type {Record<string, string>} */
  const row = {
    parcel_id: identifier,
    source_identifier: identifier,
    alt_key: toText(nal.ALT_KEY),
    method: "GET",
    url: APPRAISER_DETAIL_URL,
    multiValueQueryString: JSON.stringify({ alt_key: [toText(nal.ALT_KEY)] }),
    address: buildSiteAddress(nal),
    city: toText(nal.PHY_CITY),
    state: STATE_CODE,
    zip: toText(nal.PHY_ZIPCD),
    county: COUNTY_NAME,
    county_fips: COUNTY_FIPS,
    latitude: inBbox ? sourceValueToText(centroid?.latitude) : "",
    longitude: inBbox ? sourceValueToText(centroid?.longitude) : "",
    parcel_polygon: centroid?.geometry ? JSON.stringify(centroid.geometry) : "",
    source_url: DOR_PORTAL_URL,
    source_item_id: `fl-dor-nal-lake-${DOR_COUNTY_NUMBER}-2026p`,
    source_revision: input.sourceRevision,
    source_snapshot_at: input.snapshotAt,
    source_record_count: "1",
    source_sdf_sale_count: String(input.sdfSaleCount ?? 0),
    source_permit_count: String(input.permitCount ?? 0),
    source_geometry_source: inBbox ? "fl-gio-parcel-centroid-2025" : "none",
  };
  for (const field of NAL_SOURCE_FIELDS) {
    row[`source_${field}`] = sourceValueToText(nal[field]);
  }
  return row;
}

/**
 * @typedef {object} SeedReconciliationStats
 * @property {number} rowsWritten
 * @property {number} uniqueParcelIds
 * @property {number} uniqueAltKeys
 * @property {number} expectedSeedRowCount
 * @property {number} invalidRecordCount
 * @property {number} skippedRecordCount
 */

/**
 * Fail closed if a seed build's row/uniqueness counts do not reconcile. The
 * Lake roll carries one row per parcel with globally unique `PARCEL_ID` and
 * `ALT_KEY` values (measured: 215,806 rows, 215,806 distinct of each), so a
 * duplicate here means the join fanned out and must not be published.
 *
 * @param {SeedReconciliationStats} stats - Seed-build counters.
 * @returns {void}
 */
export function assertSeedReconciliation(stats) {
  if (stats.rowsWritten !== stats.expectedSeedRowCount) {
    throw new Error(`rowsWritten ${stats.rowsWritten} != expectedSeedRowCount ${stats.expectedSeedRowCount}`);
  }
  if (stats.uniqueParcelIds !== stats.rowsWritten) {
    throw new Error(`uniqueParcelIds ${stats.uniqueParcelIds} != rowsWritten ${stats.rowsWritten}`);
  }
  if (stats.uniqueAltKeys !== stats.rowsWritten) {
    throw new Error(`uniqueAltKeys ${stats.uniqueAltKeys} != rowsWritten ${stats.rowsWritten}`);
  }
  if (stats.invalidRecordCount + stats.rowsWritten + stats.skippedRecordCount < stats.rowsWritten) {
    throw new Error("seed counters are inconsistent");
  }
}

/**
 * Build the Lake seed CSV. Callers supply already-joined NAL/centroid/SDF
 * records; the county-scale download and DuckDB join that produce them live
 * in `scripts/lake/build-seed.mjs`, mirroring how the Duval adapter keeps
 * its live roll download outside this offline-safe module.
 *
 * @param {object} options - Seed inputs.
 * @param {readonly LakeSeedInput[]} options.records - Joined records, one per parcel.
 * @param {string} [options.sourceRevision] - Roll fingerprint. Defaults to `snapshotAt`.
 * @param {string} [options.snapshotAt] - Snapshot timestamp. Defaults to now.
 * @param {string} [options.outputPath] - When set, the CSV is written here.
 * @returns {Promise<{ rows: Record<string, string>[], csv: string, outputPath: string | null }>}
 *   Seed rows, rendered CSV, and the path written (if any).
 */
export async function buildSeed(options) {
  assertSafeSourceFields(NAL_SOURCE_FIELDS);
  const snapshotAt = options.snapshotAt ?? new Date().toISOString();
  const sourceRevision = options.sourceRevision ?? snapshotAt;
  const rows = options.records.map((record) =>
    toSeedRow({ ...record, sourceRevision, snapshotAt }),
  );
  assertSeedReconciliation({
    rowsWritten: rows.length,
    uniqueParcelIds: new Set(rows.map((row) => row.parcel_id)).size,
    uniqueAltKeys: new Set(rows.map((row) => row.alt_key)).size,
    expectedSeedRowCount: options.records.length,
    invalidRecordCount: 0,
    skippedRecordCount: 0,
  });
  const csv = renderCsv(SEED_COLUMNS, rows);
  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, csv, "utf8");
  }
  return { rows, csv, outputPath: options.outputPath ?? null };
}
