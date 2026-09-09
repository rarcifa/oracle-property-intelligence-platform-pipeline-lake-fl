/**
 * Arrow -> plain JavaScript conversion for DuckDB-WASM results.
 *
 * DuckDB returns an Arrow table whose row proxies are lazy views over the
 * underlying buffers, and whose aggregate columns (`count(*)`, `sum(...)`) come
 * back as `bigint`. React state and `JSON.stringify` both dislike each of those,
 * so every result is flattened to `Record<string, unknown>` with numbers as
 * numbers before it leaves the data layer.
 */

import type { Table } from "apache-arrow";

/** Row proxies expose `toJSON()`; Arrow's public types do not narrow it usefully. */
interface RowProxy {
  toJSON(): Record<string, unknown>;
}

/** Recursively convert bigints, dates and typed arrays into plain values. */
function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    // Every published column is well inside the safe-integer range; a value that
    // is not would be a real bug and must not be silently truncated.
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      return value.toString();
    }
    return Number(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<unknown>);
  return value;
}

/** Flatten one Arrow table into plain row objects. */
export function tableToRows(table: Table): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const proxy of table.toArray()) {
    const raw = (proxy as unknown as RowProxy).toJSON();
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      row[key] = normalizeValue(value);
    }
    rows.push(row);
  }
  return rows;
}

/** Read a numeric cell, coercing the string/bigint shapes DuckDB can return. */
export function numberCell(row: Record<string, unknown> | null, key: string): number {
  if (!row) return 0;
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** Read a string cell, or `null`. */
export function stringCell(row: Record<string, unknown> | null, key: string): string | null {
  if (!row) return null;
  const value = row[key];
  return typeof value === "string" ? value : null;
}

/**
 * Turn a single aggregate row into a `Record<string, number>`.
 *
 * Non-numeric columns (an aggregate like `max(latest_permit_date)`) are dropped
 * rather than coerced to zero, so a caller can never read a fake count.
 */
export function rowToNumberRecord(row: Record<string, unknown> | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!row) return out;
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "bigint") {
      out[key] = Number(value);
    } else if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) out[key] = parsed;
    }
  }
  return out;
}
