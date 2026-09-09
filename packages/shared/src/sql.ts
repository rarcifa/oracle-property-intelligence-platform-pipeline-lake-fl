/**
 * SQL builders shared by the server (DuckDB via `@duckdb/node-api`) and the
 * browser (DuckDB-WASM range-reading the Parquet from IPFS).
 *
 * Both runtimes execute the *same* generated SQL against the *same* Parquet, so
 * a browser answer and a server answer cannot disagree. That is the whole point
 * of putting these in the shared package rather than in either app.
 *
 * Values are inlined as escaped literals rather than bound parameters because
 * DuckDB-WASM's prepared-statement surface differs from the Node bindings.
 * Every literal goes through `quote`/`num`/`bool`, and every identifier goes
 * through `assertColumn`, so no caller-supplied text ever reaches SQL unescaped.
 */

import { DEFAULT_ROOF_AGE_THRESHOLD_YEARS, isQueryTableColumn } from "./schema.js";

/** Quote a string literal for DuckDB. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Emit a finite number literal, or throw. */
export function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Refusing to build SQL with a non-finite number: ${String(value)}`);
  }
  return String(value);
}

/** Emit a boolean literal. */
export function bool(value: boolean): string {
  return value ? "TRUE" : "FALSE";
}

/** Whitelist a column name against the published schema. */
export function assertColumn(name: string): string {
  if (!isQueryTableColumn(name)) {
    throw new Error(`Unknown query-table column: ${name}`);
  }
  return name;
}

/**
 * Reference to the table being queried.
 *
 * Two shapes are supported, and they are distinguished structurally rather than
 * by a flag so a caller cannot smuggle a path in as an identifier:
 *
 * - a bare SQL identifier (`properties`), used when the runtime has registered
 *   a view over the Parquet — this is what MCP callers and `/api/sql` see;
 * - anything else (a filesystem path, an https gateway URL, a DuckDB-WASM
 *   registered filename), emitted as a quoted literal so DuckDB's Parquet
 *   replacement scan reads it directly.
 */
export function tableRef(source: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) return source;
  return quote(source);
}

/** The view name both runtimes register over the published Parquet. */
export const PROPERTIES_VIEW = "properties";

/** DDL that registers the shared `properties` view over a Parquet source. */
export function buildCreateViewSql(source: string, view: string = PROPERTIES_VIEW): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(view)) {
    throw new Error(`Invalid view name: ${view}`);
  }
  return `CREATE OR REPLACE VIEW ${view} AS SELECT * FROM ${quote(source)}`;
}

/** Read back the view's column names, for the consumer-side schema gate. */
export function buildDescribeSql(source: string): string {
  return `SELECT column_name FROM (DESCRIBE SELECT * FROM ${tableRef(source)})`;
}

/** Statute miles per degree of latitude, used for the bounding-box prefilter. */
const MILES_PER_DEGREE_LAT = 69.047;
const EARTH_RADIUS_MILES = 3958.7613;

/** Great-circle distance in miles, as a DuckDB expression. */
export function haversineMilesExpr(lat: number, lon: number): string {
  const latRad = `radians(${num(lat)})`;
  const lonRad = `radians(${num(lon)})`;
  return (
    `(${num(EARTH_RADIUS_MILES)} * 2 * asin(sqrt(` +
    `pow(sin((radians(latitude) - ${latRad}) / 2), 2) + ` +
    `cos(${latRad}) * cos(radians(latitude)) * ` +
    `pow(sin((radians(longitude) - ${lonRad}) / 2), 2)` +
    `)))`
  );
}

/** Filters accepted by property search. All fields optional. */
export interface PropertyFilters {
  /** Free text matched against parcel id, street address and owner name. */
  q?: string;
  city?: string;
  zip?: string;
  propertyType?: string;
  roofAgeBasis?: string;
  minRoofAge?: number;
  maxRoofAge?: number;
  hasPermits?: boolean;
  hasOpenRoofingPermit?: boolean;
  minOpenPermitDays?: number;
  ownerOutOfCounty?: boolean;
  ownerOutOfState?: boolean;
  noRecordedSale?: boolean;
  hasBusinessAccount?: boolean;
  minMarketValue?: number;
  maxMarketValue?: number;
  minBuiltYear?: number;
  maxBuiltYear?: number;
  /** Radius search. All three are required together. */
  lat?: number;
  lon?: number;
  radiusMiles?: number;
  /** Only rows that carry coordinates (needed for the map). */
  requireCoordinates?: boolean;
}

export interface SearchOptions extends PropertyFilters {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

/** Hard cap on rows returned by one search, applied in both runtimes. */
export const MAX_SEARCH_LIMIT = 500;
export const DEFAULT_SEARCH_LIMIT = 50;

/** Build the WHERE predicates for a filter set. Returns `[]` when unfiltered. */
export function buildPredicates(filters: PropertyFilters): string[] {
  const where: string[] = [];

  if (filters.q && filters.q.trim().length > 0) {
    const needle = quote(`%${filters.q.trim().toUpperCase()}%`);
    where.push(
      `(upper(coalesce(request_identifier, '')) LIKE ${needle}` +
        ` OR upper(coalesce(address_street, '')) LIKE ${needle}` +
        ` OR upper(coalesce(owner_name, '')) LIKE ${needle}` +
        ` OR upper(coalesce(owners_text, '')) LIKE ${needle})`,
    );
  }
  if (filters.city && filters.city.trim().length > 0) {
    where.push(`upper(coalesce(address_city, '')) = ${quote(filters.city.trim().toUpperCase())}`);
  }
  if (filters.zip && filters.zip.trim().length > 0) {
    where.push(`coalesce(address_zip, '') = ${quote(filters.zip.trim())}`);
  }
  if (filters.propertyType && filters.propertyType.trim().length > 0) {
    where.push(`property_type = ${quote(filters.propertyType.trim())}`);
  }
  if (filters.roofAgeBasis && filters.roofAgeBasis.trim().length > 0) {
    where.push(`roof_age_basis = ${quote(filters.roofAgeBasis.trim())}`);
  }
  if (typeof filters.minRoofAge === "number") {
    where.push(`roof_age_years >= ${num(filters.minRoofAge)}`);
  }
  if (typeof filters.maxRoofAge === "number") {
    where.push(`roof_age_years <= ${num(filters.maxRoofAge)}`);
  }
  if (typeof filters.hasPermits === "boolean") {
    where.push(`coalesce(has_permits, FALSE) = ${bool(filters.hasPermits)}`);
  }
  if (filters.hasOpenRoofingPermit === true) {
    where.push(`coalesce(open_roofing_permit_count, 0) > 0`);
  } else if (filters.hasOpenRoofingPermit === false) {
    where.push(`coalesce(open_roofing_permit_count, 0) = 0`);
  }
  if (typeof filters.minOpenPermitDays === "number") {
    where.push(`coalesce(longest_open_permit_days, 0) >= ${num(filters.minOpenPermitDays)}`);
  }
  if (typeof filters.ownerOutOfCounty === "boolean") {
    where.push(`owner_out_of_county = ${bool(filters.ownerOutOfCounty)}`);
  }
  if (typeof filters.ownerOutOfState === "boolean") {
    where.push(`owner_out_of_state = ${bool(filters.ownerOutOfState)}`);
  }
  if (typeof filters.noRecordedSale === "boolean") {
    where.push(`coalesce(no_recorded_sale_in_dor_window, FALSE) = ${bool(filters.noRecordedSale)}`);
  }
  if (typeof filters.hasBusinessAccount === "boolean") {
    where.push(
      filters.hasBusinessAccount
        ? `coalesce(business_account_count, 0) > 0`
        : `coalesce(business_account_count, 0) = 0`,
    );
  }
  if (typeof filters.minMarketValue === "number") {
    where.push(`market_value >= ${num(filters.minMarketValue)}`);
  }
  if (typeof filters.maxMarketValue === "number") {
    where.push(`market_value <= ${num(filters.maxMarketValue)}`);
  }
  if (typeof filters.minBuiltYear === "number") {
    where.push(`built_year >= ${num(filters.minBuiltYear)}`);
  }
  if (typeof filters.maxBuiltYear === "number") {
    where.push(`built_year <= ${num(filters.maxBuiltYear)}`);
  }
  if (filters.requireCoordinates) {
    where.push(`latitude IS NOT NULL AND longitude IS NOT NULL`);
  }

  const { lat, lon, radiusMiles } = filters;
  if (typeof lat === "number" || typeof lon === "number" || typeof radiusMiles === "number") {
    if (typeof lat !== "number" || typeof lon !== "number" || typeof radiusMiles !== "number") {
      throw new Error("Radius search requires lat, lon and radiusMiles together");
    }
    if (lat < -90 || lat > 90) throw new Error(`Latitude out of range: ${lat}`);
    if (lon < -180 || lon > 180) throw new Error(`Longitude out of range: ${lon}`);
    if (radiusMiles <= 0) throw new Error(`radiusMiles must be positive: ${radiusMiles}`);
    // Bounding box first so DuckDB can skip row groups, then the exact
    // great-circle distance.
    const latDelta = radiusMiles / MILES_PER_DEGREE_LAT;
    const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
    const lonDelta = radiusMiles / (MILES_PER_DEGREE_LAT * cosLat);
    where.push(`latitude IS NOT NULL AND longitude IS NOT NULL`);
    where.push(`latitude BETWEEN ${num(lat - latDelta)} AND ${num(lat + latDelta)}`);
    where.push(`longitude BETWEEN ${num(lon - lonDelta)} AND ${num(lon + lonDelta)}`);
    where.push(`${haversineMilesExpr(lat, lon)} <= ${num(radiusMiles)}`);
  }

  return where;
}

function whereClause(predicates: readonly string[]): string {
  return predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : "";
}

/** `SELECT *` (plus `distance_miles` for a radius search) with paging. */
export function buildSearchSql(source: string, options: SearchOptions = {}): string {
  const predicates = buildPredicates(options);
  const isRadius = typeof options.radiusMiles === "number";
  const projection = isRadius
    ? `*, ${haversineMilesExpr(options.lat as number, options.lon as number)} AS distance_miles`
    : "*";

  const limit = clampLimit(options.limit);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));

  let orderBy: string;
  if (options.sortBy) {
    const column = assertColumn(options.sortBy);
    const dir = options.sortDir === "asc" ? "ASC" : "DESC";
    orderBy = `${column} ${dir} NULLS LAST, request_identifier ASC`;
  } else if (isRadius) {
    orderBy = `distance_miles ASC, request_identifier ASC`;
  } else {
    orderBy = `request_identifier ASC`;
  }

  return (
    `SELECT ${projection} FROM ${tableRef(source)}` +
    whereClause(predicates) +
    ` ORDER BY ${orderBy} LIMIT ${num(limit)} OFFSET ${num(offset)}`
  );
}

/** Matching-row count for the same filters. */
export function buildCountSql(source: string, filters: PropertyFilters = {}): string {
  return (
    `SELECT count(*) AS matched FROM ${tableRef(source)}` + whereClause(buildPredicates(filters))
  );
}

/** One parcel by its `request_identifier`. */
export function buildPropertyDetailSql(source: string, parcelId: string): string {
  return (
    `SELECT * FROM ${tableRef(source)} WHERE request_identifier = ${quote(parcelId)}` +
    ` OR property_id = ${quote(parcelId)} LIMIT 1`
  );
}

/**
 * Headline dataset counts. Every number the UI shows comes from this query or
 * from a filtered search; none are hardcoded.
 */
export function buildDatasetStatsSql(source: string): string {
  return `SELECT
  count(*) AS properties,
  count(latitude) AS with_coordinates,
  count(roof_age_years) AS roof_age_known,
  count(*) FILTER (WHERE roof_age_years >= ${DEFAULT_ROOF_AGE_THRESHOLD_YEARS}) AS roof_age_15_plus,
  count(*) FILTER (WHERE coalesce(has_permits, FALSE)) AS with_permits,
  sum(coalesce(permit_count, 0)) AS permit_records,
  sum(coalesce(roofing_permit_count, 0)) AS roofing_permit_records,
  count(*) FILTER (WHERE coalesce(open_permit_count, 0) > 0) AS with_open_permit,
  count(*) FILTER (WHERE coalesce(open_roofing_permit_count, 0) > 0) AS with_open_roofing_permit,
  count(*) FILTER (WHERE coalesce(longest_open_permit_days, 0) > 1825) AS open_over_five_years,
  count(*) FILTER (WHERE owner_out_of_county) AS owner_out_of_county,
  count(*) FILTER (WHERE owner_out_of_state) AS owner_out_of_state,
  count(*) FILTER (WHERE coalesce(no_recorded_sale_in_dor_window, FALSE)) AS no_recorded_sale,
  count(DISTINCT owner_name) AS distinct_owners,
  count(*) FILTER (WHERE coalesce(business_account_count, 0) > 0) AS with_business_account,
  sum(coalesce(business_account_count, 0)) AS business_accounts,
  count(contractor_name) AS contractor_names_present,
  count(bbb_rating) AS bbb_ratings_present
FROM ${tableRef(source)}`;
}

/** Distinct values and counts for one low-cardinality column. */
export function buildFacetSql(source: string, column: string, limit = 100): string {
  const name = assertColumn(column);
  return (
    `SELECT ${name} AS value, count(*) AS count FROM ${tableRef(source)}` +
    ` WHERE ${name} IS NOT NULL GROUP BY 1 ORDER BY count DESC, value ASC LIMIT ${num(clampLimit(limit))}`
  );
}

/** Business view: DOR TPP account concentration by city. */
export function buildBusinessByCitySql(source: string, limit = 40): string {
  return `SELECT
  address_city AS city,
  count(*) FILTER (WHERE coalesce(business_account_count, 0) > 0) AS properties_with_accounts,
  sum(coalesce(business_account_count, 0)) AS business_accounts,
  count(*) AS properties
FROM ${tableRef(source)}
WHERE address_city IS NOT NULL
GROUP BY 1
HAVING properties_with_accounts > 0
ORDER BY business_accounts DESC, city ASC
LIMIT ${num(clampLimit(limit))}`;
}

/** Business view: account concentration by property type. */
export function buildBusinessByTypeSql(source: string): string {
  return `SELECT
  coalesce(property_type, 'unclassified') AS property_type,
  count(*) FILTER (WHERE coalesce(business_account_count, 0) > 0) AS properties_with_accounts,
  sum(coalesce(business_account_count, 0)) AS business_accounts
FROM ${tableRef(source)}
GROUP BY 1
HAVING properties_with_accounts > 0
ORDER BY business_accounts DESC`;
}

/** Contractor view: permit posture buckets, all derived from the table. */
export function buildPermitPostureSql(source: string): string {
  return `SELECT
  count(*) FILTER (WHERE coalesce(has_permits, FALSE)) AS properties_with_permits,
  sum(coalesce(permit_count, 0)) AS permit_records,
  sum(coalesce(roofing_permit_count, 0)) AS roofing_permit_records,
  sum(coalesce(open_permit_count, 0)) AS open_permit_records,
  sum(coalesce(open_roofing_permit_count, 0)) AS open_roofing_permit_records,
  count(*) FILTER (WHERE coalesce(open_permit_count, 0) > 0) AS properties_with_open_permit,
  count(*) FILTER (WHERE coalesce(open_roofing_permit_count, 0) > 0) AS properties_with_open_roofing_permit,
  count(*) FILTER (WHERE coalesce(longest_open_permit_days, 0) BETWEEN 1 AND 89) AS open_under_90_days,
  count(*) FILTER (WHERE coalesce(longest_open_permit_days, 0) BETWEEN 90 AND 364) AS open_90_to_364_days,
  count(*) FILTER (WHERE coalesce(longest_open_permit_days, 0) BETWEEN 365 AND 1824) AS open_1_to_5_years,
  count(*) FILTER (WHERE coalesce(longest_open_permit_days, 0) >= 1825) AS open_over_5_years,
  max(coalesce(longest_open_permit_days, 0)) AS longest_open_permit_days,
  max(latest_permit_date) AS latest_permit_date,
  count(contractor_name) AS contractor_names_present,
  count(bbb_rating) AS bbb_ratings_present
FROM ${tableRef(source)}`;
}

/** Tenant view: owner-locality and tenure posture. */
export function buildOwnerPostureSql(source: string): string {
  return `SELECT
  count(*) AS properties,
  count(DISTINCT owner_name) AS distinct_owners,
  count(*) FILTER (WHERE owner_out_of_county) AS out_of_county,
  count(*) FILTER (WHERE owner_out_of_state) AS out_of_state,
  count(*) FILTER (WHERE coalesce(no_recorded_sale_in_dor_window, FALSE)) AS no_recorded_sale,
  count(*) FILTER (WHERE last_sale_date IS NOT NULL) AS sale_on_record,
  count(*) FILTER (WHERE coalesce(owner_count, 0) > 1) AS multi_owner
FROM ${tableRef(source)}`;
}

/** Roof-age histogram by basis, for the tenant/roofing view. */
export function buildRoofAgeBandsSql(source: string): string {
  return `SELECT
  CASE
    WHEN roof_age_years IS NULL THEN 'unknown'
    WHEN roof_age_years < 5 THEN '0-4'
    WHEN roof_age_years < 10 THEN '5-9'
    WHEN roof_age_years < 15 THEN '10-14'
    WHEN roof_age_years < 20 THEN '15-19'
    WHEN roof_age_years < 30 THEN '20-29'
    WHEN roof_age_years < 50 THEN '30-49'
    ELSE '50+'
  END AS band,
  count(*) AS properties,
  count(*) FILTER (WHERE roof_age_basis = 'roofing_permit_completed') AS from_completed_permit,
  count(*) FILTER (WHERE roof_age_basis = 'roofing_permit_issued') AS from_issued_permit,
  count(*) FILTER (WHERE roof_age_basis = 'year_built') AS from_year_built
FROM ${tableRef(source)}
GROUP BY 1
ORDER BY min(coalesce(roof_age_years, 100000))`;
}

/** Clamp a caller-supplied limit into range. */
export function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_SEARCH_LIMIT);
}

/**
 * Functions that reach the filesystem, the network or another database engine.
 *
 * The mutating-keyword list below stops a caller changing state; it does not
 * stop one READING state. `SELECT * FROM read_text('/etc/passwd')` is a
 * perfectly valid read-only SELECT, and without this list the public SQL
 * endpoint is an unauthenticated arbitrary-file-read primitive against the
 * host. That was live and exploitable before this guard existed: `read_text`
 * returned the contents of a system file and `glob` listed the repository
 * directory. The DuckDB connection is separately locked down in
 * `packages/server/src/data/duckdb.ts`; this is the first of the two layers.
 */
const FILESYSTEM_FUNCTIONS = [
  "read_text",
  "read_blob",
  "read_csv",
  "read_csv_auto",
  "read_parquet",
  "parquet_scan",
  "read_json",
  "read_json_auto",
  "read_ndjson",
  "read_ndjson_auto",
  "read_xlsx",
  "sniff_csv",
  "glob",
  "delta_scan",
  "iceberg_scan",
  "postgres_scan",
  "postgres_query",
  "mysql_scan",
  "mysql_query",
  "sqlite_scan",
  "sqlite_query",
  "parquet_metadata",
  "parquet_schema",
  "parquet_file_metadata",
  "parquet_kv_metadata",
  "duckdb_settings",
  "duckdb_extensions",
  "getenv",
];

const MUTATING_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "create",
  "alter",
  "attach",
  "detach",
  "copy",
  "export",
  "import",
  "install",
  "load",
  "pragma",
  "set",
  "reset",
  "call",
  "truncate",
  "grant",
  "revoke",
  "vacuum",
  "checkpoint",
  "begin",
  "commit",
  "rollback",
  "replace",
  "merge",
  "use",
];

/** Strip string literals and comments so keyword checks cannot be fooled. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, " 'literal' ")
    .replace(/"(?:""|[^"])*"/g, ' "ident" ')
    .replace(/\$\$[\s\S]*?\$\$/g, " 'dollar' ");
}

/**
 * Accept only a single read-only `SELECT`/`WITH` statement.
 *
 * This is the gate on the `queryProperties` MCP tool and the `/api/sql`
 * endpoint. It rejects anything that mutates, attaches, installs, or reads the
 * local filesystem beyond the configured table.
 */
export function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (trimmed.length === 0) throw new Error("Empty SQL");
  if (trimmed.length > 20_000) throw new Error("SQL too long");

  const scrubbed = stripLiteralsAndComments(trimmed);
  if (scrubbed.includes(";")) {
    throw new Error("Only a single statement is allowed");
  }
  if (!/^\s*(select|with)\b/i.test(scrubbed)) {
    throw new Error("Only read-only SELECT or WITH statements are allowed");
  }
  for (const keyword of MUTATING_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(scrubbed)) {
      throw new Error(`Statement rejected: "${keyword}" is not allowed in a read-only query`);
    }
  }
  for (const fn of FILESYSTEM_FUNCTIONS) {
    const pattern = new RegExp(`\\b${fn}\\s*\\(`, "i");
    if (pattern.test(scrubbed)) {
      throw new Error(
        `Statement rejected: "${fn}" reads outside the published dataset and is not allowed`,
      );
    }
  }
  return trimmed;
}

/**
 * Wrap a caller's statement so the engine stops early.
 *
 * `/api/sql` and `/mcp` capped rows in JavaScript, after DuckDB had already
 * produced them: `SELECT * FROM properties` materialised all 215,806 rows to
 * return 200. The cap was presentation, not a bound on the work, on an
 * unauthenticated endpoint.
 *
 * One extra row is requested so a caller can be told the result was truncated
 * instead of being handed a silently short answer. An inner LIMIT is untouched
 * and still wins when it is smaller.
 */
export function boundStatement(sql: string, limit: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  return `SELECT * FROM (\n${trimmed}\n) AS bounded_statement LIMIT ${Math.max(1, Math.floor(limit)) + 1}`;
}
