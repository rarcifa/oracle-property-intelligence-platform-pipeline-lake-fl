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
} from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeSchemaPath = resolve(
  here,
  "../../../.claude/skills/use-oracle/runtime/src/counties/lake/query-table.mjs",
);

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
  it("declares 59 columns", () => {
    expect(QUERY_TABLE_COLUMN_COUNT).toBe(59);
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

describe("assertSchemaMatches", () => {
  it("accepts the published column list", () => {
    expect(() => assertSchemaMatches([...QUERY_TABLE_COLUMN_NAMES])).not.toThrow();
  });

  it("rejects a wrong column count", () => {
    expect(() => assertSchemaMatches(["property_id"])).toThrow(/expected 59/);
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
