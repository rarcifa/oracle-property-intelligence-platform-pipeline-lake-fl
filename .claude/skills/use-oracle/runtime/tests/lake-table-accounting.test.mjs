/**
 * Table accounting tests.
 *
 * The failure these exist to prevent: a run reported inserted:0/updated:0 while
 * the permit layer had genuinely moved 17,457 -> 17,671 source-side. The counts
 * were right — every one of those permits was validUnlinked, so no property row
 * could change — but only `properties` was accounted for, so a real movement in
 * a published table left no trace at all.
 */
import { describe, expect, it } from "vitest";
import { buildTableAccounting } from "../scripts/lake/publish-run.mjs";
import { runTableSchema } from "../src/core/run-history.mjs";

const DELTAS = { inserted: 0, updated: 0, unchanged: 215806, removed: 0 };

const coverage = (permits, business = 2060) => ({
  tables: {
    properties: { rows: 215806 },
    permits: { rows: permits },
    coordinates: { rows: 209503 },
    businessAccounts: { matchedToParcel: business },
  },
});

describe("table accounting", () => {
  it("accounts for every published table, not only the hashed one", () => {
    const tables = buildTableAccounting(coverage(17671), DELTAS, null);
    expect(tables.map((table) => table.name)).toEqual([
      "properties",
      "permits",
      "coordinates",
      "businessAccounts",
    ]);
  });

  it("makes a permit movement visible even when no property row changed", () => {
    const previous = { tables: [{ name: "permits", rows: 17457 }] };
    const tables = buildTableAccounting(coverage(17671), DELTAS, previous);
    const permits = tables.find((table) => table.name === "permits");
    expect(permits.rowsDelta).toBe(214);
    expect(permits.previousRows).toBe(17457);
    // The property table is still, correctly, reporting no row-level change.
    expect(tables.find((table) => table.name === "properties").updated).toBe(0);
  });

  it("does not report four zeroes for a table it never hashed", () => {
    const tables = buildTableAccounting(coverage(17671), DELTAS, null);
    const permits = tables.find((table) => table.name === "permits");
    expect(permits.basis).toBe("row-count");
    expect(permits.inserted).toBeUndefined();
    expect(permits.unchanged).toBeUndefined();
  });

  it("keeps real row-level deltas on the table that is hashed", () => {
    const tables = buildTableAccounting(coverage(17671), { ...DELTAS, updated: 12 }, null);
    const properties = tables.find((table) => table.name === "properties");
    expect(properties.basis).toBe("row-hash");
    expect(properties.updated).toBe(12);
  });

  it("omits movement on a first run, rather than inventing a baseline", () => {
    const permits = buildTableAccounting(coverage(17671), DELTAS, null).find(
      (table) => table.name === "permits",
    );
    expect(permits.rowsDelta).toBeUndefined();
    expect(permits.previousRows).toBeUndefined();
  });

  it("every record validates, and a row-hash table without counts is refused", () => {
    for (const table of buildTableAccounting(coverage(17671), DELTAS, null)) {
      expect(() => runTableSchema.parse(table)).not.toThrow();
    }
    expect(() => runTableSchema.parse({ name: "properties", rows: 1, basis: "row-hash" })).toThrow();
  });

  it("still validates a record from before the basis field existed", () => {
    const legacy = { name: "properties", rows: 215806, inserted: 0, updated: 0, unchanged: 215806, removed: 0 };
    expect(runTableSchema.parse(legacy).basis).toBe("row-hash");
  });
});
