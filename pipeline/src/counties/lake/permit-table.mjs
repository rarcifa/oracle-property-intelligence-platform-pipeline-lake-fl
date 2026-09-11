/** Published Lake County per-permit table contract. */

export const LAKE_PERMIT_TABLE_SCHEMA_FIELDS = Object.freeze({
  permit_id: { type: "UTF8" },
  permit_number: { type: "UTF8", optional: true },
  parcel_identifier: { type: "UTF8", optional: true },
  alt_key: { type: "UTF8", optional: true },
  jurisdiction: { type: "UTF8", optional: true },
  permit_type: { type: "UTF8", optional: true },
  permit_description: { type: "UTF8", optional: true },
  permit_status: { type: "UTF8", optional: true },
  applied_date: { type: "UTF8", optional: true },
  approved_date: { type: "UTF8", optional: true },
  issued_date: { type: "UTF8", optional: true },
  completed_date: { type: "UTF8", optional: true },
  last_modified_date: { type: "UTF8", optional: true },
  is_roofing: { type: "BOOLEAN", optional: true },
  is_open: { type: "BOOLEAN", optional: true },
  days_open: { type: "INT32", optional: true },
  contractor_name: { type: "UTF8", optional: true },
  contractor_license: { type: "UTF8", optional: true },
  bbb_rating: { type: "UTF8", optional: true },
  source_url: { type: "UTF8", optional: true },
  source_system: { type: "UTF8", optional: true },
  linkage_status: { type: "UTF8", optional: true },
});

export function assertPermitTableColumns(columns) {
  const expected = Object.keys(LAKE_PERMIT_TABLE_SCHEMA_FIELDS);
  if (columns.length !== expected.length) {
    throw new Error(`Permit table has ${columns.length} columns, expected ${expected.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (columns[index] !== expected[index]) {
      throw new Error(
        `Permit table column ${index} is "${columns[index]}", expected "${expected[index]}"`,
      );
    }
  }
}
