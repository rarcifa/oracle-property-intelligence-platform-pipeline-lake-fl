/**
 * The public SQL surface bounds what it RETURNS. It must also bound what it
 * RUNS.
 *
 * `/api/sql` and `/mcp` are unauthenticated by design — they serve published
 * open data — and the row cap was applied in JavaScript after the statement had
 * already produced every row. `SELECT * FROM properties` therefore materialised
 * all 215,806 rows into the function's heap to return 200 of them.
 */
import { describe, expect, it } from "vitest";
import { boundStatement } from "./sql.js";

describe("boundStatement", () => {
  it("wraps a plain select so DuckDB stops early", () => {
    const bounded = boundStatement("SELECT * FROM properties", 200);
    expect(bounded).toMatch(/LIMIT 201/);
    expect(bounded).toContain("SELECT * FROM properties");
  });

  it("asks for one more row than the cap, so truncation is detectable", () => {
    expect(boundStatement("SELECT 1", 5)).toMatch(/LIMIT 6/);
  });

  it("bounds a CTE, which is the other statement shape the guard allows", () => {
    const bounded = boundStatement("WITH x AS (SELECT 1 AS n) SELECT * FROM x", 10);
    expect(bounded).toMatch(/LIMIT 11/);
    expect(bounded).toContain("WITH x AS");
  });

  it("keeps an inner LIMIT, which still wins when it is smaller", () => {
    const bounded = boundStatement("SELECT * FROM properties LIMIT 5", 200);
    expect(bounded).toContain("LIMIT 5");
    expect(bounded).toMatch(/LIMIT 201/);
  });

  it("strips a trailing semicolon rather than producing invalid SQL", () => {
    expect(boundStatement("SELECT 1;", 3)).not.toContain(";)");
  });
});
