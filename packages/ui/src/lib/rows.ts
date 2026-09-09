/**
 * Narrowing helpers for the untyped rows the API and DuckDB both return.
 *
 * Rows cross the wire as `Record<string, unknown>` because the published table
 * is queried dynamically (a radius search adds `distance_miles`, an ad-hoc SQL
 * query can return anything). These helpers narrow a single cell without
 * casting, so no `any` is ever needed at a call site.
 */

/** A string cell, or `null` when absent or of another type. */
export function str(row: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!row) return null;
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** A numeric cell, or `null`. */
export function num(row: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!row) return null;
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** A boolean cell, accepting DuckDB's 0/1 and "true"/"false" shapes. */
export function bool(row: Record<string, unknown> | null | undefined, key: string): boolean | null {
  if (!row) return null;
  const value = row[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/** Render any cell for a generic table, without inventing a value. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 0 ? value : "—";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "—";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

/** The parcel id a row is addressed by, preferring the published parcel id. */
export function parcelIdOf(row: Record<string, unknown>): string | null {
  return str(row, "request_identifier") ?? str(row, "property_id");
}
