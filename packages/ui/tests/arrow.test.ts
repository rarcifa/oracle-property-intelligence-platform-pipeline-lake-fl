/**
 * DuckDB-WASM returns `sum()` over an integer column as HUGEINT, which Arrow
 * surfaces as a Decimal128 — four little-endian uint32 words, not a bigint.
 *
 * `Array.from` on that produced `[17457, 0, 0, 0]`: the SQL console rendered
 * that literally, and `rowToNumberRecord` dropped the key entirely, so the
 * overview's "Permit records joined" and "Roofing permit records" tiles showed
 * an em-dash in the browser while the REST API returned 17,457 and 3,256 for
 * the same SQL. Observed on the deployed runtime.
 */
import { describe, expect, it } from "vitest";
import { decimalToNumber, numberCell, rowToNumberRecord } from "../src/data/arrow.js";

/** The four-word little-endian Int128 DuckDB-WASM returned for sum(permit_count). */
const seventeenThousand = new Uint32Array([17457, 0, 0, 0]);

describe("decimalToNumber", () => {
  it("decodes the exact value the deployed SQL console rendered as [17457,0,0,0]", () => {
    expect(decimalToNumber(seventeenThousand, 0)).toBe(17457);
  });

  it("decodes a value above 2^32, which needs the second word", () => {
    expect(decimalToNumber(new Uint32Array([0, 1, 0, 0]), 0)).toBe(4294967296);
  });

  it("applies the decimal scale", () => {
    expect(decimalToNumber(new Uint32Array([12345, 0, 0, 0]), 2)).toBeCloseTo(123.45, 10);
  });

  it("decodes a negative value as two's complement", () => {
    expect(
      decimalToNumber(new Uint32Array([0xfffffff9, 0xffffffff, 0xffffffff, 0xffffffff]), 0),
    ).toBe(-7);
  });

  it("returns null for a value beyond the safe-integer range rather than truncating", () => {
    expect(decimalToNumber(new Uint32Array([0, 0, 1, 0]), 0)).toBeNull();
  });
});

describe("numberCell", () => {
  it("reads a decimal aggregate instead of returning 0", () => {
    expect(numberCell({ permit_records: seventeenThousand }, "permit_records")).toBe(17457);
  });
});

describe("rowToNumberRecord", () => {
  it("keeps a decimal aggregate instead of dropping the key", () => {
    expect(rowToNumberRecord({ permit_records: seventeenThousand, properties: 215806 })).toEqual({
      permit_records: 17457,
      properties: 215806,
    });
  });

  it("still drops a genuinely non-numeric aggregate rather than faking a zero", () => {
    expect(rowToNumberRecord({ latest_permit_date: "2026-01-01T00:00:00.000Z" })).toEqual({});
  });
});
