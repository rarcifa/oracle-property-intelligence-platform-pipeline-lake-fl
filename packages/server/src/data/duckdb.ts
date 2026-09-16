/**
 * The single DuckDB data layer.
 *
 * One in-process DuckDB instance opens the published Parquet — a local file in
 * development, or an https IPFS gateway URL in a deployed process — and exposes
 * it as the view `properties`. Every surface of this server (REST, MCP, and the
 * chat agent's tools) goes through this class, so there is exactly one place
 * where SQL meets data and exactly one schema gate.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  assertPermitSchemaMatches,
  assertSchemaMatches,
  assertLocalEvidenceSchemaMatches,
  LOCAL_EVIDENCE_CONTRACT_VERSION,
  LOCAL_EVIDENCE_PROPERTY_COLUMNS,
  LOCAL_EVIDENCE_PROPERTY_SAFE_COLUMNS,
  LOCAL_EVIDENCE_PERMIT_COLUMNS,
  LOCAL_EVIDENCE_PERMIT_SAFE_COLUMNS,
  quote,
  buildEmptyPermitTableSql,
  buildCreateViewSql,
  buildDescribeSql,
  gatewayOf,
  parquetArtifactCandidates,
  parquetCandidates,
  PERMITS_VIEW,
  PROPERTIES_VIEW,
  BUSINESSES_VIEW,
  assertBusinessSchemaMatches,
  buildEmptyBusinessTableSql,
} from "@oracle-lake/shared";
import { isLocalParquetPath } from "../config.js";

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

/**
 * The run root CID inside a gateway URL, or null.
 *
 * Used to rebuild the same artifact's URL on a different gateway: the CID is the
 * source of truth, the host in front of it is only transport.
 */
export function rootCidOf(url: string): string | null {
  return /\/ipfs\/(ba[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})(?:\/|$)/.exec(url)?.[1] ?? null;
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
  /** Optional permit Parquet override. `null` deliberately disables it. */
  permitSource?: string | null;
  /** Optional account-grain TPP artifact. Null deliberately disables it. */
  businessSource?: string | null;
  /** Skip the published-schema column gate. Only used by fixture-backed tests. */
  skipSchemaCheck?: boolean;
  /** Closed opt-in compatibility mode, restricted to local unaccepted artifacts. */
  localEvidencePreview?: boolean;
  /** Derivative calculation year, not an accepted live-status/freshness clock. */
  localEvidenceAsOfYear?: number;
}

export class OracleDataStore {
  readonly source: string;

  readonly sourceKind: "ipfs" | "local";

  readonly permitSource: string | null;
  readonly businessSource: string | null;
  readonly localEvidencePreview: boolean;
  readonly localEvidenceAsOfYear: number | null;
  /** Detected from the immutable account/property artifact, not an approval override. */
  sourceObservationsOnly = false;

  /** True only when a real `permit-table.parquet` was opened and gated. */
  permitsAvailable = false;
  businessesAvailable = false;

  #instance: DuckDBInstance | null = null;
  /** The URL that actually served the table, which may not be `source`. */
  activeSource: string | null = null;

  activePermitSource: string | null = null;
  activeBusinessSource: string | null = null;

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
    this.localEvidencePreview = options.localEvidencePreview === true;
    this.localEvidenceAsOfYear = this.localEvidencePreview
      ? (options.localEvidenceAsOfYear ?? null)
      : null;
    if (
      this.localEvidencePreview &&
      (options.skipSchemaCheck ||
        !isLocalParquetPath(options.source) ||
        !options.permitSource ||
        !isLocalParquetPath(options.permitSource))
    ) {
      throw new Error(
        "Local evidence preview requires explicit local property/permit files and the closed schema gate",
      );
    }
    if (
      this.localEvidencePreview &&
      (process.env.AWS_LAMBDA_FUNCTION_NAME ||
        process.env.AWS_EXECUTION_ENV ||
        process.env.LAMBDA_TASK_ROOT)
    ) {
      throw new Error("Local evidence preview is unavailable in Lambda");
    }
    if (
      this.localEvidencePreview &&
      (!Number.isInteger(this.localEvidenceAsOfYear) ||
        (this.localEvidenceAsOfYear ?? 0) < 1700 ||
        (this.localEvidenceAsOfYear ?? 0) > 2199)
    ) {
      throw new Error("Local evidence preview requires the derivative's explicit as-of year");
    }
    this.sourceKind = /^https?:\/\//.test(options.source) ? "ipfs" : "local";
    this.permitSource =
      options.permitSource === undefined
        ? inferPermitSource(options.source, this.sourceKind)
        : options.permitSource;
    this.businessSource =
      options.businessSource === undefined
        ? inferBusinessSource(options.source, this.sourceKind)
        : options.businessSource;
    if (
      this.localEvidencePreview &&
      this.businessSource &&
      !isLocalParquetPath(this.businessSource)
    ) {
      throw new Error("Local evidence preview requires a local business artifact");
    }
    this.#skipSchemaCheck = options.skipSchemaCheck === true;
  }

  /** Open the database and register the `properties` view. Idempotent. */
  async init(): Promise<void> {
    // Never cache a failure. `??=` stores the promise, and a rejected promise is
    // still a promise: one transient gateway failure at cold start left every
    // later call on this instance awaiting the same stored rejection, and a warm
    // Lambda container can serve that for minutes. Clearing the slot on
    // rejection makes the next call a real attempt.
    this.#ready ??= this.#open().catch((error: unknown) => {
      this.close();
      if (this.localEvidencePreview)
        throw new Error("Local evidence preview failed its read-only schema or eligibility checks");
      throw error;
    });
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

    if (this.localEvidencePreview) {
      await this.#openLocalEvidence(connection);
    } else {
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
      //
      // Read over several gateways rather than one. Pinning `ipfs.filebase.io` —
      // the vendor that also pins the data — made the runtime depend on a single
      // account, against this project's own rule that a vendor URL is not the
      // source of truth. The CID is; every candidate below asks for the same CID.
      const rootCid = this.sourceKind === "ipfs" ? rootCidOf(this.source) : null;
      const candidates = rootCid === null ? [this.source] : parquetCandidates(rootCid, this.source);

      const failures: string[] = [];
      let opened: string | null = null;
      for (const candidate of candidates) {
        try {
          await connection.run(
            buildCreateViewSql(candidate, PROPERTIES_VIEW).replace(
              `CREATE OR REPLACE VIEW ${PROPERTIES_VIEW} AS`,
              `CREATE OR REPLACE TABLE ${PROPERTIES_VIEW} AS`,
            ),
          );
          opened = candidate;
          break;
        } catch (error) {
          failures.push(
            `${gatewayOf(candidate)?.id ?? candidate}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
          );
        }
      }
      if (opened === null) {
        throw new Error(
          `No IPFS gateway served the published table. Tried ${candidates.length}: ${failures.join("; ")}`,
        );
      }
      this.activeSource = opened;

      // A separate permit-grain artifact preserves every available permit,
      // including records that do not join the assessed parcel roll. Legacy
      // publications predate it; those open an empty typed table and report
      // permitsAvailable=false instead of making the property surface unusable.
      if (this.permitSource !== null) {
        const permitCandidates =
          this.sourceKind === "ipfs" && rootCid !== null
            ? parquetArtifactCandidates(rootCid, "permit-table.parquet", this.permitSource)
            : [this.permitSource];
        for (const candidate of permitCandidates) {
          try {
            await connection.run(
              buildCreateViewSql(candidate, PERMITS_VIEW).replace(
                `CREATE OR REPLACE VIEW ${PERMITS_VIEW} AS`,
                `CREATE OR REPLACE TABLE ${PERMITS_VIEW} AS`,
              ),
            );
            this.activePermitSource = candidate;
            this.permitsAvailable = true;
            break;
          } catch {
            // Keep trying transports for the same immutable artifact.
          }
        }
      }
      if (!this.permitsAvailable) {
        await connection.run(buildEmptyPermitTableSql(PERMITS_VIEW));
      }
    }

    // Optional account-grain records retain unmatched businesses. A missing
    // legacy artifact is unavailable, not a claim that there are zero accounts.
    if (this.businessSource !== null) {
      const rootCid = this.sourceKind === "ipfs" ? rootCidOf(this.source) : null;
      const businessCandidates =
        rootCid === null
          ? [this.businessSource]
          : parquetArtifactCandidates(rootCid, "business-table.parquet", this.businessSource);
      for (const candidate of businessCandidates) {
        try {
          await connection.run(
            `CREATE OR REPLACE TABLE ${BUSINESSES_VIEW} AS SELECT * FROM read_parquet(${quote(candidate)})`,
          );
        } catch {
          continue;
        }
        const description = await connection.runAndReadAll(`DESCRIBE ${BUSINESSES_VIEW}`);
        assertBusinessSchemaMatches(
          description.getRowObjects().map((row) => ({
            column_name: String(row.column_name),
            column_type: String(row.column_type),
          })),
        );
        const gate = await connection.runAndReadAll(`SELECT count(*) AS rows,
          count(DISTINCT business_id) AS identities,
          count(*) FILTER (WHERE business_id IS NULL OR account_id IS NULL OR trim(account_id) = ''
            OR business_id IS DISTINCT FROM 'lake:fl_dor_tpp:' || account_id
            OR county IS DISTINCT FROM 'lake' OR matched_parcel_count IS NULL OR matched_parcel_count < 0) AS invalid
          FROM ${BUSINESSES_VIEW}`);
        const checked = gate.getRowObjects()[0];
        if (
          !checked ||
          Number(checked.rows) !== Number(checked.identities) ||
          Number(checked.invalid) !== 0
        ) {
          throw new Error(
            "Business account identities or parcel-match counts failed reconciliation",
          );
        }
        this.activeBusinessSource = candidate;
        this.businessesAvailable = true;
        break;
      }
    }
    if (!this.businessesAvailable) await connection.run(buildEmptyBusinessTableSql());

    // Take the AWS credentials away from DuckDB before anything can read them.
    //
    // httpfs picks up the Lambda's execution-role credentials from the standard
    // AWS_* environment variables, and `/api/sql` is public and unauthenticated:
    // `current_setting('s3_access_key_id')` returned a live STS key, a 40-char
    // secret and a 1,160-char session token to anonymous callers. The SQL guard
    // is supposed to stop that and its denylist did not, so the credentials do
    // not stay in the session waiting for the next gap in it — the published
    // data is read over public HTTPS gateways and needs no AWS identity at all.
    for (const setting of [
      "s3_access_key_id",
      "s3_secret_access_key",
      "s3_session_token",
      "s3_region",
      "s3_endpoint",
    ]) {
      await connection.run(`SET ${setting}=''`);
    }

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

    if (!this.#skipSchemaCheck && !this.localEvidencePreview) {
      const described = await this.query(buildDescribeSql(PROPERTIES_VIEW));
      assertSchemaMatches(described.map((row) => String(row.column_name)));
      const permitDescription = await this.query(buildDescribeSql(PERMITS_VIEW));
      assertPermitSchemaMatches(permitDescription.map((row) => String(row.column_name)));
      const mode = await this.queryOne(`SELECT count(*) AS rows,
        count(*) FILTER (WHERE ';' || coalesce(enrichment_status, '') || ';' LIKE '%;source_observations_only;%') AS source_only_rows
        FROM ${PROPERTIES_VIEW}`);
      const sourceOnlyRows = Number(mode?.source_only_rows ?? 0);
      if (sourceOnlyRows > 0 && sourceOnlyRows !== Number(mode?.rows))
        throw new Error("Mixed source-only and decision-enabled property rows are unsupported");
      this.sourceObservationsOnly = sourceOnlyRows > 0;
      if (this.sourceObservationsOnly) {
        const heldProperties = [
          "roof_last_permit_date",
          "roofing_permit_count",
          "open_permit_count",
          "open_roofing_permit_count",
          "longest_open_permit_days",
          "longest_open_roofing_permit_days",
          "bbb_rating",
          "has_bbb_contractor",
          "has_sunbiz_tenant",
        ];
        const heldPermits = [
          "completed_date",
          "is_roofing",
          "is_open",
          "days_open",
          "contractor_license",
          "bbb_rating",
        ];
        for (const [table, held] of [
          [PROPERTIES_VIEW, heldProperties],
          [PERMITS_VIEW, heldPermits],
        ] as const) {
          if (
            Number(
              await this.queryScalar(
                `SELECT count(*) FROM ${table} WHERE ${held.map((name) => `${name} IS NOT NULL`).join(" OR ")}`,
              ),
            ) !== 0
          )
            throw new Error("Source-only artifact attempted to promote unsupported decisions");
        }
      }
    }
  }

  /** Source raw columns never become a table/view queryable by REST, MCP or SQL. */
  async #openLocalEvidence(connection: DuckDBConnection): Promise<void> {
    const permitSource = this.permitSource;
    if (!permitSource || !statSync(this.source).isFile() || !statSync(permitSource).isFile()) {
      throw new Error("Preview inputs must be regular local files");
    }
    const inputs = [
      {
        source: this.source,
        table: PROPERTIES_VIEW,
        expected: LOCAL_EVIDENCE_PROPERTY_COLUMNS,
        safe: LOCAL_EVIDENCE_PROPERTY_SAFE_COLUMNS,
      },
      {
        source: permitSource,
        table: PERMITS_VIEW,
        expected: LOCAL_EVIDENCE_PERMIT_COLUMNS,
        safe: LOCAL_EVIDENCE_PERMIT_SAFE_COLUMNS,
      },
    ];
    for (const input of inputs) {
      const description = await connection.runAndReadAll(
        `DESCRIBE SELECT * FROM read_parquet(${quote(input.source)})`,
      );
      const described = description.getRowObjects().map((row) => ({
        column_name: String(row.column_name),
        column_type: String(row.column_type),
      }));
      assertLocalEvidenceSchemaMatches(described, input.expected);
    }

    const propertyHolds = [
      "property_cid",
      "roof_last_permit_date",
      "roofing_permit_count",
      "open_permit_count",
      "open_roofing_permit_count",
      "longest_open_permit_days",
      "longest_open_roofing_permit_days",
      "contractor_company_id",
      "accepted_primary_roof_permit_count",
      "bbb_rating",
      "has_bbb_contractor",
      "has_sunbiz_tenant",
    ];
    const permitHolds = [
      "is_open",
      "is_roofing",
      "days_open",
      "completed_date",
      "contractor_license",
      "bbb_rating",
      "current_permit_status",
      "contractor_company_id",
      "accepted_primary_roof_work_class",
      "accepted_roof_anchor_date",
      "permit_printed_license",
      "observation_time",
    ];
    const propertyInvalid = `${propertyHolds.map((name) => `${name} IS NOT NULL`).join(" OR ")}
      OR evidence_contract_version IS DISTINCT FROM ${quote(LOCAL_EVIDENCE_CONTRACT_VERSION)}
      OR (roof_age_years IS NOT NULL AND (roof_age_years < 0 OR roof_age_years <> ${this.localEvidenceAsOfYear} - built_year OR roof_age_basis IS DISTINCT FROM 'built_year_proxy' OR roof_age_confidence IS DISTINCT FROM 'low' OR roof_age_decision IS DISTINCT FROM 'eligible_proxy' OR built_year_evidence_state IS DISTINCT FROM 'confirmed_present' OR built_year IS NULL OR built_year < 1700 OR built_year > ${this.localEvidenceAsOfYear}))
      OR (roof_age_years IS NULL AND (roof_age_basis IS NOT NULL OR roof_age_confidence IS NOT NULL OR roof_age_decision IS DISTINCT FROM 'needs_review'))
      OR nullif(trim(roof_age_caveat), '') IS NULL
      OR contractor_attribution_kind IS DISTINCT FROM 'source_display_name_only; not a verified legal company identity'`;
    const permitInvalid = `${permitHolds.map((name) => `${name} IS NOT NULL`).join(" OR ")}
      OR evidence_contract_version IS DISTINCT FROM ${quote(LOCAL_EVIDENCE_CONTRACT_VERSION)}
      OR decisions_outcome IS DISTINCT FROM 'needs_review'
      OR status_basis IS DISTINCT FROM 'captured_observation_only; not live/current'`;
    for (const [source, invalid] of [
      [this.source, propertyInvalid],
      [permitSource, permitInvalid],
    ]) {
      const checked = await connection.runAndReadAll(
        `SELECT count(*) AS violations FROM read_parquet(${quote(source as string)}) WHERE ${invalid}`,
      );
      if (Number(checked.getRowObjects()[0]?.violations) !== 0) {
        throw new Error("Preview attempted to enable unaccepted conclusions");
      }
    }
    for (const input of inputs) {
      const columns = input.safe
        .map((column) => {
          const cast =
            input.table === PERMITS_VIEW &&
            ["applied_date", "approved_date", "issued_date", "last_modified_date"].includes(
              column.name,
            );
          return cast ? `CAST(${column.name} AS VARCHAR) AS ${column.name}` : column.name;
        })
        .join(", ");
      await connection.run(
        `CREATE TABLE ${input.table} AS SELECT ${columns} FROM read_parquet(${quote(input.source)})`,
      );
    }
    this.activeSource = this.source;
    this.activePermitSource = permitSource;
    this.permitsAvailable = true;
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
    this.activeSource = null;
    this.activePermitSource = null;
    this.permitsAvailable = false;
    this.activeBusinessSource = null;
    this.businessesAvailable = false;
    this.sourceObservationsOnly = false;
  }
}

/** Infer the sibling permit artifact without making the caller know layout. */
export function inferPermitSource(source: string, sourceKind: "ipfs" | "local"): string | null {
  if (sourceKind === "local") {
    const candidate = resolve(dirname(source), "permit-table.parquet");
    return existsSync(candidate) ? candidate : null;
  }
  try {
    const url = new URL(source);
    url.pathname = url.pathname.replace(/query-table\.parquet$/, "permit-table.parquet");
    return url.toString();
  } catch {
    return null;
  }
}

/** Optional sibling account table; older immutable releases predate it. */
export function inferBusinessSource(source: string, sourceKind: "ipfs" | "local"): string | null {
  if (sourceKind === "local") {
    const candidate = resolve(dirname(source), "business-table.parquet");
    return existsSync(candidate) ? candidate : null;
  }
  try {
    const url = new URL(source);
    if (!url.pathname.endsWith("query-table.parquet")) return null;
    url.pathname = url.pathname.replace(/query-table\.parquet$/, "business-table.parquet");
    return url.toString();
  } catch {
    return null;
  }
}
