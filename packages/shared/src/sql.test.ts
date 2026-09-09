/** Tests for the shared SQL builders and the read-only SQL guard. */
import { describe, expect, it } from "vitest";
import {
  assertReadOnlySql,
  buildCountSql,
  buildCreateViewSql,
  buildDatasetStatsSql,
  buildFacetSql,
  buildPredicates,
  buildPropertyDetailSql,
  buildSearchSql,
  clampLimit,
  MAX_SEARCH_LIMIT,
  quote,
  tableRef,
} from "./sql.js";

describe("literal escaping", () => {
  it("doubles single quotes", () => {
    expect(quote("O'BRIEN")).toBe("'O''BRIEN'");
  });

  it("neutralises an injection attempt in free text", () => {
    const sql = buildSearchSql("properties", { q: "' OR 1=1 --" });
    expect(sql).toContain("'%'' OR 1=1 --%'");
    expect(sql).not.toMatch(/LIKE '%' OR 1=1/);
  });
});

describe("tableRef", () => {
  it("passes a bare identifier through as an identifier", () => {
    expect(tableRef("properties")).toBe("properties");
  });

  it("quotes a filesystem path", () => {
    expect(tableRef("/data/query-table.parquet")).toBe("'/data/query-table.parquet'");
  });

  it("quotes an https gateway url", () => {
    expect(tableRef("https://ipfs.filebase.io/ipfs/bafy/query-table.parquet")).toBe(
      "'https://ipfs.filebase.io/ipfs/bafy/query-table.parquet'",
    );
  });
});

describe("buildPredicates", () => {
  it("returns no predicates for an empty filter set", () => {
    expect(buildPredicates({})).toEqual([]);
  });

  it("builds a roof-age threshold predicate", () => {
    expect(buildPredicates({ minRoofAge: 15 })).toEqual(["roof_age_years >= 15"]);
  });

  it("treats open roofing permits as a count test, not a null test", () => {
    expect(buildPredicates({ hasOpenRoofingPermit: true })).toEqual([
      "coalesce(open_roofing_permit_count, 0) > 0",
    ]);
  });

  it("builds a bounding box plus an exact great-circle test for a radius", () => {
    const predicates = buildPredicates({ lat: 28.55, lon: -81.75, radiusMiles: 3 });
    expect(predicates.some((p) => p.includes("latitude BETWEEN"))).toBe(true);
    expect(predicates.some((p) => p.includes("longitude BETWEEN"))).toBe(true);
    expect(predicates.some((p) => p.includes("asin(sqrt("))).toBe(true);
  });

  it("rejects a partial radius specification", () => {
    expect(() => buildPredicates({ lat: 28.5, radiusMiles: 3 })).toThrow(
      /lat, lon and radiusMiles/,
    );
  });

  it("rejects an out-of-range latitude", () => {
    expect(() => buildPredicates({ lat: 95, lon: 0, radiusMiles: 1 })).toThrow(/Latitude/);
  });

  it("rejects a non-positive radius", () => {
    expect(() => buildPredicates({ lat: 28.5, lon: -81.7, radiusMiles: 0 })).toThrow(/positive/);
  });
});

describe("buildSearchSql", () => {
  it("projects distance_miles and orders by it for a radius search", () => {
    const sql = buildSearchSql("properties", { lat: 28.5, lon: -81.7, radiusMiles: 2 });
    expect(sql).toContain("AS distance_miles");
    expect(sql).toContain("ORDER BY distance_miles ASC");
  });

  it("clamps an oversized limit", () => {
    const sql = buildSearchSql("properties", { limit: 100000 });
    expect(sql).toContain(`LIMIT ${MAX_SEARCH_LIMIT}`);
  });

  it("rejects an unknown sort column", () => {
    expect(() => buildSearchSql("properties", { sortBy: "; DROP TABLE x" })).toThrow(
      /Unknown query-table column/,
    );
  });

  it("accepts a published sort column", () => {
    const sql = buildSearchSql("properties", { sortBy: "roof_age_years", sortDir: "desc" });
    expect(sql).toContain("ORDER BY roof_age_years DESC NULLS LAST");
  });
});

describe("other builders", () => {
  it("counts with the same predicates as the search", () => {
    const filters = { minRoofAge: 20, city: "CLERMONT" };
    const count = buildCountSql("properties", filters);
    const search = buildSearchSql("properties", filters);
    for (const predicate of buildPredicates(filters)) {
      expect(count).toContain(predicate);
      expect(search).toContain(predicate);
    }
  });

  it("looks a parcel up by request_identifier or property_id", () => {
    const sql = buildPropertyDetailSql("properties", "05-18-25-0004-000-00400");
    expect(sql).toContain("request_identifier = '05-18-25-0004-000-00400'");
    expect(sql).toContain("property_id = '05-18-25-0004-000-00400'");
  });

  it("counts contractor and bbb presence in the stats query so nulls are provable", () => {
    const sql = buildDatasetStatsSql("properties");
    expect(sql).toContain("count(contractor_name) AS contractor_names_present");
    expect(sql).toContain("count(bbb_rating) AS bbb_ratings_present");
  });

  it("whitelists the facet column", () => {
    expect(buildFacetSql("properties", "address_city")).toContain("address_city AS value");
    expect(() => buildFacetSql("properties", "evil")).toThrow(/Unknown query-table column/);
  });

  it("builds view DDL against a quoted source", () => {
    expect(buildCreateViewSql("/tmp/query-table.parquet")).toBe(
      "CREATE OR REPLACE VIEW properties AS SELECT * FROM '/tmp/query-table.parquet'",
    );
  });

  it("rejects an unsafe view name", () => {
    expect(() => buildCreateViewSql("/tmp/x.parquet", "a b")).toThrow(/Invalid view name/);
  });
});

describe("clampLimit", () => {
  it("defaults, floors and caps", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(10.7)).toBe(10);
    expect(clampLimit(9999)).toBe(MAX_SEARCH_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(50);
  });
});

describe("assertReadOnlySql", () => {
  const accepted = [
    "SELECT count(*) FROM properties",
    "select * from properties where roof_age_years >= 15 limit 10",
    "WITH aged AS (SELECT * FROM properties WHERE roof_age_years >= 15) SELECT count(*) FROM aged",
    "SELECT address_city, count(*) FROM properties GROUP BY 1 ORDER BY 2 DESC",
    "SELECT * FROM properties WHERE owner_name LIKE '%DROP TABLE%'",
    "SELECT regexp_replace(owner_name, 'X', 'Y') FROM properties",
  ];
  for (const sql of accepted) {
    it(`accepts: ${sql.slice(0, 48)}`, () => {
      expect(assertReadOnlySql(sql)).toBe(sql.trim());
    });
  }

  const rejected: [string, RegExp][] = [
    ["DELETE FROM properties", /read-only/],
    ["INSERT INTO properties VALUES (1)", /read-only/],
    ["SELECT 1; DROP TABLE properties", /single statement/],
    ["SELECT * FROM properties; SELECT 2", /single statement/],
    ["CREATE TABLE t AS SELECT 1", /read-only/],
    ["ATTACH 'x.db'", /read-only/],
    ["INSTALL httpfs", /read-only/],
    ["SELECT * FROM properties -- ok\nUPDATE properties SET x = 1", /update/i],
    ["COPY properties TO 'out.csv'", /read-only/],
    ["PRAGMA database_list", /read-only/],
    ["", /Empty SQL/],
  ];
  for (const [sql, pattern] of rejected) {
    it(`rejects: ${sql.slice(0, 48) || "(empty)"}`, () => {
      expect(() => assertReadOnlySql(sql)).toThrow(pattern);
    });
  }

  it("strips a trailing semicolon rather than rejecting it", () => {
    expect(assertReadOnlySql("SELECT 1;")).toBe("SELECT 1");
  });

  it("cannot be fooled by a mutating keyword hidden in a literal", () => {
    expect(() => assertReadOnlySql("SELECT 'delete from properties' AS s")).not.toThrow();
  });
});
