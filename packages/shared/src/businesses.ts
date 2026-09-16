/** Portable account-grain DOR TPP records, including unmatched source accounts. */
import { z } from "zod";
import { clampLimit, quote } from "./sql.js";

export const BUSINESSES_VIEW = "businesses";
export const BUSINESS_TABLE_COLUMNS = Object.freeze([
  ["business_id", "VARCHAR"],
  ["county", "VARCHAR"],
  ["account_id", "VARCHAR"],
  ["assessment_year", "INTEGER"],
  ["business_name", "VARCHAR"],
  ["naics_code", "VARCHAR"],
  ["situs_address", "VARCHAR"],
  ["situs_city", "VARCHAR"],
  ["situs_zip", "VARCHAR"],
  ["matched_parcel_count", "INTEGER"],
  ["matched_parcel_ids", "VARCHAR"],
  ["match_basis", "VARCHAR"],
  ["source_url", "VARCHAR"],
  ["source_system", "VARCHAR"],
  ["source_input_sha256", "VARCHAR"],
] as const);

export const businessSearchSchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  naics: z
    .string()
    .regex(/^\d{2,6}$/)
    .optional(),
  linked: z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    z.boolean().optional(),
  ),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type BusinessSearchOptions = z.input<typeof businessSearchSchema>;

export function assertBusinessSchemaMatches(
  columns: readonly { column_name: string; column_type: string }[],
): void {
  if (
    columns.length !== BUSINESS_TABLE_COLUMNS.length ||
    columns.some((column, index) => {
      const expected = BUSINESS_TABLE_COLUMNS[index];
      return !expected || column.column_name !== expected[0] || column.column_type !== expected[1];
    })
  ) {
    throw new Error("Business table failed the closed account-grain schema gate");
  }
}

export function buildEmptyBusinessTableSql(): string {
  return `CREATE OR REPLACE TABLE ${BUSINESSES_VIEW} AS SELECT ${BUSINESS_TABLE_COLUMNS.map(
    ([name, type]) => `CAST(NULL AS ${type}) AS ${name}`,
  ).join(", ")} WHERE FALSE`;
}

export function buildBusinessSearchSql(options: BusinessSearchOptions = {}, count = false): string {
  const parsed = businessSearchSchema.parse(options);
  const predicates: string[] = [];
  if (parsed.q) {
    const text = quote(`%${parsed.q}%`);
    predicates.push(
      `(business_name ILIKE ${text} OR account_id ILIKE ${text} OR situs_address ILIKE ${text})`,
    );
  }
  if (parsed.city) predicates.push(`upper(situs_city) = ${quote(parsed.city.toUpperCase())}`);
  if (parsed.naics) predicates.push(`naics_code = ${quote(parsed.naics)}`);
  if (parsed.linked !== undefined) {
    predicates.push(`matched_parcel_count ${parsed.linked ? ">" : "="} 0`);
  }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  return count
    ? `SELECT count(*) AS matched FROM ${BUSINESSES_VIEW}${where}`
    : `SELECT * FROM ${BUSINESSES_VIEW}${where} ORDER BY business_id LIMIT ${clampLimit(parsed.limit)} OFFSET ${parsed.offset}`;
}

export const BUSINESS_ACCOUNT_COUNTS_SQL = `SELECT count(*) AS source_business_accounts,
  count(*) FILTER (WHERE matched_parcel_count > 0) AS matched_business_accounts,
  count(*) FILTER (WHERE matched_parcel_count = 0) AS unmatched_business_accounts,
  coalesce(sum(matched_parcel_count), 0) AS account_parcel_attributions
FROM ${BUSINESSES_VIEW}`;

export const BUSINESS_ACCOUNT_NOTE =
  "DOR tangible-personal-property accounts are account-grain records, not verified legal companies or proof a business worked on a permit. All source accounts remain queryable, including unmatched ones. Parcel associations are normalized situs street + ZIP candidates; shared addresses can yield multiple parcel associations. Raw source payload and owner/fiduciary contact fields are kept private.";
