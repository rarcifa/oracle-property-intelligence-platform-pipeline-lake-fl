/** Value normalisation: DuckDB scalars must cross the HTTP boundary as JSON. */
import { describe, expect, it } from "vitest";
import { normalizeRows, normalizeValue, OracleDataStore } from "../src/data/duckdb.js";

describe("normalizeValue", () => {
  it("passes plain scalars through", () => {
    expect(normalizeValue(42)).toBe(42);
    expect(normalizeValue("x")).toBe("x");
    expect(normalizeValue(true)).toBe(true);
  });

  it("maps undefined to null so JSON keeps the key", () => {
    expect(normalizeValue(undefined)).toBeNull();
    expect(normalizeValue(null)).toBeNull();
  });

  it("converts a safe bigint to a number", () => {
    expect(normalizeValue(215806n)).toBe(215806);
  });

  it("keeps an unsafe bigint as a string rather than rounding it", () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    expect(normalizeValue(huge)).toBe(huge.toString());
  });

  it("normalises nested arrays", () => {
    expect(normalizeValue([1n, 2n])).toEqual([1, 2]);
  });

  it("normalises every value in a row set", () => {
    expect(normalizeRows([{ a: 1n, b: null }])).toEqual([{ a: 1, b: null }]);
  });
});

describe("OracleDataStore", () => {
  it("refuses to construct without a source", () => {
    expect(() => new OracleDataStore({ source: "" })).toThrow(/No Parquet source configured/);
  });

  it("classifies an https source as ipfs and a path as local", () => {
    expect(
      new OracleDataStore({ source: "https://ipfs.filebase.io/ipfs/x/q.parquet" }).sourceKind,
    ).toBe("ipfs");
    expect(new OracleDataStore({ source: "/tmp/q.parquet" }).sourceKind).toBe("local");
  });
});
