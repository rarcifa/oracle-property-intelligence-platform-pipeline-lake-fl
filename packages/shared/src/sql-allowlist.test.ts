/**
 * The read-only guard, as an allowlist.
 *
 * It was an enumerated denylist and it failed three times in a row, each time
 * the same way: something nobody had thought to list. `duckdb_settings()` was
 * blocked while `"duckdb_settings"()` was not; then the whole `duckdb_*` family
 * beyond two entries; then `current_setting`, which handed anonymous callers a
 * live AWS session token. A list of what is forbidden can only ever be as
 * complete as the last person's imagination.
 *
 * These tests pin the inversion: unknown functions are refused by default, and
 * the scanner reads quotes the way the engine does.
 */
import { describe, expect, it } from "vitest";
import { assertReadOnlySql } from "./sql.js";

const allowed = (sql: string) => expect(() => assertReadOnlySql(sql)).not.toThrow();
const refused = (sql: string) => expect(() => assertReadOnlySql(sql)).toThrow();

describe("allowlisted analytics still works", () => {
  it("permits the shapes the product actually issues", () => {
    allowed("SELECT count(*) FROM properties");
    allowed("SELECT address_city, count(*) AS n FROM properties GROUP BY 1 ORDER BY n DESC");
    allowed("SELECT sum(coalesce(permit_count, 0)) AS n FROM properties");
    allowed("SELECT upper(trim(owner_name)) AS o FROM properties WHERE roof_age_years >= 15");
    allowed(
      "WITH aged AS (SELECT * FROM properties WHERE roof_age_years >= 20) SELECT count(*) FROM aged",
    );
    allowed("SELECT round(avg(market_value), 2) FROM properties");
    allowed('SELECT * FROM "properties" WHERE "address_city" = \'CLERMONT\' LIMIT 5');
    allowed("SELECT count(*) FILTER (WHERE open_roofing_permit_count > 0) FROM properties");
  });
});

describe("configuration and filesystem access is refused by default", () => {
  it("refuses the call that leaked AWS credentials", () => {
    refused("SELECT current_setting('s3_access_key_id')");
    refused("SELECT current_setting('extension_directory')");
  });

  it("refuses the introspection family in every spelling", () => {
    refused("SELECT * FROM duckdb_settings()");
    refused('SELECT * FROM "duckdb_settings"()');
    refused("SELECT * FROM `duckdb_settings`()");
    refused("SELECT * FROM duckdb_variables()");
    refused("SELECT * FROM duckdb_functions()");
    refused("SELECT * FROM duckdb_secrets()");
  });

  it("refuses filesystem readers", () => {
    refused("SELECT * FROM read_text('/etc/passwd')");
    refused(`SELECT * FROM "read_csv_auto"('/etc/passwd')`);
    refused("SELECT * FROM glob('/var/task/*')");
  });

  it("is not fooled by an apostrophe inside a quoted identifier", () => {
    // This desynchronised the old scrubber: the single-quote literal rule ran
    // across a double-quoted identifier and swallowed the rest of the statement.
    refused(`SELECT "it's"(), current_setting('extension_directory')`);
    refused(`SELECT * FROM "a'b"(), duckdb_settings()`);
  });

  it("refuses a function nobody has thought about, because it is not listed", () => {
    refused("SELECT some_future_duckdb_function('x')");
    refused("SELECT pg_read_file('/etc/passwd')");
  });
});

describe("write and multi-statement rules still hold", () => {
  it("refuses mutation and stacking", () => {
    refused("DROP TABLE properties");
    refused("SELECT 1; SELECT 2");
    refused("COPY properties TO '/tmp/x.csv'");
    refused("ATTACH 'x.db'");
    refused("INSTALL httpfs");
  });
});
