/**
 * The published Lake County query-table schema.
 *
 * Mirrors `LAKE_QUERY_TABLE_SCHEMA_FIELDS` in the ingestion runtime
 * (`.claude/skills/use-oracle/runtime/src/counties/lake/query-table.mjs`) in
 * published column order. `assertQueryTableColumns` in the runtime is the
 * producer-side gate; `assertSchemaMatches` here is the consumer-side gate, so
 * a schema drift fails a test rather than silently returning empty columns.
 */

/** Parquet physical types used by the published table. */
export type QueryTableColumnType = "UTF8" | "DOUBLE" | "INT32" | "BOOLEAN";

export interface QueryTableColumn {
  readonly name: string;
  readonly type: QueryTableColumnType;
  readonly optional: boolean;
  /** Short human label used by the UI. */
  readonly label: string;
  /** Which upstream system supplies the value. */
  readonly source: string;
}

/** County identity of the published run. */
export const COUNTY = Object.freeze({
  key: "lake",
  name: "Lake",
  stateCode: "FL",
  fips: "12069",
});

/** Default aged-roof threshold, matching the ingestion runtime's default. */
export const DEFAULT_ROOF_AGE_THRESHOLD_YEARS = 15;

const c = (
  name: string,
  type: QueryTableColumnType,
  optional: boolean,
  label: string,
  source: string,
): QueryTableColumn => Object.freeze({ name, type, optional, label, source });

const NAL = "FL DOR NAL 2026P";
const GIO = "FL GIO parcel centroids 2025";
/**
 * Permit aggregates draw on BOTH permit sources since Clermont was harvested:
 * the county CD Plus layer for unincorporated Lake and Clermont's eTRAKiT
 * portal for that municipality. A parcel's `permit_count` therefore means the
 * same thing whichever jurisdiction issued the permit, and `source_systems`
 * on the row names the one that actually contributed. Labelling these CD Plus
 * alone would have understated every Clermont parcel's permit provenance, and
 * left no column in the table naming CD Plus on its own - which is why the
 * CD-Plus-only constant is gone rather than kept beside this one.
 */
const PERMITS = "Lake County CD Plus permit layer + Clermont eTRAKiT permits";
const SDF = "FL DOR SDF 2026P";
const TPP = "FL DOR TPP 2026P";
const DERIVED = "derived by the pipeline";
/**
 * `contractor_name` is the only partially-populated column in the table.
 * Clermont's eTRAKiT portal publishes a contractor of record and the other
 * fourteen Lake jurisdictions do not, so the source label has to name the
 * jurisdiction that supplies the value and say what the rest of the county
 * looks like. It read "gated at source (HTTP 403)" until Clermont was
 * harvested; leaving it that way would now understate the column exactly as
 * badly as claiming county-wide contractor coverage would overstate it.
 */
const CLERMONT = "Clermont eTRAKiT permits; null elsewhere";

/** All 62 published columns, in Parquet column order. */
export const QUERY_TABLE_COLUMNS: readonly QueryTableColumn[] = Object.freeze([
  c("property_id", "UTF8", false, "Property id", DERIVED),
  c("property_cid", "UTF8", true, "Property CID", DERIVED),
  c("request_identifier", "UTF8", true, "Parcel id", NAL),
  c("parcel_identifier", "UTF8", true, "Parcel identifier", NAL),
  c("alt_key", "UTF8", true, "Alternate key", NAL),
  c("source_system", "UTF8", true, "Source system", DERIVED),
  c("county_name", "UTF8", true, "County", NAL),
  c("state_code", "UTF8", true, "State", NAL),
  c("address_street", "UTF8", true, "Street address", NAL),
  c("address_city", "UTF8", true, "City", NAL),
  c("address_zip", "UTF8", true, "ZIP", NAL),
  c("latitude", "DOUBLE", true, "Latitude", GIO),
  c("longitude", "DOUBLE", true, "Longitude", GIO),
  c("lot_area_sqft", "DOUBLE", true, "Lot area (sqft)", NAL),
  c("lot_size_acre", "DOUBLE", true, "Lot size (acres)", DERIVED),
  c("property_type", "UTF8", true, "Property type", NAL),
  c("property_usage_type", "UTF8", true, "Usage type", NAL),
  c("dor_use_code", "UTF8", true, "DOR use code", NAL),
  c("built_year", "INT32", true, "Year built", NAL),
  c("effective_built_year", "INT32", true, "Effective year built", NAL),
  c("livable_floor_area", "DOUBLE", true, "Livable floor area", NAL),
  c("building_count", "INT32", true, "Buildings", NAL),
  c("residential_units", "INT32", true, "Residential units", NAL),
  c("assessed_value", "DOUBLE", true, "Assessed value", NAL),
  c("market_value", "DOUBLE", true, "Market value", NAL),
  c("land_value", "DOUBLE", true, "Land value", NAL),
  c("taxable_value", "DOUBLE", true, "Taxable value", NAL),
  c("owner_name", "UTF8", true, "Owner", NAL),
  c("owners_text", "UTF8", true, "All owners", NAL),
  c("owner_count", "INT32", true, "Owner count", DERIVED),
  c("owner_mailing_city", "UTF8", true, "Owner mailing city", NAL),
  c("owner_mailing_state", "UTF8", true, "Owner mailing state", NAL),
  c("owner_mailing_zip", "UTF8", true, "Owner mailing ZIP", NAL),
  c("owner_out_of_county", "BOOLEAN", true, "Owner out of county", DERIVED),
  c("owner_out_of_state", "BOOLEAN", true, "Owner out of state", DERIVED),
  c("last_sale_date", "UTF8", true, "Last sale date", NAL),
  c("last_sale_price", "DOUBLE", true, "Last sale price", NAL),
  c("prior_sale_date", "UTF8", true, "Prior sale date", NAL),
  c("prior_sale_price", "DOUBLE", true, "Prior sale price", NAL),
  c("sale_records_in_window", "INT32", true, "Sale records in DOR window", SDF),
  c("no_recorded_sale_in_dor_window", "BOOLEAN", true, "No sale in DOR window", DERIVED),
  c("roof_age_years", "INT32", true, "Roof age (years)", DERIVED),
  c("roof_age_basis", "UTF8", true, "Roof age basis", DERIVED),
  c("roof_last_permit_date", "UTF8", true, "Roof permit date used", PERMITS),
  c("has_permits", "BOOLEAN", true, "Has permits", PERMITS),
  c("permit_count", "INT32", true, "Permits", PERMITS),
  c("roofing_permit_count", "INT32", true, "Roofing permits", PERMITS),
  c("open_permit_count", "INT32", true, "Open permits", PERMITS),
  c("open_roofing_permit_count", "INT32", true, "Open roofing permits", PERMITS),
  c("longest_open_permit_days", "INT32", true, "Longest open permit (days)", PERMITS),
  c("latest_permit_date", "UTF8", true, "Latest permit date", PERMITS),
  c("contractor_name", "UTF8", true, "Contractor of record", CLERMONT),
  c("bbb_rating", "UTF8", true, "BBB rating", "gated at source (HTTP 403)"),
  c("has_bbb_contractor", "BOOLEAN", true, "Has BBB contractor", "gated at source (HTTP 403)"),
  c("has_sunbiz_tenant", "BOOLEAN", true, "Has Sunbiz tenant", "not ingested for this run"),
  c("has_business_account", "BOOLEAN", true, "Has business account", TPP),
  c("business_account_count", "INT32", true, "Business accounts", TPP),
  c("business_naics_codes", "UTF8", true, "Business NAICS codes at this address", TPP),
  c("business_names", "UTF8", true, "TPP account names at this address", TPP),
  c("roofing_business_count", "INT32", true, "Roofing businesses (NAICS 238160)", TPP),
  c("enrichment_status", "UTF8", true, "Enrichment status", DERIVED),
  c("source_systems", "UTF8", true, "Contributing sources", DERIVED),
]);

/** Published column count, asserted by tests. */
export const QUERY_TABLE_COLUMN_COUNT = QUERY_TABLE_COLUMNS.length;

/** Ordered column names. */
export const QUERY_TABLE_COLUMN_NAMES: readonly string[] = Object.freeze(
  QUERY_TABLE_COLUMNS.map((column) => column.name),
);

const COLUMN_BY_NAME = new Map(QUERY_TABLE_COLUMNS.map((column) => [column.name, column]));

/** Look a column up by published name. */
export function getColumn(name: string): QueryTableColumn | undefined {
  return COLUMN_BY_NAME.get(name);
}

/** True when `name` is a published column. Used to whitelist sort/select input. */
export function isQueryTableColumn(name: string): boolean {
  return COLUMN_BY_NAME.has(name);
}

/**
 * Consumer-side schema gate: throws when the Parquet the app actually opened
 * does not carry exactly the published columns, in order.
 */
export function assertSchemaMatches(columns: readonly string[]): void {
  if (columns.length !== QUERY_TABLE_COLUMN_COUNT) {
    throw new Error(
      `Query table has ${columns.length} columns, expected ${QUERY_TABLE_COLUMN_COUNT}`,
    );
  }
  for (let index = 0; index < QUERY_TABLE_COLUMN_NAMES.length; index += 1) {
    if (columns[index] !== QUERY_TABLE_COLUMN_NAMES[index]) {
      throw new Error(
        `Query table column ${index} is "${columns[index]}", expected "${QUERY_TABLE_COLUMN_NAMES[index]}"`,
      );
    }
  }
}

/** One published row. Every column is nullable except `property_id`. */
export interface PropertyRow {
  property_id: string;
  property_cid: string | null;
  request_identifier: string | null;
  parcel_identifier: string | null;
  alt_key: string | null;
  source_system: string | null;
  county_name: string | null;
  state_code: string | null;
  address_street: string | null;
  address_city: string | null;
  address_zip: string | null;
  latitude: number | null;
  longitude: number | null;
  lot_area_sqft: number | null;
  lot_size_acre: number | null;
  property_type: string | null;
  property_usage_type: string | null;
  dor_use_code: string | null;
  built_year: number | null;
  effective_built_year: number | null;
  livable_floor_area: number | null;
  building_count: number | null;
  residential_units: number | null;
  assessed_value: number | null;
  market_value: number | null;
  land_value: number | null;
  taxable_value: number | null;
  owner_name: string | null;
  owners_text: string | null;
  owner_count: number | null;
  owner_mailing_city: string | null;
  owner_mailing_state: string | null;
  owner_mailing_zip: string | null;
  owner_out_of_county: boolean | null;
  owner_out_of_state: boolean | null;
  last_sale_date: string | null;
  last_sale_price: number | null;
  prior_sale_date: string | null;
  prior_sale_price: number | null;
  sale_records_in_window: number | null;
  no_recorded_sale_in_dor_window: boolean | null;
  roof_age_years: number | null;
  roof_age_basis: string | null;
  roof_last_permit_date: string | null;
  has_permits: boolean | null;
  permit_count: number | null;
  roofing_permit_count: number | null;
  open_permit_count: number | null;
  open_roofing_permit_count: number | null;
  longest_open_permit_days: number | null;
  latest_permit_date: string | null;
  contractor_name: string | null;
  bbb_rating: string | null;
  has_bbb_contractor: boolean | null;
  has_sunbiz_tenant: boolean | null;
  has_business_account: boolean | null;
  business_account_count: number | null;
  business_naics_codes: string | null;
  business_names: string | null;
  roofing_business_count: number | null;
  enrichment_status: string | null;
  source_systems: string | null;
}

/** Human labels for the pipeline's roof-age basis tokens. */
export const ROOF_AGE_BASIS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  roofing_permit_completed: "Completed roofing permit",
  roofing_permit_issued: "Issued roofing permit",
  year_built: "Year built (no roofing permit on record)",
});

/** Human labels for the source-system tokens in `source_systems`. */
export const SOURCE_SYSTEM_LABELS: Readonly<Record<string, string>> = Object.freeze({
  fl_dor_nal_2026p: "FL DOR NAL 2026 preliminary tax roll",
  fl_gio_parcel_centroid_2025: "FL GIO parcel centroids 2025",
  lake_cdplus_permits: "Lake County CD Plus permit layer",
  fl_dor_sdf_2026p: "FL DOR SDF 2026 preliminary sales file",
  fl_dor_tpp_2026p: "FL DOR TPP 2026 preliminary tangible personal property roll",
  lake_clermont_etrakit_permits: "City of Clermont eTRAKiT permit portal",
});

/** Split the pipe-delimited `source_systems` column into labelled sources. */
export function parseSourceSystems(value: string | null | undefined): {
  token: string;
  label: string;
}[] {
  if (!value) return [];
  return value
    .split("|")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => ({ token, label: SOURCE_SYSTEM_LABELS[token] ?? token }));
}
