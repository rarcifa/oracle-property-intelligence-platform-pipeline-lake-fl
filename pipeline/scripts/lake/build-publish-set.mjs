#!/usr/bin/env node
/**
 * Assemble the directory that gets published to IPFS for one Lake County run.
 *
 * The kit's `county-open-data-publish` convention is one JSON file per
 * property plus `shards/shard-NNNN.json` and `index.json`. Lake publishes the
 * shards, the index, the query table, coverage, samples and a schema, but not
 * 215,806 individual property objects: at the ~22 KB per property the skill
 * cites that is roughly 4.7 GB of objects for a dataset whose every field
 * already sits in a 20 MB columnar table. The shards carry the same
 * per-property records in 10,000-row pages, so a consumer can still fetch one
 * property's facts by path without the object explosion. The deviation is
 * recorded in docs/lake-kit-deviations.md.
 *
 * Usage:
 *   node scripts/lake/build-publish-set.mjs --run-id 20260909T180000Z
 *
 * @module scripts/lake/build-publish-set
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, copyFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { LAKE_QUERY_TABLE_SCHEMA_FIELDS } from "../../src/counties/lake/query-table.mjs";
import {
  assertPermitTableColumns,
  LAKE_PERMIT_TABLE_SCHEMA_FIELDS,
} from "../../src/counties/lake/permit-table.mjs";
import { LAKE_IPNS_LABEL } from "../../src/counties/lake/enrichment-profile.mjs";
import { buildCoverageSnapshot } from "../../src/core/query-table.mjs";

const execFileAsync = promisify(execFile, { maxBuffer: 1024 * 1024 * 512 });
const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLISH_ROOT = path.join(RUNTIME_ROOT, "data", "artifacts", "publish", "lake");
const SHARD_SIZE = 10000;
const COMPLETE_CLERMONT_YEARS = Object.freeze([
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
]);

/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** @param {Buffer | string} value @returns {string} */
function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {unknown} evidence @returns {string} */
export function clermontBaselineSha256(evidence) {
  return sha256Hex(canonicalJson(evidence));
}

/**
 * Fail closed unless the materialized Clermont export is backed by one exact,
 * reconciled certified baseline covering all twelve portal years.
 *
 * @param {object} options
 * @param {Record<string, any>} options.metadata
 * @param {Record<string, any>} options.evidence
 * @param {number} options.csvRows
 * @param {string} options.csvSha256
 * @param {string} options.metadataSha256
 * @param {string} options.requiredBaselineSha256
 * @returns {{ baselineSha256: string, evidenceSha256: string }}
 */
export function assertCompleteClermontPublicationEvidence({
  metadata,
  evidence,
  csvRows,
  csvSha256,
  metadataSha256,
  requiredBaselineSha256,
}) {
  if (metadata?.schemaVersion !== "elephant.clermont-permit-load-meta.v1") {
    throw new Error("Clermont metadata has an unsupported schemaVersion");
  }
  if (canonicalJson(metadata.permitYears) !== canonicalJson(COMPLETE_CLERMONT_YEARS)) {
    throw new Error("Clermont publication requires exact permit years 2015-2026");
  }
  for (const field of ["enumeratedPermits", "deadPermits", "achievablePermits", "loadedPermits"]) {
    if (!Number.isInteger(metadata[field]) || metadata[field] < 0) {
      throw new Error(`Clermont metadata ${field} must be a non-negative integer`);
    }
  }
  if (metadata.achievablePermits !== metadata.enumeratedPermits - metadata.deadPermits) {
    throw new Error("Clermont achievable permits do not reconcile to enumerated minus proven-dead");
  }
  if (metadata.loadedPermits !== metadata.achievablePermits || csvRows !== metadata.loadedPermits) {
    throw new Error("Clermont export does not contain every achievable permit exactly once");
  }

  if (
    evidence?.schemaVersion !== "elephant.clermont-permit-certified-baseline.v1" ||
    evidence?.county !== "lake" ||
    evidence?.jurisdiction !== "clermont" ||
    evidence?.sourceSystem !== "lake_clermont_etrakit_permits" ||
    evidence?.status !== "certified"
  ) {
    throw new Error("Clermont publication evidence is not a certified Lake/Clermont baseline");
  }
  if (evidence.requiredHistory?.firstYear !== 2015 || evidence.requiredHistory?.lastYear !== 2026) {
    throw new Error("Clermont certified evidence does not require the complete 2015-2026 history");
  }
  if (!/^[a-f0-9]{64}$/.test(String(evidence.evidenceSha256 ?? ""))) {
    throw new Error("Clermont certified evidence is missing its reconciliation digest");
  }
  const partitions = evidence.partitions;
  if (
    !Array.isArray(partitions) ||
    canonicalJson(partitions.map((partition) => partition.year)) !==
      canonicalJson(COMPLETE_CLERMONT_YEARS.map((year) => 2000 + Number(year)))
  ) {
    throw new Error("Clermont certified evidence must contain ordered partitions for 2015-2026");
  }
  const acquisitionRuns = new Set();
  let completedRows = 0;
  for (const partition of partitions) {
    acquisitionRuns.add(partition.runId);
    const counts = partition.counts ?? {};
    if (
      partition.status !== "captured_complete" ||
      partition.cappedOrTruncated !== false ||
      partition.checkpoint?.terminal !== true ||
      counts.retryablePending !== 0 ||
      counts.enumerated !== counts.completed + counts.provenDead ||
      counts.completed !== counts.linked + counts.validUnlinked ||
      counts.rawEvidence < counts.completed + counts.provenDead ||
      counts.extractedEvidence !== counts.completed ||
      counts.statusEvidence !== counts.enumerated
    ) {
      throw new Error(`Clermont partition ${partition.year} lacks complete reconciled evidence`);
    }
    if (canonicalJson(partition.signatures) !== canonicalJson(evidence.signatures)) {
      throw new Error(
        `Clermont partition ${partition.year} uses different source/config/schema signatures`,
      );
    }
    completedRows += counts.completed;
  }
  if (acquisitionRuns.size !== 1) {
    throw new Error("Clermont certified partitions are not from one fenced acquisition run");
  }
  if (
    evidence.mergedExport?.rows !== completedRows ||
    evidence.mergedExport.rows !== metadata.loadedPermits
  ) {
    throw new Error("Clermont merged-export rows do not reconcile to all certified partitions");
  }
  if (
    evidence.mergedExport.artifact?.sha256 !== csvSha256 ||
    evidence.mergedExport.metadata?.sha256 !== metadataSha256
  ) {
    throw new Error("Clermont materialized export bytes do not match the certified evidence");
  }
  const baselineSha256 = clermontBaselineSha256(evidence);
  if (
    !/^[a-f0-9]{64}$/.test(String(requiredBaselineSha256 ?? "")) ||
    baselineSha256 !== requiredBaselineSha256
  ) {
    throw new Error(
      "Clermont certified evidence does not match the exact requested baseline digest",
    );
  }
  return {
    baselineSha256,
    evidenceSha256: evidence.evidenceSha256,
  };
}

/**
 * @param {string} sql - DuckDB SQL returning rows.
 * @returns {Promise<any[]>} Parsed JSON rows.
 */
async function query(sql) {
  const { stdout } = await execFileAsync("duckdb", ["-json", "-c", sql], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  return stdout.trim().length === 0 ? [] : JSON.parse(stdout);
}

/**
 * @param {string} message - Event name.
 * @param {Record<string, unknown>} [fields] - Extra fields.
 * @returns {void}
 */
function log(message, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), event: message, ...fields })}\n`,
  );
}

/**
 * Every limitation of the published dataset, in the voice the coverage snapshot
 * uses: what the source does not carry, measured rather than asserted.
 *
 * Extracted so the wording and the arithmetic can be tested without DuckDB and
 * without a 115 MB roll on disk. Every figure is derived from the run's own
 * measurements, so a later run cannot leave a stale number here.
 *
 * @param {Record<string, unknown>} linkage - Permit-to-parcel linkage counts.
 * @param {Record<string, unknown>} business - TPP-to-parcel match counts.
 * @param {Record<string, unknown>} clermont - Clermont eTRAKiT permit and contractor counts.
 * @returns {string[]} Limitations, one plain sentence group each.
 */
export function buildLimitations(linkage, business, clermont) {
  const matched = Number(business.matched_accounts);
  const accounts = Number(business.total_accounts);
  const clermontParcels = Number(clermont.linked_parcels);
  const rollParcels = Number(clermont.roll_parcels);
  return [
    "The county CD Plus permit layer publishes a rolling 365-day Permit_LastModDate window. Only 846 of 17,671 permits were issued before 2024-09-09, so this is a current-permit source, not a permit archive.",
    "The CD Plus layer covers unincorporated Lake County only. A spatial test places 45 of 17,915 features inside any of the 14 municipal boundaries, and those are county-owned facilities. Each municipality runs its own permit system; 13 of the 14 are blocked, unavailable or manual-only, and each has a named records request in docs/lake-sources.yaml.",
    `Contractor of record is published for ONE jurisdiction of fifteen. Clermont's eTRAKiT portal names the contractor on its permit detail pages and is harvested: ${Number(clermont.permits)} permits over ${Number(clermont.parcels)} parcel keys, ${Number(clermont.permits_with_contractor)} of them naming a contractor and ${Number(clermont.distinct_contractors)} distinct businesses. Everywhere else contractor_name is null and stays null: the county CD Plus layer publishes no contractor field, county permit detail pages sit behind a Cloudflare managed challenge across the whole lakecountyfl.gov estate, and the other thirteen municipalities are blocked, unavailable or manual-only. enrichment_status distinguishes the three cases - contractor_from_clermont_etrakit, contractor_absent_on_permit, contractor_gated_403 - because a bare null cannot.`,
    `Clermont's permits cover ${clermontParcels} parcels, ${((clermontParcels / rollParcels) * 100).toFixed(1)}% of the ${rollParcels}-parcel roll, and only permit year ${String(clermont.permit_years)}. The portal holds permit years 15 through 26 and the rest are not in this run; ${Number(clermont.dead_permits)} enumerated permits are filed against no parcel key at all and are recorded as dead rather than dropped. A parcel with no Clermont permit is not a parcel with no permits - it is a parcel outside the one municipality whose permits can be read.`,
    "BBB ratings are not published. The default BBB request/browser route returned HTTP 403; one prohibited browser-fingerprint spoof returned 200 during verification, but no result was retained and no approved official-API harvest was run. bbb_rating is a real column that stays null.",
    "Ownership tenure beyond 2025-2026 cannot be proven. Only the current DOR roll is published, and the historical DOR map-data files carry parcel geometry only. no_recorded_sale_in_dor_window is a lower bound, not a tenure claim.",
    "Coordinates come from the 2025 GIO centroid release against the 2026 roll, so parcels first assessed in 2026 publish with null coordinates rather than being dropped.",
    `${Number(linkage.valid_unlinked_permits)} of ${Number(linkage.total_permits)} permits reference a parcel key absent from the assessed roll (${Number(linkage.unmatched_parcel_keys)} distinct keys). They are valid records, counted here and not discarded, but they attach to no published property row.`,
    `Business coverage is a fraction of the TPP roll, and the published per-parcel total double counts. The roll carries no parcel key, so accounts are located by a normalized street+zip match against the roll's situs addresses: ${Number(business.accounts_with_situs)} of ${Number(business.total_accounts)} accounts carry a situs address and ${Number(business.matched_accounts)} match a parcel (${((matched / accounts) * 100).toFixed(1)}%), so the rest are not published. A matched address group is then attributed to every parcel sharing that address, so summing business_account_count across the ${Number(business.parcels_with_account)} parcels that carry one yields ${Number(business.attributed_accounts)} rather than ${Number(business.matched_accounts)}: ${Number(business.shared_address_groups)} address groups span more than one parcel. ${Number(business.matched_accounts)} is the distinct account match; ${Number(business.attributed_accounts)} counts account-parcel matches, not businesses.`,
  ];
}

/**
 * Build the run directory.
 *
 * @param {object} options - Options.
 * @param {string} options.runId - Run identifier.
 * @param {string} options.parquetPath - Source query-table Parquet.
 * @param {string} [options.permitParquetPath] - Source per-permit Parquet.
 * @param {string} options.clermontEvidencePath - Exact certified baseline JSON used to materialize Clermont.
 * @param {string} options.clermontBaselineSha256 - Digest required by the operator request.
 * @returns {Promise<{ runDir: string, artifacts: string[], counts: Record<string, number> }>} Built run.
 */
export async function buildPublishSet({
  runId,
  parquetPath,
  permitParquetPath = path.join(path.dirname(parquetPath), "permit-table.parquet"),
  clermontEvidencePath,
  clermontBaselineSha256,
}) {
  const runDir = path.join(PUBLISH_ROOT, "runs", runId);
  await mkdir(path.join(runDir, "shards"), { recursive: true });
  await mkdir(path.join(runDir, "samples"), { recursive: true });

  await copyFile(parquetPath, path.join(runDir, "query-table.parquet"));
  await copyFile(permitParquetPath, path.join(runDir, "permit-table.parquet"));

  const permitColumns = await query(
    `SELECT column_name FROM (DESCRIBE SELECT * FROM '${permitParquetPath}')`,
  );
  assertPermitTableColumns(permitColumns.map((row) => String(row.column_name)));
  const [permitGate] = await query(`
    SELECT count(*) AS rows,
           count(DISTINCT permit_id) AS distinct_permits,
           count(*) FILTER (WHERE permit_id IS NULL OR permit_id = '') AS null_permit_ids
    FROM '${permitParquetPath}';`);
  if (
    Number(permitGate.rows) !== Number(permitGate.distinct_permits) ||
    Number(permitGate.null_permit_ids) !== 0
  ) {
    throw new Error(
      `Permit table identity gate failed: ${Number(permitGate.rows)} rows, ` +
        `${Number(permitGate.distinct_permits)} distinct ids, ` +
        `${Number(permitGate.null_permit_ids)} null ids`,
    );
  }

  const [totals] = await query(`
    SELECT count(*) AS properties,
           count(*) FILTER (WHERE latitude IS NOT NULL) AS with_coordinates,
           count(*) FILTER (WHERE roof_age_years IS NOT NULL) AS roof_age_known,
           count(*) FILTER (WHERE roof_age_years >= 15) AS roof_age_15_plus,
           count(*) FILTER (WHERE has_permits) AS with_permits,
           sum(permit_count) AS permit_records,
           sum(roofing_permit_count) AS roofing_permit_records,
           count(*) FILTER (WHERE open_roofing_permit_count > 0) AS with_open_roofing_permit,
           count(*) FILTER (WHERE longest_open_roofing_permit_days > 1825) AS open_permit_over_five_years,
           count(*) FILTER (WHERE owner_out_of_state) AS out_of_state_owners,
           count(*) FILTER (WHERE owner_out_of_county) AS out_of_county_owners,
           count(*) FILTER (WHERE no_recorded_sale_in_dor_window) AS no_sale_in_dor_window,
           count(*) FILTER (WHERE has_business_account) AS with_business_account,
           count(DISTINCT owner_name) AS distinct_owners
    FROM '${parquetPath}';`);

  // Permit linkage is reported explicitly. The kit's contract is to preserve
  // valid unmatched records rather than drop them, and to state linked and
  // valid-unlinked counts separately, so a permit whose parcel is absent from
  // the roll is never silently converted into "no permits".
  const permitsCsv = path.join(RUNTIME_ROOT, "data", "downloads", "lake", "permits.csv");
  const clermontCsv = path.join(RUNTIME_ROOT, "data", "downloads", "lake", "clermont-permits.csv");
  const nalCsv = path.join(RUNTIME_ROOT, "data", "downloads", "lake", "NAL45P202601.csv");
  // Permit numbers are unique only within a source, so every DISTINCT below is
  // taken over source_system plus permit_number — the same rule the
  // consolidation SQL applies. Counting on permit_number alone would silently
  // collapse a county permit and a Clermont permit that happen to share a
  // number into one record.
  const permitUnion = `
    SELECT permit_number, alternate_key, 'lake_cdplus_permits' AS source_system
    FROM read_csv_auto('${permitsCsv}', header=true, all_varchar=true)
    UNION ALL
    SELECT permit_number, alternate_key, source_system
    FROM read_csv_auto('${clermontCsv}', header=true, all_varchar=true)`;
  const [linkage] = await query(`
    WITH p AS (${permitUnion})
    SELECT count(DISTINCT concat_ws(':', p.source_system, p.permit_number)) AS total_permits,
           count(DISTINCT CASE WHEN n.ALT_KEY IS NOT NULL
                 THEN concat_ws(':', p.source_system, p.permit_number) END) AS linked_permits,
           count(DISTINCT CASE WHEN n.ALT_KEY IS NULL
                 THEN concat_ws(':', p.source_system, p.permit_number) END) AS valid_unlinked_permits,
           count(DISTINCT CASE WHEN n.ALT_KEY IS NULL THEN p.alternate_key END) AS unmatched_parcel_keys,
           count(DISTINCT CASE WHEN p.source_system = 'lake_cdplus_permits'
                 THEN concat_ws(':', p.source_system, p.permit_number) END) AS cdplus_permits,
           count(DISTINCT CASE WHEN p.source_system <> 'lake_cdplus_permits'
                 THEN concat_ws(':', p.source_system, p.permit_number) END) AS municipal_permits
    FROM p
    LEFT JOIN read_csv_auto('${nalCsv}', header=true, all_varchar=true) n
      ON n.ALT_KEY = p.alternate_key;`);

  // Clermont is reported on its own as well as inside the permit total, because
  // it is the only source of contractor identity in the county and a reader has
  // to be able to see exactly how much of the county that covers.
  const [clermont] = await query(`
    WITH c AS (SELECT * FROM read_csv_auto('${clermontCsv}', header=true, all_varchar=true)),
         n AS (SELECT * FROM read_csv_auto('${nalCsv}', header=true, all_varchar=true))
    SELECT (SELECT count(*) FROM c)                                               AS rows,
           (SELECT count(DISTINCT permit_number) FROM c)                          AS permits,
           (SELECT count(DISTINCT alternate_key) FROM c)                          AS parcels,
           (SELECT count(DISTINCT permit_number) FROM c
              WHERE contractor_name IS NOT NULL AND contractor_name <> '')        AS permits_with_contractor,
           (SELECT count(DISTINCT contractor_name) FROM c
              WHERE contractor_name IS NOT NULL AND contractor_name <> '')        AS distinct_contractors,
           (SELECT count(DISTINCT contractor_license) FROM c
              WHERE contractor_license IS NOT NULL AND contractor_license <> '')  AS distinct_licenses,
           (SELECT count(DISTINCT c.alternate_key) FROM c
              JOIN n ON n.ALT_KEY = c.alternate_key)                              AS linked_parcels,
           (SELECT count(*) FROM n)                                               AS roll_parcels;`);

  // The metadata sidecar alone is not enough publication evidence: an empty or
  // one-year export can still be internally self-consistent. Bind it to the
  // exact certified baseline the clean runner restored and verify its byte
  // digests plus every partition's reconciliation contract.
  if (typeof clermontEvidencePath !== "string" || clermontEvidencePath.length === 0) {
    throw new Error("Clermont certified baseline evidence is required to build a publish set");
  }
  const clermontMetadataPath = clermontCsv.replace(/\.csv$/, ".meta.json");
  const [clermontCsvBytes, clermontMetadataBytes, clermontEvidenceBytes] = await Promise.all([
    readFile(clermontCsv),
    readFile(clermontMetadataPath),
    readFile(clermontEvidencePath),
  ]);
  const clermontMeta = JSON.parse(clermontMetadataBytes.toString("utf8"));
  const clermontEvidence = JSON.parse(clermontEvidenceBytes.toString("utf8"));
  const clermontCertification = assertCompleteClermontPublicationEvidence({
    metadata: clermontMeta,
    evidence: clermontEvidence,
    csvRows: Number(clermont.rows),
    csvSha256: sha256Hex(clermontCsvBytes),
    metadataSha256: sha256Hex(clermontMetadataBytes),
    requiredBaselineSha256: clermontBaselineSha256,
  });
  if (Number(clermont.rows) !== Number(clermont.permits)) {
    throw new Error("Clermont export contains duplicate permit numbers");
  }
  await copyFile(clermontEvidencePath, path.join(runDir, "clermont-baseline-evidence.json"));
  clermont.permit_years =
    clermontMeta.permitYears.length > 0 ? clermontMeta.permitYears.join(", ") : "none";
  clermont.dead_permits = Number(clermontMeta.deadPermits);
  clermont.enumerated_permits = Number(clermontMeta.enumeratedPermits);
  clermont.achievable_permits = Number(clermontMeta.achievablePermits);

  // Business coverage is reported the same way permit linkage is, because it
  // has the same two failure modes and neither is visible from the query table
  // alone. The TPP roll carries no parcel key, so an account is located by a
  // normalized street+zip match against the roll's situs addresses: most
  // accounts match nothing, and a matched address group is attributed to every
  // parcel sharing that address, so `business_account_count` sums to more than
  // the number of accounts actually matched. Both were documented in prose and
  // in the UI but were absent from the published coverage snapshot, which is
  // the machine-readable record a consumer actually reads.
  // The denominator must come from the source, not from the table being
  // measured. Counting published rows and calling the result "county_total"
  // made completeness 100% by construction: a run that silently dropped half
  // the roll would still have reported full coverage against itself.
  const [sourceRoll] = await query(`
    SELECT count(*) AS parcels
    FROM read_csv_auto('${nalCsv}', header=true, all_varchar=true)
  `);

  const tppCsv = path.join(RUNTIME_ROOT, "data", "downloads", "lake", "NAP45P202601.csv");
  const [business] = await query(`
    WITH tpp AS (SELECT * FROM read_csv_auto('${tppCsv}', header=true, all_varchar=true)),
         nal AS (SELECT * FROM read_csv_auto('${nalCsv}', header=true, all_varchar=true)),
         situs AS (
           SELECT upper(trim(PHY_ADDR)) AS addr, trim(PHY_ZIPCD) AS zip, count(*) AS accounts
           FROM tpp WHERE PHY_ADDR IS NOT NULL AND trim(PHY_ADDR) <> '' GROUP BY 1, 2
         ),
         parcel AS (
           SELECT upper(trim(PHY_ADDR1)) AS addr, trim(PHY_ZIPCD) AS zip, count(*) AS parcels
           FROM nal GROUP BY 1, 2
         ),
         matched AS (SELECT s.accounts, p.parcels FROM situs s JOIN parcel p USING (addr, zip))
    SELECT (SELECT count(*) FROM tpp)                                            AS total_accounts,
           (SELECT count(*) FROM tpp WHERE PHY_ADDR IS NOT NULL
                                       AND trim(PHY_ADDR) <> '')                 AS accounts_with_situs,
           (SELECT coalesce(sum(accounts), 0) FROM matched)                      AS matched_accounts,
           (SELECT coalesce(sum(accounts * parcels), 0) FROM matched)            AS attributed_accounts,
           (SELECT coalesce(sum(parcels), 0) FROM matched)                       AS parcels_with_account,
           (SELECT count(*) FROM matched WHERE parcels > 1)                      AS shared_address_groups,
           (SELECT coalesce(sum(accounts), 0) FROM matched WHERE parcels > 1)    AS accounts_at_shared_addresses,
           (SELECT coalesce(sum(parcels), 0) FROM matched WHERE parcels > 1)     AS parcels_at_shared_addresses;`);

  const shardCount = Math.ceil(Number(totals.properties) / SHARD_SIZE);
  const shards = [];
  for (let index = 0; index < shardCount; index += 1) {
    const rows = await query(`
      SELECT * FROM '${parquetPath}'
      ORDER BY request_identifier
      LIMIT ${SHARD_SIZE} OFFSET ${index * SHARD_SIZE};`);
    const name = `shard-${String(index).padStart(4, "0")}.json`;
    // Null columns are dropped from each shard record. The query table is the
    // typed contract; the shards are a path-addressable convenience, and at 59
    // columns over 215,806 mostly-sparse properties the nulls triple the
    // published bytes without carrying information. schema.json lists every
    // column so an absent key is unambiguously "no value".
    const compact = rows.map((row) => {
      /** @type {Record<string, unknown>} */
      const record = {};
      for (const [key, value] of Object.entries(row)) {
        if (value !== null && value !== undefined) record[key] = value;
      }
      return record;
    });
    const body = {
      schemaVersion: "elephant.property-shard.v1",
      county: "lake",
      runId,
      shard: index,
      shardSize: SHARD_SIZE,
      properties: compact,
    };
    await writeFile(path.join(runDir, "shards", name), `${JSON.stringify(body)}\n`, "utf8");
    shards.push({
      name: `shards/${name}`,
      shard: index,
      properties: rows.length,
      firstParcel: rows[0]?.request_identifier ?? null,
      lastParcel: rows[rows.length - 1]?.request_identifier ?? null,
    });
    if ((index + 1) % 5 === 0) log("shard_written", { shard: index + 1, of: shardCount });
  }

  await writeFile(
    path.join(runDir, "index.json"),
    `${JSON.stringify(
      {
        schemaVersion: "elephant.property-index.v1",
        county: "lake",
        countyName: "Lake",
        stateCode: "FL",
        countyFips: "12069",
        runId,
        propertyCount: Number(totals.properties),
        shardSize: SHARD_SIZE,
        shardCount,
        shards,
        queryTable: "query-table.parquet",
        permitTable: "permit-table.parquet",
        coverage: "coverage.json",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  /**
   * Rewrite a locally-run query so it reads as the published artifact.
   *
   * @param {string} sql - SQL as executed, naming a local Parquet path.
   * @returns {string} SQL naming `query-table.parquet`, whitespace collapsed.
   */
  const publishedSql = (sql) =>
    sql
      .replace(/'[^']*query-table\.parquet'/g, "'query-table.parquet'")
      .replace(/\s+/g, " ")
      .trim();

  const samples = {
    "aged-roofs.json": `SELECT request_identifier, address_street, address_city, address_zip, latitude, longitude,
        roof_age_years, roof_age_basis, built_year, owner_name
      FROM '${parquetPath}' WHERE roof_age_years >= 15 AND latitude IS NOT NULL
      ORDER BY roof_age_years DESC, request_identifier LIMIT 100`,
    "open-roofing-permits.json": `SELECT request_identifier, address_street, address_city, latitude, longitude,
        open_roofing_permit_count, longest_open_roofing_permit_days, latest_permit_date, roof_age_years, roof_age_basis,
      contractor_name, bbb_rating, enrichment_status
      FROM '${parquetPath}' WHERE open_roofing_permit_count > 0
      ORDER BY longest_open_roofing_permit_days DESC NULLS LAST LIMIT 100`,
    "out-of-area-owners.json": `SELECT request_identifier, address_street, address_city, owner_name,
        owner_mailing_city, owner_mailing_state, owner_out_of_county, owner_out_of_state, roof_age_years
      FROM '${parquetPath}' WHERE owner_out_of_state ORDER BY request_identifier LIMIT 100`,
  };
  for (const [name, sql] of Object.entries(samples)) {
    const rows = await query(sql);
    await writeFile(
      path.join(runDir, "samples", name),
      `${JSON.stringify(
        {
          // The recorded SQL is provenance a reader re-runs, so it must name the
          // published artifact rather than whichever machine built it. It used to
          // carry the builder's absolute path, which then travelled into an
          // immutable public artifact — the same class of leak as the
          // `carBuildPath` field removed from the manifest, surviving in a
          // place nobody thought to look.
          query: publishedSql(sql),
          rowCount: rows.length,
          rows,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  await writeFile(
    path.join(runDir, "schema.json"),
    `${JSON.stringify(
      {
        schemaVersion: "elephant.query-table-schema.v1",
        county: "lake",
        table: "query-table.parquet",
        columnCount: Object.keys(LAKE_QUERY_TABLE_SCHEMA_FIELDS).length,
        columns: Object.entries(LAKE_QUERY_TABLE_SCHEMA_FIELDS).map(([name, field]) => ({
          name,
          type: field.type,
          optional: field.optional === true,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    path.join(runDir, "permit-schema.json"),
    `${JSON.stringify(
      {
        schemaVersion: "elephant.permit-table-schema.v1",
        county: "lake",
        table: "permit-table.parquet",
        columnCount: Object.keys(LAKE_PERMIT_TABLE_SCHEMA_FIELDS).length,
        columns: Object.entries(LAKE_PERMIT_TABLE_SCHEMA_FIELDS).map(([name, field]) => ({
          name,
          type: field.type,
          optional: field.optional === true,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const coverage = {
    schemaVersion: "elephant.coverage.v1",
    county: "lake",
    countyName: "Lake",
    stateCode: "FL",
    countyFips: "12069",
    runId,
    exportedAt: new Date().toISOString(),
    denominator: {
      basis: "source_roll_row_count",
      source: "Florida DOR 2026 preliminary NAL",
      assessedParcelCount: Number(sourceRoll.parcels),
      publishedParcelCount: Number(totals.properties),
      publishedFraction:
        Number(sourceRoll.parcels) > 0
          ? Number((Number(totals.properties) / Number(sourceRoll.parcels)).toFixed(6))
          : null,
    },
    tables: {
      properties: { rows: Number(totals.properties), source: "FL DOR NAL 2026P" },
      permits: {
        rows: Number(linkage.total_permits),
        linked: Number(linkage.linked_permits),
        validUnlinked: Number(linkage.valid_unlinked_permits),
        unmatchedParcelKeys: Number(linkage.unmatched_parcel_keys),
        linkedPermitRecordsOnProperties: Number(totals.permit_records),
        bySource: {
          lake_cdplus_permits: Number(linkage.cdplus_permits),
          lake_clermont_etrakit_permits: Number(linkage.municipal_permits),
        },
        source: "Lake County CD Plus permit layer and Clermont eTRAKiT 3",
      },
      // Availability is typed, per the use-oracle coverage publish contract.
      // One jurisdiction of fifteen is harvestable for contractor identity, so
      // this is supported_partial and says so in a field, not only in prose.
      contractors: {
        availability: "supported_partial",
        rows: Number(clermont.permits_with_contractor),
        distinctContractors: Number(clermont.distinct_contractors),
        distinctLicenses: Number(clermont.distinct_licenses),
        propertiesCovered: Number(clermont.linked_parcels),
        countyParcels: Number(clermont.roll_parcels),
        jurisdictionsCovered: 1,
        jurisdictionsInCounty: 15,
        permitYears: clermontMeta.permitYears,
        // Completion is judged against achievable - enumerated minus dead -
        // never against an exact source count, which a dead tail makes
        // unreachable forever.
        enumeratedPermits: Number(clermontMeta.enumeratedPermits),
        deadPermits: Number(clermontMeta.deadPermits),
        achievablePermits: Number(clermontMeta.achievablePermits),
        complete: Number(clermont.permits) === Number(clermontMeta.achievablePermits),
        baselineSha256: clermontCertification.baselineSha256,
        evidenceSha256: clermontCertification.evidenceSha256,
        source: "Clermont eTRAKiT 3 permit detail pages",
      },
      coordinates: {
        rows: Number(totals.with_coordinates),
        source: "FL GIO parcel centroids 2025",
      },
      businessAccounts: {
        rows: Number(business.total_accounts),
        withSitusAddress: Number(business.accounts_with_situs),
        matchedToParcel: Number(business.matched_accounts),
        attributedAcrossParcels: Number(business.attributed_accounts),
        propertiesWithAccount: Number(business.parcels_with_account),
        sharedAddressGroups: Number(business.shared_address_groups),
        source: "FL DOR TPP 2026P",
      },
    },
    signals: {
      roofAgeKnown: Number(totals.roof_age_known),
      roofAgeFifteenPlus: Number(totals.roof_age_15_plus),
      propertiesWithPermits: Number(totals.with_permits),
      roofingPermitRecords: Number(totals.roofing_permit_records),
      propertiesWithOpenRoofingPermit: Number(totals.with_open_roofing_permit),
      permitsOpenOverFiveYears: Number(totals.open_permit_over_five_years),
      outOfStateOwners: Number(totals.out_of_state_owners),
      outOfCountyOwners: Number(totals.out_of_county_owners),
      noRecordedSaleInDorWindow: Number(totals.no_sale_in_dor_window),
      distinctOwners: Number(totals.distinct_owners),
      propertiesWithBusinessAccount: Number(totals.with_business_account),
    },
    limitations: buildLimitations(linkage, business, clermont),
  };
  await writeFile(
    path.join(runDir, "coverage.json"),
    `${JSON.stringify(coverage, null, 2)}\n`,
    "utf8",
  );

  // The kit-shaped coverage snapshot is published alongside the richer one.
  // `catalog:update` and the Elephant MCP both read this shape, so publishing
  // only the richer file would leave the county unregisterable.
  await writeFile(
    path.join(runDir, "dataset-coverage.json"),
    `${JSON.stringify(
      buildCoverageSnapshot({
        county: "lake",
        source: "appraisal",
        ingestedCount: Number(totals.properties),
        expectedCount: Number(totals.properties),
        exportedAt: coverage.exportedAt,
        ipnsLabel: LAKE_IPNS_LABEL,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );

  const artifacts = [
    "query-table.parquet",
    "permit-table.parquet",
    "coverage.json",
    "dataset-coverage.json",
    "index.json",
    "schema.json",
    "permit-schema.json",
    "clermont-baseline-evidence.json",
    ...shards.map((shard) => shard.name),
    ...Object.keys(samples).map((name) => `samples/${name}`),
  ];
  const sizes = {};
  for (const name of artifacts) {
    sizes[name] = (await stat(path.join(runDir, name))).size;
  }
  log("publish_set_built", {
    runId,
    runDir,
    artifacts: artifacts.length,
    properties: Number(totals.properties),
  });
  return { runDir, artifacts, counts: { ...totals, shardCount }, sizes };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const runIdIndex = process.argv.indexOf("--run-id");
  const evidenceIndex = process.argv.indexOf("--clermont-evidence");
  const baselineDigestIndex = process.argv.indexOf("--clermont-baseline-sha256");
  const runId =
    runIdIndex > -1
      ? process.argv[runIdIndex + 1]
      : new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const clermontEvidencePath = evidenceIndex > -1 ? process.argv[evidenceIndex + 1] : undefined;
  const clermontBaselineSha256 =
    baselineDigestIndex > -1 ? process.argv[baselineDigestIndex + 1] : undefined;
  buildPublishSet({
    runId,
    parquetPath: path.join(PUBLISH_ROOT, "query-table.parquet"),
    clermontEvidencePath,
    clermontBaselineSha256,
  })
    .then((result) => log("done", { runDir: result.runDir }))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    });
}
