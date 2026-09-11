/**
 * Published Lake County permit-table contract.
 *
 * The property query table deliberately remains one row per parcel. Full
 * permit records live beside it in `permit-table.parquet`, including records
 * whose parcel key does not join the current assessed roll. Keeping this as a
 * separate table preserves both invariants instead of dropping unlinked
 * permits or repeating property rows.
 */

export type PermitTableColumnType = "UTF8" | "INT32" | "BOOLEAN";

export interface PermitTableColumn {
  readonly name: string;
  readonly type: PermitTableColumnType;
  readonly optional: boolean;
}

const c = (name: string, type: PermitTableColumnType, optional = true): PermitTableColumn =>
  Object.freeze({ name, type, optional });

/** All published permit columns, in Parquet order. */
export const PERMIT_TABLE_COLUMNS: readonly PermitTableColumn[] = Object.freeze([
  c("permit_id", "UTF8", false),
  c("permit_number", "UTF8"),
  c("parcel_identifier", "UTF8"),
  c("alt_key", "UTF8"),
  c("jurisdiction", "UTF8"),
  c("permit_type", "UTF8"),
  c("permit_description", "UTF8"),
  c("permit_status", "UTF8"),
  c("applied_date", "UTF8"),
  c("approved_date", "UTF8"),
  c("issued_date", "UTF8"),
  c("completed_date", "UTF8"),
  c("last_modified_date", "UTF8"),
  c("is_roofing", "BOOLEAN"),
  c("is_open", "BOOLEAN"),
  c("days_open", "INT32"),
  c("contractor_name", "UTF8"),
  c("contractor_license", "UTF8"),
  c("bbb_rating", "UTF8"),
  c("source_url", "UTF8"),
  c("source_system", "UTF8"),
  c("linkage_status", "UTF8"),
]);

export const PERMIT_TABLE_COLUMN_NAMES: readonly string[] = Object.freeze(
  PERMIT_TABLE_COLUMNS.map((column) => column.name),
);

/** One row of `permit-table.parquet`. */
export interface PermitRow {
  permit_id: string;
  permit_number: string | null;
  parcel_identifier: string | null;
  alt_key: string | null;
  jurisdiction: string | null;
  permit_type: string | null;
  permit_description: string | null;
  permit_status: string | null;
  applied_date: string | null;
  approved_date: string | null;
  issued_date: string | null;
  completed_date: string | null;
  last_modified_date: string | null;
  is_roofing: boolean | null;
  is_open: boolean | null;
  days_open: number | null;
  contractor_name: string | null;
  contractor_license: string | null;
  bbb_rating: string | null;
  source_url: string | null;
  source_system: string | null;
  linkage_status: string | null;
}

/** Fail closed when a served permit artifact drifts from the producer schema. */
export function assertPermitSchemaMatches(columns: readonly string[]): void {
  if (columns.length !== PERMIT_TABLE_COLUMN_NAMES.length) {
    throw new Error(
      `Permit table has ${columns.length} columns, expected ${PERMIT_TABLE_COLUMN_NAMES.length}`,
    );
  }
  for (let index = 0; index < PERMIT_TABLE_COLUMN_NAMES.length; index += 1) {
    if (columns[index] !== PERMIT_TABLE_COLUMN_NAMES[index]) {
      throw new Error(
        `Permit table column ${index} is "${columns[index]}", expected "${PERMIT_TABLE_COLUMN_NAMES[index]}"`,
      );
    }
  }
}

/** Empty typed table used when opening a legacy run that predates permits. */
export function buildEmptyPermitTableSql(table = "permits"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`Invalid permit table name: ${table}`);
  }
  const typeName: Record<PermitTableColumnType, string> = {
    UTF8: "VARCHAR",
    INT32: "INTEGER",
    BOOLEAN: "BOOLEAN",
  };
  const projection = PERMIT_TABLE_COLUMNS.map(
    (column) => `CAST(NULL AS ${typeName[column.type]}) AS ${column.name}`,
  ).join(", ");
  return `CREATE OR REPLACE TABLE ${table} AS SELECT ${projection} WHERE FALSE`;
}
