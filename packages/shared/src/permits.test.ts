import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertPermitSchemaMatches,
  buildEmptyPermitTableSql,
  PERMIT_TABLE_COLUMN_NAMES,
  PERMIT_TABLE_COLUMNS,
} from "./permits.js";
import { buildPropertyPermitsSql, PERMITS_VIEW } from "./sql.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeSchemaPath = resolve(here, "../../../pipeline/src/counties/lake/permit-table.mjs");

function readRuntimeColumns(): string[] {
  const source = readFileSync(runtimeSchemaPath, "utf8");
  const start = source.indexOf("LAKE_PERMIT_TABLE_SCHEMA_FIELDS = Object.freeze({");
  if (start < 0) throw new Error("Could not locate LAKE_PERMIT_TABLE_SCHEMA_FIELDS");
  const end = source.indexOf("});", start);
  return [...source.slice(start, end).matchAll(/^\s{2}([a-z0-9_]+):\s*\{/gm)].map(
    (match) => match[1] as string,
  );
}

describe("permit-table schema", () => {
  it("matches the ingestion runtime exactly", () => {
    expect(PERMIT_TABLE_COLUMN_NAMES).toEqual(readRuntimeColumns());
    expect(PERMIT_TABLE_COLUMNS).toHaveLength(22);
  });

  it("fails closed on missing or reordered columns", () => {
    expect(() => assertPermitSchemaMatches(PERMIT_TABLE_COLUMN_NAMES)).not.toThrow();
    expect(() => assertPermitSchemaMatches(["permit_id"])).toThrow(/expected 22/);
    const reordered = [...PERMIT_TABLE_COLUMN_NAMES];
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    expect(() => assertPermitSchemaMatches(reordered)).toThrow(/column 0/);
  });

  it("builds a typed empty legacy table", () => {
    const sql = buildEmptyPermitTableSql(PERMITS_VIEW);
    expect(sql).toContain("CREATE OR REPLACE TABLE permits");
    expect(sql).toContain("CAST(NULL AS VARCHAR) AS permit_id");
    expect(sql).toContain("WHERE FALSE");
  });

  it("builds a bounded parcel query with escaped input", () => {
    const sql = buildPropertyPermitsSql(PERMITS_VIEW, "parcel'one", 10);
    expect(sql).toContain("FROM permits");
    expect(sql).toContain("parcel_identifier = 'parcel''one'");
    expect(sql).toContain("LIMIT 10");
  });
});
