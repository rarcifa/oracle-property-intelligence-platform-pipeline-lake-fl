/**
 * The single DuckDB data layer.
 *
 * One in-process DuckDB instance opens the published Parquet — a local file in
 * development, or an https IPFS gateway URL in a deployed process — and exposes
 * it as the view `properties`. Every surface of this server (REST, MCP, and the
 * chat agent's tools) goes through this class, so there is exactly one place
 * where SQL meets data and exactly one schema gate.
 */

import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  assertSchemaMatches,
  buildCreateViewSql,
  buildDescribeSql,
  PROPERTIES_VIEW,
} from "@oracle-lake/shared";

/**
 * The directory DuckDB should resolve its extensions from, or `undefined` to
 * leave DuckDB's own default in place.
 *
 * DuckDB looks for extensions under `$HOME/.duckdb/extensions/<version>/<platform>/`.
 * AWS Lambda sets no `HOME`, so that path resolved to `/.duckdb/...`, `LOAD httpfs`
 * failed, the `INSTALL` fallback failed with `Can't find the home directory at ''`,
 * and the Function URL answered 502 on every route. It passed locally only
 * because the developer's home directory already held a copy — `httpfs` is NOT
 * statically linked, despite what an earlier comment here claimed.
 *
 * `httpfs` is therefore a per-platform artefact exactly like the native binding:
 * the deployment bundle ships it and sets this variable. On a developer machine
 * the variable is unset and DuckDB keeps its normal lookup.
 */
export function resolveExtensionDirectory(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const configured = env.ORACLE_DUCKDB_EXTENSION_DIR?.trim();
  return configured ? configured : undefined;
}

/** Accepted `memory_limit` values: a plain number with a unit, nothing else. */
const MEMORY_LIMIT_PATTERN = /^\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB)$/i;

/**
 * Ceiling for DuckDB's memory use, as a `memory_limit` value.
 *
 * `/api/sql` and `/mcp` are public and unauthenticated by design — they serve
 * published open data — and the row count is already clamped, but the *work* a
 * statement does was not bounded at all: `SELECT count(*) FROM range(20000000)`
 * ran on the deployed function in 0.8 s, and a larger one would have spent the
 * whole invocation's memory before returning a single row.
 *
 * The value is interpolated into a `SET` statement, so a malformed override is
 * refused here rather than passed through to DuckDB.
 */
export function resolveMemoryLimit(env: Record<string, string | undefined> = process.env): string {
  const configured = env.ORACLE_DUCKDB_MEMORY_LIMIT?.trim();
  if (configured === undefined || configured.length === 0) return "2GB";
  if (!MEMORY_LIMIT_PATTERN.test(configured)) {
    throw new Error(
      `ORACLE_DUCKDB_MEMORY_LIMIT must be a size such as "2GB", got ${JSON.stringify(configured)}`,
    );
  }
  return configured;
}

/** A row with DuckDB scalars normalised to JSON-safe JavaScript values. */
export type QueryRow = Record<string, unknown>;

/**
 * Normalise one DuckDB scalar.
 *
 * DuckDB returns `bigint` for BIGINT/HUGEINT (which `count(*)` and `sum(...)`
 * produce) and value wrappers for decimals. Both must become plain JSON before
 * they cross an HTTP boundary, and a bigint beyond `Number.MAX_SAFE_INTEGER`
 * becomes a string rather than a silently rounded number.
 */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") {
    const candidate = value as { toString?: () => string };
    if (typeof candidate.toString === "function") {
      const text = candidate.toString();
      if (text !== "[object Object]") {
        const asNumber = Number(text);
        return Number.isFinite(asNumber) && text.trim() !== "" ? asNumber : text;
      }
    }
    const out: QueryRow = {};
    for (const [key, nested] of Object.entries(value as QueryRow)) {
      out[key] = normalizeValue(nested);
    }
    return out;
  }
  return null;
}

/** Normalise a whole result set. */
export function normalizeRows(rows: readonly QueryRow[]): QueryRow[] {
  return rows.map((row) => {
    const out: QueryRow = {};
    for (const [key, value] of Object.entries(row)) out[key] = normalizeValue(value);
    return out;
  });
}

export interface DataStoreOptions {
  /** Parquet path or https URL. */
  source: string;
  /** Skip the 59-column schema gate. Only used by fixture-backed tests. */
  skipSchemaCheck?: boolean;
}

export class OracleDataStore {
  readonly source: string;

  readonly sourceKind: "ipfs" | "local";

  #instance: DuckDBInstance | null = null;

  #connection: DuckDBConnection | null = null;

  #ready: Promise<void> | null = null;

  readonly #skipSchemaCheck: boolean;

  constructor(options: DataStoreOptions) {
    if (!options.source || options.source.length === 0) {
      throw new Error(
        "No Parquet source configured. Set ORACLE_PARQUET_PATH or ORACLE_PARQUET_URL, or publish a run locally.",
      );
    }
    this.source = options.source;
    this.sourceKind = /^https?:\/\//.test(options.source) ? "ipfs" : "local";
    this.#skipSchemaCheck = options.skipSchemaCheck === true;
  }

  /** Open the database and register the `properties` view. Idempotent. */
  async init(): Promise<void> {
    this.#ready ??= this.#open();
    return this.#ready;
  }

  async #open(): Promise<void> {
    const extensionDirectory = resolveExtensionDirectory();
    const instance = await DuckDBInstance.create(
      ":memory:",
      extensionDirectory === undefined ? {} : { extension_directory: extensionDirectory },
    );
    const connection = await instance.connect();
    this.#instance = instance;
    this.#connection = connection;

    if (this.sourceKind === "ipfs") {
      // httpfs gives DuckDB HTTP Range reads over the gateway. It is not
      // statically linked, so it must already be on disk. When the bundle has
      // shipped it, say so plainly instead of falling through to an INSTALL
      // that cannot work: /var/task is read-only and a deployed cold start must
      // not depend on reaching extensions.duckdb.org.
      try {
        await connection.run("LOAD httpfs");
      } catch (cause) {
        if (extensionDirectory !== undefined) {
          throw new Error(
            `LOAD httpfs failed from ${extensionDirectory}. The deployment bundle must ship ` +
              "the httpfs extension for this DuckDB version and platform; rebuild it.",
            { cause },
          );
        }
        await connection.run("INSTALL httpfs");
        await connection.run("LOAD httpfs");
      }
    }

    // The dataset is MATERIALISED into memory, not left as a lazy view over the
    // source file, so that external access can be switched off immediately
    // afterwards. A lazy view would need filesystem access on every query and
    // would force the lockdown below to stay open.
    await connection.run(
      buildCreateViewSql(this.source, PROPERTIES_VIEW).replace(
        `CREATE OR REPLACE VIEW ${PROPERTIES_VIEW} AS`,
        `CREATE OR REPLACE TABLE ${PROPERTIES_VIEW} AS`,
      ),
    );

    // Bound the work any one statement may do. This sits before the lockdown
    // because `lock_configuration` freezes the configuration immediately after.
    await connection.run(`SET memory_limit='${resolveMemoryLimit()}'`);
    // No spilling. /var/task is read-only, so a statement that exceeds the
    // ceiling otherwise fails with "Failed to create directory .tmp: Read-only
    // file system", which reads like a deployment fault rather than the query
    // being too big. Disabling the temp directory makes it fail as what it is.
    await connection.run("SET temp_directory=''");

    // Second layer of the SQL lockdown; the first is the filesystem-function
    // denylist in `assertReadOnlySql`. Without this, `/api/sql` and `/mcp` are
    // an unauthenticated arbitrary-file-read primitive against the host: before
    // it existed, `read_text('/etc/passwd')` and `glob()` both answered. Once
    // the data is in memory nothing needs the filesystem or the network, so
    // both are closed and the configuration is locked so a later statement
    // cannot reopen them.
    await connection.run("SET enable_external_access=false");
    await connection.run("SET lock_configuration=true");

    if (!this.#skipSchemaCheck) {
      const described = await this.query(buildDescribeSql(PROPERTIES_VIEW));
      assertSchemaMatches(described.map((row) => String(row.column_name)));
    }
  }

  /** Run a statement and return normalised rows. */
  async query(sql: string): Promise<QueryRow[]> {
    if (this.#connection === null) {
      await this.init();
    }
    const connection = this.#connection;
    if (connection === null) throw new Error("DuckDB connection is not open");
    const reader = await connection.runAndReadAll(sql);
    return normalizeRows(reader.getRowObjects());
  }

  /** Run a statement expected to produce exactly one row. */
  async queryOne(sql: string): Promise<QueryRow | null> {
    const rows = await this.query(sql);
    return rows[0] ?? null;
  }

  /** Read a single scalar from a one-row, one-column query. */
  async queryScalar(sql: string): Promise<unknown> {
    const row = await this.queryOne(sql);
    if (row === null) return null;
    const values = Object.values(row);
    return values.length > 0 ? values[0] : null;
  }

  /** Release the connection. */
  close(): void {
    this.#connection?.closeSync();
    this.#connection = null;
    this.#instance?.closeSync();
    this.#instance = null;
    this.#ready = null;
  }
}
