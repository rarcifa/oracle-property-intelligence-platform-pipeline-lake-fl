/**
 * High-level queries, each one a thin wrapper that pairs a shared SQL builder
 * with the provenance the answer must carry.
 *
 * Nothing in this file hardcodes a figure. Every number the API, the MCP tools
 * and the chat agent report comes back from one of these calls, which is what
 * makes "show real counts" enforceable rather than aspirational.
 */

import {
  buildCityCentroidSql,
  boundStatement,
  BUSINESS_VIEW_NOTE,
  buildBusinessByCitySql,
  buildBusinessByTypeSql,
  buildCountSql,
  buildDatasetStatsSql,
  buildFacetSql,
  buildOwnerPostureSql,
  buildPermitPostureSql,
  buildPropertyPermitsSql,
  buildPropertyDetailSql,
  buildRoofAgeBandsSql,
  buildSearchSql,
  clampLimit,
  gatedFieldNotices,
  parseSourceSystems,
  PERMITS_VIEW,
  PROPERTIES_VIEW,
  QUERY_TABLE_COLUMNS,
  type ResponseProvenance,
  type PermitRow,
  type SearchOptions,
} from "@oracle-lake/shared";
import type { OracleDataStore, QueryRow } from "./duckdb.js";
import type { RunIdentity } from "./run.js";

/** Everything a response needs to explain where its numbers came from. */
export interface ProvenanceContext extends RunIdentity {
  dataSource: string;
  dataSourceKind: "ipfs" | "local";
}

const COLUMN_SOURCES = new Map(QUERY_TABLE_COLUMNS.map((column) => [column.name, column.source]));

/**
 * Name the upstream systems behind a result set.
 *
 * Prefers the rows' own `source_systems` column, because that records what
 * actually contributed to those specific parcels. Falls back to the declared
 * source of each projected column when the projection is an aggregate.
 */
export function deriveSourceSystems(rows: readonly QueryRow[]): string[] {
  const tokens = new Set<string>();
  let sawColumn = false;
  for (const row of rows) {
    const value = row.source_systems;
    if (typeof value === "string") {
      sawColumn = true;
      for (const entry of parseSourceSystems(value)) tokens.add(entry.label);
    }
  }
  if (sawColumn) return [...tokens].sort();

  const firstRow = rows[0];
  if (firstRow) {
    for (const key of Object.keys(firstRow)) {
      const source = COLUMN_SOURCES.get(key);
      if (source) tokens.add(source);
    }
  }
  if (tokens.size === 0) {
    for (const column of QUERY_TABLE_COLUMNS) tokens.add(column.source);
  }
  return [...tokens].sort();
}

function provenance(
  context: ProvenanceContext,
  sql: string,
  rows: readonly QueryRow[],
): ResponseProvenance {
  return {
    sql,
    dataSource: context.dataSource,
    dataSourceKind: context.dataSourceKind,
    sourceSystems: deriveSourceSystems(rows),
    runId: context.runId,
    rootCid: context.rootCid,
  };
}

export interface SearchResult {
  rows: QueryRow[];
  matched: number;
  limit: number;
  offset: number;
  provenance: ResponseProvenance;
}

/** Filtered property search plus the matching-row total for the same filters. */
export async function searchProperties(
  store: OracleDataStore,
  context: ProvenanceContext,
  options: SearchOptions,
): Promise<SearchResult> {
  const sql = buildSearchSql(PROPERTIES_VIEW, options);
  const countSql = buildCountSql(PROPERTIES_VIEW, options);
  const [rows, countRow] = await Promise.all([store.query(sql), store.queryOne(countSql)]);
  return {
    rows,
    matched: Number(countRow?.matched ?? 0),
    limit: clampLimit(options.limit),
    offset: Math.max(0, Math.floor(options.offset ?? 0)),
    provenance: provenance(context, sql, rows),
  };
}

export interface PropertyDetail {
  property: QueryRow;
  permits: PermitRow[];
  permitsAvailable: boolean;
  sources: { token: string; label: string }[];
  gating: ReturnType<typeof gatedFieldNotices>;
  provenance: ResponseProvenance;
}

/** One parcel, with its provenance and the reasons its null columns are null. */
export async function getProperty(
  store: OracleDataStore,
  context: ProvenanceContext,
  parcelId: string,
): Promise<PropertyDetail | null> {
  const sql = buildPropertyDetailSql(PROPERTIES_VIEW, parcelId);
  const permitSql = buildPropertyPermitsSql(PERMITS_VIEW, parcelId);
  const [row, permits] = await Promise.all([
    store.queryOne(sql),
    store.query(permitSql) as unknown as Promise<PermitRow[]>,
  ]);
  if (row === null) return null;
  const status = typeof row.enrichment_status === "string" ? row.enrichment_status : null;
  return {
    property: row,
    permits,
    permitsAvailable: store.permitsAvailable,
    sources: parseSourceSystems(typeof row.source_systems === "string" ? row.source_systems : null),
    gating: gatedFieldNotices(status),
    provenance: provenance(context, `${sql};\n\n${permitSql}`, [row]),
  };
}

/** Full permit-grain records for one parcel. */
export async function getPropertyPermits(
  store: OracleDataStore,
  context: ProvenanceContext,
  parcelId: string,
  limit = 200,
): Promise<{
  parcelId: string;
  permits: PermitRow[];
  permitsAvailable: boolean;
  provenance: ResponseProvenance;
}> {
  const sql = buildPropertyPermitsSql(PERMITS_VIEW, parcelId, limit);
  const permits = (await store.query(sql)) as unknown as PermitRow[];
  const sourceSystems = [
    ...new Set(
      permits.flatMap((permit) =>
        typeof permit.source_system === "string" ? [permit.source_system] : [],
      ),
    ),
  ];
  return {
    parcelId,
    permits,
    permitsAvailable: store.permitsAvailable,
    provenance: {
      sql,
      dataSource: store.activePermitSource ?? context.dataSource,
      dataSourceKind: context.dataSourceKind,
      sourceSystems,
      runId: context.runId,
      rootCid: context.rootCid,
    },
  };
}

export interface DatasetStats {
  stats: Record<string, number>;
  roofAgeBands: QueryRow[];
  provenance: ResponseProvenance;
}

/**
 * Keep the numeric columns of an aggregate row, and drop the rest.
 *
 * Non-numeric values used to be coerced with `Number(value ?? 0)` and floored to
 * 0 when that produced NaN. `max(latest_permit_date)` is a date string, so the
 * contractor view published `latest_permit_date: 0` — a number nothing measured,
 * sitting beside real counts with no way to tell them apart. A design fixture
 * had the 0 baked in as expected, so the suite passed because of the bug.
 *
 * Dropping is the honest failure: a caller reading a missing key knows it is
 * missing, where a caller reading 0 does not.
 */
function toNumberRecord(row: QueryRow | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (row === null) return out;
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
      continue;
    }
    if (typeof value === "bigint") {
      out[key] = Number(value);
      continue;
    }
    // A numeric string still counts; a date string does not.
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      out[key] = Number(value);
    }
  }
  return out;
}

/** Headline dataset counts plus the roof-age band histogram. */
export async function getDatasetStats(
  store: OracleDataStore,
  context: ProvenanceContext,
): Promise<DatasetStats> {
  const statsSql = buildDatasetStatsSql(PROPERTIES_VIEW);
  const bandsSql = buildRoofAgeBandsSql(PROPERTIES_VIEW);
  const [statsRow, bands] = await Promise.all([store.queryOne(statsSql), store.query(bandsSql)]);
  return {
    stats: toNumberRecord(statsRow),
    roofAgeBands: bands,
    provenance: provenance(context, `${statsSql};\n\n${bandsSql}`, []),
  };
}

/** Facet lists for the search filter rail. */
export async function getFacets(store: OracleDataStore): Promise<{
  cities: QueryRow[];
  propertyTypes: QueryRow[];
  roofAgeBasis: QueryRow[];
  zips: QueryRow[];
}> {
  const [cities, propertyTypes, roofAgeBasis, zips] = await Promise.all([
    store.query(buildFacetSql(PROPERTIES_VIEW, "address_city", 100)),
    store.query(buildFacetSql(PROPERTIES_VIEW, "property_type", 50)),
    store.query(buildFacetSql(PROPERTIES_VIEW, "roof_age_basis", 10)),
    store.query(buildFacetSql(PROPERTIES_VIEW, "address_zip", 100)),
  ]);
  return { cities, propertyTypes, roofAgeBasis, zips };
}

/** Tenant view: owner locality and tenure posture. */
export async function getTenantView(
  store: OracleDataStore,
  context: ProvenanceContext,
): Promise<{
  ownerPosture: Record<string, number>;
  roofAgeBands: QueryRow[];
  topOutOfStateOwners: QueryRow[];
  provenance: ResponseProvenance;
}> {
  const postureSql = buildOwnerPostureSql(PROPERTIES_VIEW);
  const bandsSql = buildRoofAgeBandsSql(PROPERTIES_VIEW);
  const statesSql = `SELECT owner_mailing_state, count(*) AS properties FROM ${PROPERTIES_VIEW}
WHERE owner_out_of_state AND owner_mailing_state IS NOT NULL
GROUP BY 1 ORDER BY properties DESC LIMIT 15`;
  const [posture, roofAgeBands, topOutOfStateOwners] = await Promise.all([
    store.queryOne(postureSql),
    store.query(bandsSql),
    store.query(statesSql),
  ]);
  return {
    ownerPosture: toNumberRecord(posture),
    roofAgeBands,
    topOutOfStateOwners,
    provenance: provenance(context, `${postureSql};\n\n${bandsSql};\n\n${statesSql}`, []),
  };
}

/** Business view: the DOR TPP tangible-personal-property account signal. */
export async function getBusinessView(
  store: OracleDataStore,
  context: ProvenanceContext,
): Promise<{
  totals: Record<string, number>;
  byCity: QueryRow[];
  byType: QueryRow[];
  provenance: ResponseProvenance;
  note: string;
}> {
  const totalsSql = `SELECT
  count(*) FILTER (WHERE coalesce(business_account_count, 0) > 0) AS properties_with_accounts,
  sum(coalesce(business_account_count, 0)) AS business_accounts,
  max(coalesce(business_account_count, 0)) AS max_accounts_at_one_property,
  count(*) FILTER (WHERE coalesce(has_sunbiz_tenant, FALSE)) AS sunbiz_tenants,
  count(*) AS properties
FROM ${PROPERTIES_VIEW}`;
  const byCitySql = buildBusinessByCitySql(PROPERTIES_VIEW, 40);
  const byTypeSql = buildBusinessByTypeSql(PROPERTIES_VIEW);
  const [totals, byCity, byType] = await Promise.all([
    store.queryOne(totalsSql),
    store.query(byCitySql),
    store.query(byTypeSql),
  ]);
  return {
    totals: toNumberRecord(totals),
    byCity,
    byType,
    provenance: provenance(context, `${totalsSql};\n\n${byCitySql};\n\n${byTypeSql}`, []),
    note: BUSINESS_VIEW_NOTE,
  };
}

/** Contractor view: permit posture, and the reasons contractor identity is absent. */
export async function getContractorView(
  store: OracleDataStore,
  context: ProvenanceContext,
): Promise<{
  posture: Record<string, number>;
  gating: ReturnType<typeof gatedFieldNotices>;
  provenance: ResponseProvenance;
  note: string;
}> {
  const sql = buildPermitPostureSql(PROPERTIES_VIEW);
  const posture = await store.queryOne(sql);
  return {
    posture: toNumberRecord(posture),
    // A county-level view has no row to read an enrichment_status off, so it
    // asks for the notices of the majority case explicitly. bbb_rating is
    // gated on every row. contractor_name is gated on every parcel outside
    // Clermont, whose rows carry contractor_from_clermont_etrakit or
    // contractor_absent_on_permit instead - which is why the tile beside these
    // notices states the jurisdiction boundary and counts the column live
    // rather than letting the notices imply a countywide zero.
    gating: gatedFieldNotices("permits_loaded;contractor_gated_403;bbb_gated_403"),
    provenance: provenance(context, sql, []),
    note: "Permit signals combine the Lake County CD Plus layer, joined to the DOR roll on Alternate_Key, with the harvested Clermont eTRAKiT records. CD Plus publishes a rolling 365-day Permit_LastModDate window for unincorporated Lake County; Clermont is the only municipality with harvested contractor detail in this run.",
  };
}

/** Execute a caller-supplied read-only statement against the `properties` view. */
export async function runReadOnlySql(
  store: OracleDataStore,
  context: ProvenanceContext,
  sql: string,
  limit: number,
): Promise<{
  rows: QueryRow[];
  rowCount: number;
  truncated: boolean;
  sql: string;
  provenance: ResponseProvenance;
}> {
  // Bound the work, not just the answer: the cap used to be applied here, after
  // DuckDB had already produced every row.
  const rows = await store.query(boundStatement(sql, limit));
  const capped = rows.slice(0, limit);
  return {
    rows: capped,
    // Rows returned, not rows the statement could have produced. Knowing the
    // latter means running the whole statement, which is precisely what the
    // bound exists to prevent; `count(*)` answers that question cheaply and
    // honestly. `truncated` says when there was more.
    rowCount: capped.length,
    truncated: rows.length > capped.length,
    sql,
    provenance: provenance(context, sql, capped),
  };
}

/**
 * The published centre of a city, for radius search.
 *
 * Deterministic on purpose: the agent used to supply its own coordinate for a
 * place name and produced a slightly different one per call, so the same radius
 * question returned different totals. This derives the centre from the same
 * table the answer is computed over.
 */
export async function getCityCentre(
  store: OracleDataStore,
  context: ProvenanceContext,
  city: string,
): Promise<{
  city: string;
  lat: number | null;
  lon: number | null;
  parcelsWithCoordinates: number;
  provenance: ResponseProvenance;
}> {
  const sql = buildCityCentroidSql(PROPERTIES_VIEW, city);
  const row = await store.queryOne(sql);
  const lat = typeof row?.lat === "number" ? row.lat : null;
  const lon = typeof row?.lon === "number" ? row.lon : null;
  return {
    city: String(row?.city ?? city.toUpperCase()),
    lat,
    lon,
    parcelsWithCoordinates: Number(row?.parcels_with_coordinates ?? 0),
    provenance: provenance(context, sql, []),
  };
}
