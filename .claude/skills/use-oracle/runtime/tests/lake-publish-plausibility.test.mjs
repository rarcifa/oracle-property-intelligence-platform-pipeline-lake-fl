/**
 * Publish-time plausibility tests.
 *
 * The incident: an incremental run with no cached permit base fetched a two-day
 * window, treated it as the whole dataset, and published 281 permits over
 * 17,671. Readiness passed, the DAG hashed, CIDs matched byte for byte, two
 * gateways verified the bytes. Every check confirmed the bytes were what they
 * claimed to be; none could tell a small county from a truncated one.
 */
import { describe, expect, it } from "vitest";
import {
  assertTablesPlausible,
  coverageTableRows,
  MINIMUM_TABLE_RETENTION,
} from "../scripts/lake/publish-run.mjs";

const previous = {
  tables: [
    { name: "properties", rows: 215806 },
    { name: "permits", rows: 17671 },
    { name: "coordinates", rows: 209503 },
  ],
};

const coverage = (permits) => ({
  tables: {
    properties: { rows: 215806 },
    permits: { rows: permits },
    coordinates: { rows: 209503 },
    businessAccounts: { matchedToParcel: 2060 },
  },
});

describe("publish plausibility gate", () => {
  it("refuses the exact truncation that was published: 17,671 permits down to 281", () => {
    expect(() => assertTablesPlausible(coverageTableRows(coverage(281)), previous, {})).toThrow(
      /table 'permits' fell from 17671 to 281 rows/,
    );
  });

  it("names the retained fraction and how to override, so the operator can act", () => {
    let message = "";
    try {
      assertTablesPlausible(coverageTableRows(coverage(281)), previous, {});
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("1.6% retained");
    expect(message).toContain("ORACLE_ALLOW_TABLE_SHRINK");
  });

  it("allows a healthy run through untouched", () => {
    expect(() => assertTablesPlausible(coverageTableRows(coverage(17671)), previous, {})).not.toThrow();
  });

  it("allows growth, which is the normal incremental case", () => {
    expect(() => assertTablesPlausible(coverageTableRows(coverage(18500)), previous, {})).not.toThrow();
  });

  it("allows a modest contraction — permits are voided, parcels are combined", () => {
    const modest = Math.ceil(17671 * (MINIMUM_TABLE_RETENTION + 0.2));
    expect(() => assertTablesPlausible(coverageTableRows(coverage(modest)), previous, {})).not.toThrow();
  });

  it("publishes a genuine contraction only when the operator says so explicitly", () => {
    const env = { ORACLE_ALLOW_TABLE_SHRINK: "1" };
    expect(() => assertTablesPlausible(coverageTableRows(coverage(281)), previous, env)).not.toThrow();
  });

  it("has nothing to compare on a first run, and does not invent a baseline", () => {
    expect(() => assertTablesPlausible(coverageTableRows(coverage(281)), null, {})).not.toThrow();
  });

  it("checks every published table, not only permits", () => {
    const collapsed = { tables: { ...coverage(17671).tables, coordinates: { rows: 12 } } };
    expect(() => assertTablesPlausible(coverageTableRows(collapsed), previous, {})).toThrow(
      /table 'coordinates' fell from 209503 to 12 rows/,
    );
  });
});
