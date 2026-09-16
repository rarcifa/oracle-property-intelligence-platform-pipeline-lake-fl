/** Plain-Node publication schema for the separate DOR TPP account table. */
export const LAKE_BUSINESS_TABLE_SCHEMA_FIELDS = Object.freeze({
  business_id: { type: "UTF8", optional: false },
  county: { type: "UTF8", optional: false },
  account_id: { type: "UTF8", optional: false },
  assessment_year: { type: "INT32", optional: true },
  business_name: { type: "UTF8", optional: true },
  naics_code: { type: "UTF8", optional: true },
  situs_address: { type: "UTF8", optional: true },
  situs_city: { type: "UTF8", optional: true },
  situs_zip: { type: "UTF8", optional: true },
  matched_parcel_count: { type: "INT32", optional: false },
  matched_parcel_ids: { type: "UTF8", optional: false },
  match_basis: { type: "UTF8", optional: false },
  source_url: { type: "UTF8", optional: false },
  source_system: { type: "UTF8", optional: false },
  source_input_sha256: { type: "UTF8", optional: false },
});

/** @param {string[]} names */
export function assertBusinessTableColumns(names) {
  const expected = Object.keys(LAKE_BUSINESS_TABLE_SCHEMA_FIELDS);
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("Business artifact has an unsupported account-grain schema");
  }
}
