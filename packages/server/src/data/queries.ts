/**
 * High-level queries, each one a thin wrapper that pairs a shared SQL builder
 * with the provenance the answer must carry.
 *
 * Nothing in this file hardcodes a figure. Every number the API, the MCP tools
 * and the chat agent report comes back from one of these calls, which is what
 * makes "show real counts" enforceable rather than aspirational.
 */

import {
  BUSINESS_VIEW_NOTE,
  buildBusinessByCitySql,
  buildBusinessByTypeSql,
  buildCountSql,
  buildDatasetStatsSql,
  buildFacetSql,
  buildOwnerPostureSql,
  buildPermitPostureSql,
  buildPropertyDetailSql,
  buildRoofAgeBandsSql,
  buildSearchSql,
  clampLimit,
  gatedFieldNotices,
  parseSourceSystems,
  PROPERTIES_VIEW,
  QUERY_TABLE_COLUMNS,
  type ResponseProvenance,
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
  const row = await store.queryOne(sql);
  if (row === null) return null;
  const status = typeof row.enrichment_status === "string" ? row.enrichment_status : null;
  return {
    property: row,
    sources: parseSourceSystems(typeof row.source_systems === "string" ? row.source_systems : null),
    gating: gatedFieldNotices(status),
    provenance: provenance(context, sql, [row]),
  };
}

export interface DatasetStats {
  stats: Record<string, number>;
  roofAgeBands: QueryRow[];
  provenance: ResponseProvenance;
}

function toNumberRecord(row: QueryRow | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (row === null) return out;
  for (const [key, value] of Object.entries(row)) {
    const parsed = typeof value === "number" ? value : Number(value ?? 0);
    out[key] = Number.isFinite(parsed) ? parsed : 0;
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
    // Both gated fields are gated for every row, so the notices from either
    // enrichment_status variant are the same; this asks for them explicitly.
    gating: gatedFieldNotices("permits_loaded;contractor_gated_403;bbb_gated_403"),
    provenance: provenance(context, sql, []),
    note: "Permit signals come from the Lake County CD Plus permit layer, joined to the DOR roll on Alternate_Key. That layer publishes a rolling 365-day Permit_LastModDate window and covers unincorporated Lake County only, so it is a current-permit source, not a permit archive.",
  };
}

/** Execute a caller-supplied read-only statement against the `properties` view. */
export async function runReadOnlySql(
  store: OracleDataStore,
  context: ProvenanceContext,
  sql: string,
  limit: number,
): Promise<{ rows: QueryRow[]; rowCount: number; sql: string; provenance: ResponseProvenance }> {
  const rows = await store.query(sql);
  const capped = rows.slice(0, limit);
  return {
    rows: capped,
    rowCount: rows.length,
    sql,
    provenance: provenance(context, sql, capped),
  };
}
