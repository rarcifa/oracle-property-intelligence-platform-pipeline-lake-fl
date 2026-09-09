/**
 * The `httpfs` cold-start regression.
 *
 * DuckDB resolves extensions under `$HOME/.duckdb/extensions/<version>/<platform>/`.
 * AWS Lambda does not set `HOME`, so in production every request died at
 * `LOAD httpfs` with `IO Error: Can't find the home directory at ''` and the
 * Function URL returned 502 on all four surfaces. It passed locally only
 * because the developer's home directory already held a copy.
 *
 * These tests pin both halves of the fix: the unset-HOME failure is real, and
 * an explicit extension directory survives it.
 */
import { cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveExtensionDirectory, resolveMemoryLimit } from "../src/data/duckdb.js";

/** Directory laid out the way DuckDB expects, holding this platform's httpfs. */
let fixtureDir: string;

beforeAll(async () => {
  // Bootstrap from whatever this machine resolves normally, so the fixture
  // matches the running DuckDB's version and platform instead of hardcoding a
  // pair that drifts on the next upgrade.
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  await connection.run("LOAD httpfs");
  const reader = await connection.run(
    "SELECT install_path, (SELECT platform FROM pragma_platform()) AS platform, version() AS version " +
      "FROM duckdb_extensions() WHERE extension_name = 'httpfs'",
  );
  const [row] = await reader.getRowObjects();
  fixtureDir = path.join(tmpdir(), `oracle-duckdb-ext-${process.pid}`);
  const leaf = path.join(fixtureDir, String(row.version), String(row.platform));
  mkdirSync(leaf, { recursive: true });
  cpSync(String(row.install_path), path.join(leaf, "httpfs.duckdb_extension"));
}, 120_000);

const originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("resolveExtensionDirectory", () => {
  it("returns undefined when unset so a developer machine keeps DuckDB's default", () => {
    expect(resolveExtensionDirectory({})).toBeUndefined();
  });

  it("ignores a blank value rather than pointing DuckDB at the empty path", () => {
    expect(resolveExtensionDirectory({ ORACLE_DUCKDB_EXTENSION_DIR: "   " })).toBeUndefined();
  });

  it("returns a configured directory", () => {
    expect(resolveExtensionDirectory({ ORACLE_DUCKDB_EXTENSION_DIR: "/var/task/x" })).toBe(
      "/var/task/x",
    );
  });
});

describe("LOAD httpfs without HOME (the Lambda environment)", () => {
  it("fails when no extension directory is configured", async () => {
    delete process.env.HOME;
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await expect(connection.run("LOAD httpfs")).rejects.toThrow(/not found|home directory/i);
  }, 60_000);

  it("succeeds when the bundled extension directory is configured", async () => {
    delete process.env.HOME;
    const instance = await DuckDBInstance.create(":memory:", {
      extension_directory: fixtureDir,
    });
    const connection = await instance.connect();
    await connection.run("LOAD httpfs");
    const reader = await connection.run(
      "SELECT count(*) AS n FROM duckdb_extensions() WHERE extension_name = 'httpfs' AND loaded",
    );
    expect(Number((await reader.getRowObjects())[0].n)).toBe(1);
  }, 60_000);
});

describe("resolveMemoryLimit", () => {
  it("defaults to a ceiling well inside the function's 3008 MB", () => {
    expect(resolveMemoryLimit({})).toBe("2GB");
  });

  it("accepts an operator override", () => {
    expect(resolveMemoryLimit({ ORACLE_DUCKDB_MEMORY_LIMIT: "512MB" })).toBe("512MB");
  });

  it("rejects a malformed value rather than interpolating it into SQL", () => {
    // The value is interpolated into `SET memory_limit=...`, so anything that is
    // not a plain size is refused instead of reaching DuckDB.
    expect(() =>
      resolveMemoryLimit({ ORACLE_DUCKDB_MEMORY_LIMIT: "1GB'; DROP TABLE x; --" }),
    ).toThrow(/ORACLE_DUCKDB_MEMORY_LIMIT/);
    expect(() => resolveMemoryLimit({ ORACLE_DUCKDB_MEMORY_LIMIT: "lots" })).toThrow();
  });
});
