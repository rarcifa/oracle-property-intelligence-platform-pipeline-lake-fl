/**
 * Consumer-side schema gate. These tests fail if the app's view of the
 * published table drifts from the ingestion runtime's declared schema.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSchemaMatches,
  getColumn,
  isQueryTableColumn,
  parseSourceSystems,
  QUERY_TABLE_COLUMN_COUNT,
  QUERY_TABLE_COLUMN_NAMES,
  assertLocalEvidenceSchemaMatches,
  LOCAL_EVIDENCE_PROPERTY_COLUMNS,
  LOCAL_EVIDENCE_PROPERTY_SAFE_COLUMNS,
} from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeSchemaPath = resolve(here, "../../../pipeline/src/counties/lake/query-table.mjs");

/** Pull the declared column names out of the ingestion runtime's source. */
function readRuntimeColumns(): string[] {
  const source = readFileSync(runtimeSchemaPath, "utf8");
  const start = source.indexOf("LAKE_QUERY_TABLE_SCHEMA_FIELDS = Object.freeze({");
  if (start < 0) throw new Error("Could not locate LAKE_QUERY_TABLE_SCHEMA_FIELDS");
  const end = source.indexOf("});", start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s{2}([a-z0-9_]+):\s*\{/gm)].map((match) => match[1] as string);
}

describe("published schema", () => {
  it("declares 63 columns", () => {
    // The 63rd column separates the age of an open roofing permit from the
    // age of an unrelated open permit on the same parcel.
    expect(QUERY_TABLE_COLUMN_COUNT).toBe(63);
  });

  it("matches the ingestion runtime column list exactly, in order", () => {
    expect(QUERY_TABLE_COLUMN_NAMES).toEqual(readRuntimeColumns());
  });

  it("labels and sources every column", () => {
    for (const name of QUERY_TABLE_COLUMN_NAMES) {
      const column = getColumn(name);
      expect(column?.label.length ?? 0).toBeGreaterThan(0);
      expect(column?.source.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("whitelists only published columns", () => {
    expect(isQueryTableColumn("roof_age_years")).toBe(true);
    expect(isQueryTableColumn("roof_age_years; DROP")).toBe(false);
  });
});

describe("closed local evidence compatibility", () => {
  const types: Record<string, string> = {
    UTF8: "VARCHAR",
    INT32: "INTEGER",
    DOUBLE: "DOUBLE",
    BOOLEAN: "BOOLEAN",
  };
  const described = LOCAL_EVIDENCE_PROPERTY_COLUMNS.map((column) => ({
    column_name: column.name,
    column_type: types[column.type] as string,
  }));
  it("keeps the 82-column private contract separate from the strict public schema", () => {
    expect(described).toHaveLength(82);
    expect(() =>
      assertLocalEvidenceSchemaMatches(described, LOCAL_EVIDENCE_PROPERTY_COLUMNS),
    ).not.toThrow();
    expect(() => assertSchemaMatches(described.map((column) => column.column_name))).toThrow(
      /expected 63/,
    );
  });
  it("rejects extra, missing, reordered and wrong-type preview columns", () => {
    expect(() =>
      assertLocalEvidenceSchemaMatches(
        [...described, { column_name: "private_extra", column_type: "VARCHAR" }],
        LOCAL_EVIDENCE_PROPERTY_COLUMNS,
      ),
    ).toThrow();
    expect(() =>
      assertLocalEvidenceSchemaMatches(described.slice(1), LOCAL_EVIDENCE_PROPERTY_COLUMNS),
    ).toThrow();
    expect(() =>
      assertLocalEvidenceSchemaMatches([...described].reverse(), LOCAL_EVIDENCE_PROPERTY_COLUMNS),
    ).toThrow();
    expect(() =>
      assertLocalEvidenceSchemaMatches(
        described.map((column, index) =>
          index === 0 ? { ...column, column_type: "INTEGER" } : column,
        ),
        LOCAL_EVIDENCE_PROPERTY_COLUMNS,
      ),
    ).toThrow();
  });
  it("does not expose unaccepted prior roof/status decisions", () => {
    const names = LOCAL_EVIDENCE_PROPERTY_SAFE_COLUMNS.map((column) => column.name);
    expect(names).toContain("roof_age_caveat");
    expect(names).not.toContain("previous_unaccepted_roof_age_years");
    expect(names).not.toContain("source_export_open_permit_count");
  });
});

describe("assertSchemaMatches", () => {
  it("accepts the published column list", () => {
    expect(() => assertSchemaMatches([...QUERY_TABLE_COLUMN_NAMES])).not.toThrow();
  });

  it("rejects a wrong column count", () => {
    expect(() => assertSchemaMatches(["property_id"])).toThrow(/expected 63/);
  });

  it("rejects a reordered column list", () => {
    const reordered = [...QUERY_TABLE_COLUMN_NAMES];
    [reordered[1], reordered[2]] = [reordered[2] as string, reordered[1] as string];
    expect(() => assertSchemaMatches(reordered)).toThrow(/column 1/);
  });
});

describe("parseSourceSystems", () => {
  it("labels every known token", () => {
    const parsed = parseSourceSystems("fl_dor_nal_2026p|lake_cdplus_permits");
    expect(parsed.map((entry) => entry.token)).toEqual(["fl_dor_nal_2026p", "lake_cdplus_permits"]);
    expect(parsed[0]?.label).toContain("DOR NAL");
  });

  it("returns nothing for a null column", () => {
    expect(parseSourceSystems(null)).toEqual([]);
  });
});
