/**
 * Arrow -> plain JavaScript conversion for DuckDB-WASM results.
 *
 * DuckDB returns an Arrow table whose row proxies are lazy views over the
 * underlying buffers. `count(*)` comes back as `bigint`, but `sum()` over an
 * integer column comes back as HUGEINT, which Arrow carries as a Decimal128:
 * four little-endian uint32 words, not a bigint. Flattening that with
 * `Array.from` produced `[17457, 0, 0, 0]` — rendered literally by the SQL
 * console, and dropped outright by `rowToNumberRecord`, so two overview tiles
 * showed an em-dash in the browser while the REST API answered 17,457 for the
 * same SQL. React state and `JSON.stringify` dislike all of these shapes, so
 * every result is flattened to `Record<string, unknown>` with numbers as numbers
 * before it leaves the data layer.
 */

import type { Table } from "apache-arrow";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const DECIMAL128_WORDS = 4;

/** Row proxies expose `toJSON()`; Arrow's public types do not narrow it usefully. */
interface RowProxy {
  toJSON(): Record<string, unknown>;
}

/**
 * Decode Arrow's Decimal128 representation — four little-endian uint32 words in
 * two's complement — into a number, or `null` when it will not fit one.
 *
 * `null` rather than a truncated number: a count that silently loses precision
 * is worse than a visibly absent one, and every published aggregate is far
 * inside the safe-integer range, so a value that overflows is a real bug.
 */
export function decimalToNumber(value: ArrayBufferView, scale: number): number | null {
  const words = new Uint32Array(
    value.buffer,
    value.byteOffset,
    Math.floor(value.byteLength / Uint32Array.BYTES_PER_ELEMENT),
  );
  if (words.length !== DECIMAL128_WORDS) return null;

  let magnitude = 0n;
  for (let index = DECIMAL128_WORDS - 1; index >= 0; index -= 1) {
    magnitude = (magnitude << 32n) | BigInt((words[index] ?? 0) >>> 0);
  }
  // Top bit of the most significant word is the sign.
  const top = words[DECIMAL128_WORDS - 1] ?? 0;
  const signed = (top & 0x80000000) === 0 ? magnitude : magnitude - (1n << 128n);

  if (scale === 0) {
    return signed > MAX_SAFE || signed < MIN_SAFE ? null : Number(signed);
  }
  const scaled = Number(signed) / 10 ** scale;
  return Number.isFinite(scaled) ? scaled : null;
}

/** Decode a typed-array cell if it is a Decimal128, else `null`. */
function decimalCell(value: unknown, scale = 0): number | null {
  return ArrayBuffer.isView(value) && !(value instanceof DataView)
    ? decimalToNumber(value, scale)
    : null;
}

/** Recursively convert bigints, dates and typed arrays into plain values. */
function normalizeValue(value: unknown, scale = 0): unknown {
  if (typeof value === "bigint") {
    // Every published column is well inside the safe-integer range; a value that
    // is not would be a real bug and must not be silently truncated.
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      return value.toString();
    }
    return Number(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry));
  const decimal = decimalCell(value, scale);
  if (decimal !== null) return decimal;
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<unknown>);
  return value;
}

/** Flatten one Arrow table into plain row objects. */
export function tableToRows(table: Table): Record<string, unknown>[] {
  // The decimal scale lives on the schema, not on the value, so it has to be
  // read here; `sum()` over an integer is scale 0, but a sum over a DECIMAL
  // column is not, and decoding it as scale 0 would inflate it by 10^scale.
  const scaleByField = new Map<string, number>();
  for (const field of table.schema.fields) {
    const scale = (field.type as { scale?: number }).scale;
    if (typeof scale === "number") scaleByField.set(field.name, scale);
  }

  const rows: Record<string, unknown>[] = [];
  for (const proxy of table.toArray()) {
    const raw = (proxy as unknown as RowProxy).toJSON();
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      row[key] = normalizeValue(value, scaleByField.get(key) ?? 0);
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
  const decimal = decimalCell(value);
  if (decimal !== null) return decimal;
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
    } else {
      const decimal = decimalCell(value);
      if (decimal !== null) out[key] = decimal;
    }
  }
  return out;
}
