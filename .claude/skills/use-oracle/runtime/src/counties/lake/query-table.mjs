/**
 * Lake County query-table schema, row mapping, and roofing-signal
 * derivation.
 *
 * The published query table is one flat row per parcel, keyed by the DOR
 * `PARCEL_ID` in `request_identifier`, and readable by DuckDB over an HTTP
 * range read. It carries the six columns the kit's enrichment-profile schema
 * makes mandatory (`property_id`, `address_street`, `address_zip`,
 * `has_permits`, `has_sunbiz_tenant`, `has_bbb_contractor`) plus the
 * roofing-lead columns this county was onboarded for: roof age and its
 * basis, roofing-permit counts, open-permit duration, and owner locality.
 *
 * Honest-completeness rules encoded here rather than left to the caller:
 *
 * - `no_recorded_sale_in_dor_window` is a **lower bound**, not proof of long
 *   tenure. The published DOR roll carries only 2025-2026 sales (measured:
 *   `SALE_YR1` ranges 2025-2026 across all 215,806 rows; the SDF file spans
 *   the same window), and the DOR map-data archive's historical parcel files
 *   carry only `CO_NO` and `PARCEL_ID` (measured on the 2010 Lake file:
 *   178,377 records, exactly 2 attributes). Ten-year tenure cannot be proven
 *   from any published Lake source, so the column says what is true.
 * - `contractor_name` is populated **only where a source publishes it**, which
 *   in Lake means Clermont and nowhere else. The county's own permit detail
 *   pages carry contractor identity and answer HTTP 403 from every egress
 *   tested, and thirteen of the other fourteen municipalities are blocked
 *   outright, so the column is non-null on Clermont parcels that join the roll
 *   and null on the rest of the county. `enrichment_status` distinguishes the
 *   three cases that a bare null cannot — harvested and named, harvested and
 *   the permit named nobody, and never obtainable — because a gated field read
 *   as an established absence is the exact failure the use-oracle contract
 *   exists to prevent. There is no per-jurisdiction column: the schema is
 *   deliberately stable across counties, and the jurisdictional truth lives in
 *   the coverage snapshot.
 * - `bbb_rating` exists and stays null, with `enrichment_status` naming the
 *   reason. bbb.org answers HTTP 403 to every egress tested. Fabricating it
 *   would violate the use-oracle contract.
 *
 * @module counties/lake/query-table
 */

import { createHash } from "node:crypto";
import { toInteger, toNumber, toText } from "../../core/query-table.mjs";

/**
 * Always-a-string text coercion. `core/query-table.mjs#toText` returns `null`
 * for an empty or non-string value, which is the right shape for a published
 * column but the wrong one for internal string work; this is the internal
 * variant, and the two are deliberately not interchangeable.
 *
 * @param {unknown} value - Raw scalar.
 * @returns {string} Trimmed text, or the empty string.
 */
function asString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}
import { classifyDorUseBand, COUNTY_FIPS, COUNTY_KEY, COUNTY_NAME, STATE_CODE } from "./seed.mjs";

export const SOURCE_SYSTEM = "lake_dor_roll";
export { COUNTY_KEY, COUNTY_NAME, STATE_CODE, COUNTY_FIPS };

/** Default roof-age threshold the CRM's aged-roof question uses. Configurable at query time. */
export const DEFAULT_ROOF_AGE_THRESHOLD_YEARS = 15;

/**
 * Parquet schema for the Lake query table, in published column order.
 * `property_id` is the only required column; every other column is optional
 * so an unknown value writes as NULL rather than a sentinel.
 *
 * @type {Readonly<Record<string, { type: string, optional?: boolean }>>}
 */
export const LAKE_QUERY_TABLE_SCHEMA_FIELDS = Object.freeze({
  property_id: { type: "UTF8" },
  property_cid: { type: "UTF8", optional: true },
  request_identifier: { type: "UTF8", optional: true },
  parcel_identifier: { type: "UTF8", optional: true },
  alt_key: { type: "UTF8", optional: true },
  source_system: { type: "UTF8", optional: true },
  county_name: { type: "UTF8", optional: true },
  state_code: { type: "UTF8", optional: true },
  address_street: { type: "UTF8", optional: true },
  address_city: { type: "UTF8", optional: true },
  address_zip: { type: "UTF8", optional: true },
  latitude: { type: "DOUBLE", optional: true },
  longitude: { type: "DOUBLE", optional: true },
  lot_area_sqft: { type: "DOUBLE", optional: true },
  lot_size_acre: { type: "DOUBLE", optional: true },
  property_type: { type: "UTF8", optional: true },
  property_usage_type: { type: "UTF8", optional: true },
  dor_use_code: { type: "UTF8", optional: true },
  built_year: { type: "INT32", optional: true },
  effective_built_year: { type: "INT32", optional: true },
  livable_floor_area: { type: "DOUBLE", optional: true },
  building_count: { type: "INT32", optional: true },
  residential_units: { type: "INT32", optional: true },
  assessed_value: { type: "DOUBLE", optional: true },
  market_value: { type: "DOUBLE", optional: true },
  land_value: { type: "DOUBLE", optional: true },
  taxable_value: { type: "DOUBLE", optional: true },
  owner_name: { type: "UTF8", optional: true },
  owners_text: { type: "UTF8", optional: true },
  owner_count: { type: "INT32", optional: true },
  owner_mailing_city: { type: "UTF8", optional: true },
  owner_mailing_state: { type: "UTF8", optional: true },
  owner_mailing_zip: { type: "UTF8", optional: true },
  owner_out_of_county: { type: "BOOLEAN", optional: true },
  owner_out_of_state: { type: "BOOLEAN", optional: true },
  last_sale_date: { type: "UTF8", optional: true },
  last_sale_price: { type: "DOUBLE", optional: true },
  prior_sale_date: { type: "UTF8", optional: true },
  prior_sale_price: { type: "DOUBLE", optional: true },
  sale_records_in_window: { type: "INT32", optional: true },
  no_recorded_sale_in_dor_window: { type: "BOOLEAN", optional: true },
  roof_age_years: { type: "INT32", optional: true },
  roof_age_basis: { type: "UTF8", optional: true },
  roof_last_permit_date: { type: "UTF8", optional: true },
  has_permits: { type: "BOOLEAN", optional: true },
  permit_count: { type: "INT32", optional: true },
  roofing_permit_count: { type: "INT32", optional: true },
  open_permit_count: { type: "INT32", optional: true },
  open_roofing_permit_count: { type: "INT32", optional: true },
  longest_open_permit_days: { type: "INT32", optional: true },
  latest_permit_date: { type: "UTF8", optional: true },
  contractor_name: { type: "UTF8", optional: true },
  bbb_rating: { type: "UTF8", optional: true },
  has_bbb_contractor: { type: "BOOLEAN", optional: true },
  has_sunbiz_tenant: { type: "BOOLEAN", optional: true },
  has_business_account: { type: "BOOLEAN", optional: true },
  business_account_count: { type: "INT32", optional: true },
  business_naics_codes: { type: "UTF8", optional: true },
  business_names: { type: "UTF8", optional: true },
  roofing_business_count: { type: "INT32", optional: true },
  enrichment_status: { type: "UTF8", optional: true },
  source_systems: { type: "UTF8", optional: true },
});

/**
 * Stable 32-hex property id derived from the county key and parcel id,
 * matching the `duvalPropertyId` construction so ids stay comparable in
 * shape across counties.
 *
 * @param {string} parcelId - Canonical dashed Lake parcel id.
 * @returns {string} 32-hex-character id.
 */
export function lakePropertyId(parcelId) {
  return createHash("sha256").update(`${COUNTY_KEY}:${parcelId}`).digest("hex").slice(0, 32);
}

/**
 * @param {unknown} year - Candidate four-digit year.
 * @returns {number | null} The year, or null when implausible.
 */
export function toPlausibleYear(year) {
  const value = toInteger(year);
  if (value === null) return null;
  return value >= 1700 && value <= 2100 ? value : null;
}

/**
 * Build the `YYYY-MM-DD` sale date from the DOR roll's split year/month
 * columns. The roll carries no day component, so the first of the month is
 * used and the basis is recorded alongside.
 *
 * @param {unknown} year - `SALE_YR<n>`.
 * @param {unknown} month - `SALE_MO<n>`.
 * @returns {string | null} ISO date, or null.
 */
export function toSaleDate(year, month) {
  const saleYear = toPlausibleYear(year);
  if (saleYear === null) return null;
  const saleMonth = toInteger(month);
  const clamped = saleMonth !== null && saleMonth >= 1 && saleMonth <= 12 ? saleMonth : 1;
  return `${String(saleYear).padStart(4, "0")}-${String(clamped).padStart(2, "0")}-01`;
}

/**
 * @typedef {object} RoofAge
 * @property {number | null} years - Roof age in whole years.
 * @property {string | null} basis - How the age was derived.
 * @property {string | null} lastPermitDate - The roofing-permit date used, when any.
 */

/**
 * Derive roof age from the best available evidence, preferring a completed
 * roofing permit over an issued one, and falling back to the structure's
 * year built. Returns the basis so every answer can state its own evidence.
 *
 * @param {object} params - Derivation inputs.
 * @param {readonly { is_roofing: boolean, co_date: string | null, issued_date: string | null }[]} params.permits - Permits for the parcel.
 * @param {unknown} params.builtYear - `ACT_YR_BLT`.
 * @param {number} [params.asOfYear] - Reference year. Defaults to the current UTC year.
 * @returns {RoofAge} Roof age, basis, and the permit date used.
 */
export function deriveRoofAge({ permits, builtYear, asOfYear }) {
  const currentYear = asOfYear ?? new Date().getUTCFullYear();
  const roofing = permits.filter((permit) => permit.is_roofing);
  const completed = roofing
    .map((permit) => permit.co_date)
    .filter((date) => typeof date === "string" && date.length >= 4)
    .sort();
  if (completed.length > 0) {
    const latest = completed[completed.length - 1];
    const year = toPlausibleYear(latest.slice(0, 4));
    if (year !== null) {
      return { years: currentYear - year, basis: "roofing_permit_completed", lastPermitDate: latest };
    }
  }
  const issued = roofing
    .map((permit) => permit.issued_date)
    .filter((date) => typeof date === "string" && date.length >= 4)
    .sort();
  if (issued.length > 0) {
    const latest = issued[issued.length - 1];
    const year = toPlausibleYear(latest.slice(0, 4));
    if (year !== null) {
      return { years: currentYear - year, basis: "roofing_permit_issued", lastPermitDate: latest };
    }
  }
  const built = toPlausibleYear(builtYear);
  if (built !== null) {
    return { years: currentYear - built, basis: "year_built", lastPermitDate: null };
  }
  return { years: null, basis: null, lastPermitDate: null };
}

/**
 * Lake County city names, used to decide whether an owner's mailing address
 * is outside the county. Derived from the roll's own `PHY_CITY` vocabulary
 * rather than a hardcoded municipal list, so annexations cannot stale it.
 *
 * @param {Iterable<string>} physicalCities - Distinct `PHY_CITY` values from the roll.
 * @returns {Set<string>} Uppercased city names.
 */
export function buildInCountyCitySet(physicalCities) {
  const set = new Set();
  for (const city of physicalCities) {
    const normalized = asString(city).toUpperCase();
    if (normalized.length > 0) set.add(normalized);
  }
  return set;
}

/**
 * Owner display name from the roll. The DOR roll carries a single
 * `OWN_NAME` string that may pack several owners plus an estate or trust
 * qualifier; it is preserved verbatim and also split for counting.
 *
 * @param {unknown} ownName - `OWN_NAME`.
 * @returns {{ name: string | null, owners: string[] }} Primary name and split owners.
 */
export function parseOwnerNames(ownName) {
  const raw = asString(ownName);
  if (raw.length === 0) return { name: null, owners: [] };
  const owners = raw
    .split(/\s*&\s*|\s{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return { name: owners[0] ?? raw, owners: owners.length > 0 ? owners : [raw] };
}

/**
 * @typedef {object} LakeJoinedRecord
 * @property {Record<string, unknown>} nal - DOR NAL row for the parcel.
 * @property {{ latitude?: unknown, longitude?: unknown } | null} [centroid] - GIO centroid.
 * @property {readonly Record<string, unknown>[]} [permits] - Normalized permits for the parcel,
 *   from either permit source. A row's `source_system` says which, and only the Clermont
 *   eTRAKiT source carries `contractor_name`.
 * @property {readonly Record<string, unknown>[]} [sales] - SDF sale rows for the parcel.
 * @property {number} [businessAccountCount] - DOR TPP accounts at this situs address.
 * @property {Set<string>} [inCountyCities] - In-county city vocabulary.
 * @property {number} [asOfYear] - Reference year for age math.
 */

/**
 * Map one joined Lake record into a query-table row.
 *
 * @param {LakeJoinedRecord} record - Joined NAL/centroid/permit/sale record.
 * @returns {Record<string, unknown>} Flat query-table row.
 */
export function mapJoinedRecordToQueryTableRow(record) {
  const nal = record.nal;
  const permits = /** @type {any[]} */ (record.permits ?? []);
  const sales = record.sales ?? [];
  const parcelId = asString(nal.PARCEL_ID);
  const useBand = classifyDorUseBand(nal.DOR_UC);
  const { name: ownerName, owners } = parseOwnerNames(nal.OWN_NAME);

  const roofingPermits = permits.filter((permit) => permit.is_roofing === true);
  const openPermits = permits.filter((permit) => permit.is_open === true);
  const openRoofing = permits.filter((permit) => permit.is_open === true && permit.is_roofing === true);
  const openDurations = openPermits
    .map((permit) => toInteger(permit.days_open))
    .filter((days) => days !== null);
  const permitDates = permits
    .map((permit) => asString(permit.issued_date) || asString(permit.applied_date))
    .filter((date) => date.length > 0)
    .sort();

  const roof = deriveRoofAge({ permits, builtYear: nal.ACT_YR_BLT, asOfYear: record.asOfYear });

  const lastSaleDate = toSaleDate(nal.SALE_YR1, nal.SALE_MO1);
  const priorSaleDate = toSaleDate(nal.SALE_YR2, nal.SALE_MO2);

  const ownerCity = asString(nal.OWN_CITY).toUpperCase();
  const ownerState = asString(nal.OWN_STATE).toUpperCase();
  const inCounty = record.inCountyCities;
  const ownerOutOfCounty =
    ownerCity.length === 0 || inCounty === undefined ? null : !inCounty.has(ownerCity);

  const lotSqft = toNumber(nal.LND_SQFOOT);
  const businessAccounts = record.businessAccountCount ?? 0;
  const contractor = resolveContractorOfRecord(permits);

  return {
    property_id: lakePropertyId(parcelId),
    property_cid: null,
    request_identifier: parcelId,
    parcel_identifier: parcelId,
    alt_key: toText(nal.ALT_KEY),
    source_system: SOURCE_SYSTEM,
    county_name: COUNTY_NAME,
    state_code: STATE_CODE,
    address_street: toText(nal.PHY_ADDR1),
    address_city: toText(nal.PHY_CITY),
    address_zip: toText(nal.PHY_ZIPCD),
    latitude: toNumber(record.centroid?.latitude),
    longitude: toNumber(record.centroid?.longitude),
    lot_area_sqft: lotSqft,
    lot_size_acre: lotSqft === null ? null : lotSqft / 43_560,
    property_type: useBand,
    property_usage_type: useBand,
    dor_use_code: toText(nal.DOR_UC),
    built_year: toPlausibleYear(nal.ACT_YR_BLT),
    effective_built_year: toPlausibleYear(nal.EFF_YR_BLT),
    livable_floor_area: toNumber(nal.TOT_LVG_AREA),
    building_count: toInteger(nal.NO_BULDNG),
    residential_units: toInteger(nal.NO_RES_UNTS),
    assessed_value: toNumber(nal.AV_NSD),
    market_value: toNumber(nal.JV),
    land_value: toNumber(nal.LND_VAL),
    taxable_value: toNumber(nal.TV_NSD),
    owner_name: ownerName,
    owners_text: owners.length > 0 ? owners.join(" | ") : null,
    owner_count: owners.length,
    owner_mailing_city: toText(nal.OWN_CITY),
    owner_mailing_state: toText(nal.OWN_STATE),
    owner_mailing_zip: toText(nal.OWN_ZIPCD),
    owner_out_of_county: ownerOutOfCounty,
    owner_out_of_state: ownerState.length === 0 ? null : ownerState !== STATE_CODE,
    last_sale_date: lastSaleDate,
    last_sale_price: toNumber(nal.SALE_PRC1),
    prior_sale_date: priorSaleDate,
    prior_sale_price: toNumber(nal.SALE_PRC2),
    sale_records_in_window: sales.length,
    no_recorded_sale_in_dor_window: lastSaleDate === null && sales.length === 0,
    roof_age_years: roof.years,
    roof_age_basis: roof.basis,
    roof_last_permit_date: roof.lastPermitDate,
    has_permits: permits.length > 0,
    permit_count: permits.length,
    roofing_permit_count: roofingPermits.length,
    open_permit_count: openPermits.length,
    open_roofing_permit_count: openRoofing.length,
    longest_open_permit_days: openDurations.length > 0 ? Math.max(...openDurations) : null,
    latest_permit_date: permitDates.length > 0 ? permitDates[permitDates.length - 1] : null,
    contractor_name: contractor.name,
    bbb_rating: null,
    // Null, not false. Neither was checked: BBB is 403-gated and Sunbiz was
    // not ingested, so `false` would assert an absence nobody established.
    // Same rule as contractor_name and bbb_rating directly above.
    has_bbb_contractor: null,
    has_sunbiz_tenant: null,
    has_business_account: businessAccounts > 0,
    business_account_count: businessAccounts,
    business_naics_codes: record.businessNaicsCodes ?? null,
    business_names: record.businessNames ?? null,
    roofing_business_count: record.roofingBusinessCount ?? 0,
    enrichment_status: buildEnrichmentStatus(permits.length > 0, contractor.state),
    source_systems: buildSourceSystems(record),
  };
}

/** `source_system` of the countywide CD Plus permit layer. */
export const CDPLUS_SOURCE_SYSTEM = "lake_cdplus_permits";

/** `source_system` of the Clermont eTRAKiT permits. */
export const CLERMONT_SOURCE_SYSTEM = "lake_clermont_etrakit_permits";

/**
 * Resolve the contractor of record for a parcel, and say which of three states
 * produced it.
 *
 * A null contractor has never meant one thing here, and collapsing the three
 * cases into "null" is how a gated field gets read as an established absence.
 * The states are: a contractor was published and harvested; a permit was
 * harvested from a source that carries contractors and this one named none;
 * or every permit on the parcel came from a source that does not publish
 * contractors at all.
 *
 * The name kept is the one on the most recently dated permit, so the column
 * answers "who worked here last".
 *
 * @param {readonly Record<string, unknown>[]} permits - Permits for the parcel.
 * @returns {{ name: string | null, state: "from_clermont" | "absent_on_permit" | "gated" }}
 *   Contractor of record and the reason behind it.
 */
export function resolveContractorOfRecord(permits) {
  const carriers = permits.filter((permit) => asString(permit.source_system) === CLERMONT_SOURCE_SYSTEM);
  if (carriers.length === 0) return { name: null, state: "gated" };
  const named = carriers
    .filter((permit) => asString(permit.contractor_name).length > 0)
    .sort((left, right) => {
      const leftDate = asString(left.issued_date) || asString(left.applied_date);
      const rightDate = asString(right.issued_date) || asString(right.applied_date);
      return leftDate.localeCompare(rightDate);
    });
  if (named.length === 0) return { name: null, state: "absent_on_permit" };
  return { name: asString(named[named.length - 1].contractor_name), state: "from_clermont" };
}

/**
 * Name the enrichment that is present and the enrichment that is gated, so
 * a null contractor column is never mistaken for "no contractor exists".
 *
 * @param {boolean} hasPermits - Whether the parcel has permits.
 * @param {"from_clermont" | "absent_on_permit" | "gated"} [contractorState] - Contractor state.
 * @returns {string} A stable status token.
 */
export function buildEnrichmentStatus(hasPermits, contractorState = "gated") {
  const contractor = {
    from_clermont: "contractor_from_clermont_etrakit",
    absent_on_permit: "contractor_absent_on_permit",
    gated: "contractor_gated_403",
  }[contractorState];
  return [hasPermits ? "permits_loaded" : "no_permits_in_source", contractor, "bbb_gated_403"].join(";");
}

/**
 * List the source systems that actually contributed to a row, so provenance
 * survives into the published table.
 *
 * @param {LakeJoinedRecord} record - Joined record.
 * @returns {string} Pipe-delimited source-system list.
 */
export function buildSourceSystems(record) {
  const systems = ["fl_dor_nal_2026p"];
  if (record.centroid && record.centroid.latitude !== undefined && record.centroid.latitude !== null) {
    systems.push("fl_gio_parcel_centroid_2025");
  }
  const permits = record.permits ?? [];
  if (permits.some((permit) => asString(permit.source_system) !== CLERMONT_SOURCE_SYSTEM)) {
    systems.push(CDPLUS_SOURCE_SYSTEM);
  }
  if (permits.some((permit) => asString(permit.source_system) === CLERMONT_SOURCE_SYSTEM)) {
    systems.push(CLERMONT_SOURCE_SYSTEM);
  }
  if ((record.sales ?? []).length > 0) systems.push("fl_dor_sdf_2026p");
  if ((record.businessAccountCount ?? 0) > 0) systems.push("fl_dor_tpp_2026p");
  return systems.join("|");
}

/**
 * Assert that a set of Parquet column names matches the declared schema
 * exactly, in order. The full-county export writes Parquet through DuckDB
 * for speed while the pilot writes it through `@dsnp/parquetjs`; this is the
 * gate that keeps the two paths from drifting.
 *
 * @param {readonly string[]} columns - Column names read back from a Parquet file.
 * @returns {void}
 */
export function assertQueryTableColumns(columns) {
  const expected = Object.keys(LAKE_QUERY_TABLE_SCHEMA_FIELDS);
  if (columns.length !== expected.length) {
    throw new Error(`Query table has ${columns.length} columns, expected ${expected.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (columns[index] !== expected[index]) {
      throw new Error(
        `Query table column ${index} is "${columns[index]}", expected "${expected[index]}"`,
      );
    }
  }
}
