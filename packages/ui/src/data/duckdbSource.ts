/**
 * `DataSource` implementation that runs DuckDB-WASM inside the browser tab and
 * range-reads the published Parquet straight off IPFS.
 *
 * The bootstrap is the standard duckdb-wasm browser path: pick a jsDelivr
 * bundle for this browser, start the worker from a blob URL, instantiate, then
 * `registerFileURL(..., DuckDBDataProtocol.HTTP, false)` so DuckDB issues HTTP
 * Range requests for the Parquet footer and only the row groups a query needs.
 * `ipfs.filebase.io` is the one gateway measured to support both CORS and
 * Range, which is why `parquetUrl()` points there.
 *
 * Every query is built with the same `build*Sql` helpers the server uses, so a
 * browser answer and a server answer are the same SQL over the same bytes and
 * cannot disagree. Initialisation is time-boxed; on any failure the provider
 * fails over to the REST source and shows the reason.
 */

import * as duckdb from "@duckdb/duckdb-wasm";
import type { Table } from "apache-arrow";
import {
  assertReadOnlySql,
  assertSchemaMatches,
  buildBusinessByCitySql,
  buildBusinessByTypeSql,
  buildCountSql,
  buildCreateViewSql,
  buildDatasetStatsSql,
  buildDescribeSql,
  buildFacetSql,
  buildOwnerPostureSql,
  buildPermitPostureSql,
  buildPropertyDetailSql,
  buildRoofAgeBandsSql,
  buildSearchSql,
  clampLimit,
  COUNTY,
  parseEnrichmentStatus,
  parquetUrl,
  parseSourceSystems,
  PROPERTIES_VIEW,
  SOURCE_SYSTEM_LABELS,
  type PropertyDetailResponse,
  type ResponseProvenance,
  type SearchOptions,
  type SearchResponse,
} from "@oracle-lake/shared";
import { numberCell, rowToNumberRecord, stringCell, tableToRows } from "./arrow.js";
import { BUSINESS_VIEW_NOTE, CONTRACTOR_VIEW_NOTE, GATED_ENRICHMENT_TOKENS } from "../lib/notes.js";
import {
  DataSourceError,
  type BusinessByCity,
  type BusinessByType,
  type BusinessViewResponse,
  type ContractorViewResponse,
  type DataSource,
  type FacetValue,
  type FacetsResponse,
  type RoofAgeBand,
  type SqlResponse,
  type StatsResponse,
  type TenantViewResponse,
} from "./types.js";

/** The name the Parquet is registered under inside the WASM filesystem. */
const REGISTERED_FILE = "query-table.parquet";

/** How long the whole bootstrap gets before we fail over to the server. */
export const DUCKDB_INIT_TIMEOUT_MS = 20_000;

/** Every source system the published table draws on, for aggregate provenance. */
const ALL_SOURCE_SYSTEMS = Object.keys(SOURCE_SYSTEM_LABELS);

/** A browser data source also owns a worker, so it can be shut down. */
export interface BrowserDataSource extends DataSource {
  /** The exact gateway URL DuckDB is range-reading. */
  readonly parquetUrl: string;
  close(): Promise<void>;
}

/** Reject if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Distinct `source_systems` tokens present in a result set. */
function sourceSystemsOf(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row.source_systems;
    if (typeof value !== "string") continue;
    for (const entry of parseSourceSystems(value)) seen.add(entry.token);
  }
  return seen.size > 0 ? [...seen].sort() : [...ALL_SOURCE_SYSTEMS];
}

/** Map a raw band row onto the documented `RoofAgeBand` shape. */
function toRoofAgeBand(row: Record<string, unknown>): RoofAgeBand {
  return {
    band: stringCell(row, "band") ?? "unknown",
    properties: numberCell(row, "properties"),
    from_completed_permit: numberCell(row, "from_completed_permit"),
    from_issued_permit: numberCell(row, "from_issued_permit"),
    from_year_built: numberCell(row, "from_year_built"),
  };
}

/** Map a raw facet row onto `{ value, count }`. */
function toFacetValues(rows: readonly Record<string, unknown>[]): FacetValue[] {
  const out: FacetValue[] = [];
  for (const row of rows) {
    const value = stringCell(row, "value");
    if (value === null || value.trim().length === 0) continue;
    out.push({ value, count: numberCell(row, "count") });
  }
  return out;
}

/**
 * Boot DuckDB-WASM, attach the published Parquet over HTTP, and verify that the
 * table really carries the published schema before returning a usable source.
 */
export async function createDuckDbSource(options: {
  rootCid: string;
  runId: string | null;
  timeoutMs?: number;
}): Promise<BrowserDataSource> {
  const url = parquetUrl(options.rootCid);
  const timeoutMs = options.timeoutMs ?? DUCKDB_INIT_TIMEOUT_MS;

  const boot = async (): Promise<{
    db: duckdb.AsyncDuckDB;
    connection: duckdb.AsyncDuckDBConnection;
    worker: Worker;
    workerUrl: string;
  }> => {
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    if (!bundle.mainWorker) {
      throw new Error("No DuckDB-WASM worker bundle is available for this browser");
    }
    // The published worker is a classic script; importing it through a blob URL
    // keeps it same-origin so the worker can be constructed without a CDN
    // worker-src exemption.
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    await db.registerFileURL(REGISTERED_FILE, url, duckdb.DuckDBDataProtocol.HTTP, false);
    const connection = await db.connect();
    await connection.query(buildCreateViewSql(REGISTERED_FILE));
    return { db, connection, worker, workerUrl };
  };

  const started = await withTimeout(boot(), timeoutMs, "DuckDB-WASM initialisation");
  const { db, connection, worker, workerUrl } = started;

  const teardown = async (): Promise<void> => {
    try {
      await connection.close();
    } catch {
      // Already closed.
    }
    try {
      await db.terminate();
    } catch {
      // Already terminated.
    }
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  };

  // Queries are serialised: one connection, one statement at a time.
  let queue: Promise<unknown> = Promise.resolve();

  const runQuery = async (sql: string): Promise<Record<string, unknown>[]> => {
    const next = queue.then(async () => {
      const table = (await connection.query(sql)) as unknown as Table;
      return tableToRows(table);
    });
    queue = next.catch(() => undefined);
    return next;
  };

  const runQueryOne = async (sql: string): Promise<Record<string, unknown> | null> => {
    const rows = await runQuery(sql);
    return rows.length > 0 ? (rows[0] ?? null) : null;
  };

  try {
    const described = await withTimeout(
      runQuery(buildDescribeSql(PROPERTIES_VIEW)),
      timeoutMs,
      "Query-table schema check",
    );
    const columnNames = described
      .map((row) => stringCell(row, "column_name"))
      .filter((name): name is string => typeof name === "string");
    assertSchemaMatches(columnNames);
  } catch (error) {
    await teardown();
    const message = error instanceof Error ? error.message : String(error);
    throw new DataSourceError(`Published Parquet failed the schema gate: ${message}`);
  }

  const provenance = (sql: string, sourceSystems: string[]): ResponseProvenance => ({
    sql,
    dataSource: url,
    dataSourceKind: "ipfs",
    sourceSystems,
    runId: options.runId,
    rootCid: options.rootCid,
  });

  const source: BrowserDataSource = {
    kind: "browser",
    label: "Browser DuckDB-WASM",
    dataSource: url,
    parquetUrl: url,

    async close() {
      await teardown();
    },

    async search(searchOptions: SearchOptions): Promise<SearchResponse> {
      const searchSql = buildSearchSql(PROPERTIES_VIEW, searchOptions);
      const countSql = buildCountSql(PROPERTIES_VIEW, searchOptions);
      const rows = await runQuery(searchSql);
      const matchedRow = await runQueryOne(countSql);
      return {
        rows,
        matched: numberCell(matchedRow, "matched"),
        limit: clampLimit(searchOptions.limit),
        offset: Math.max(0, Math.floor(searchOptions.offset ?? 0)),
        provenance: provenance(searchSql, sourceSystemsOf(rows)),
      };
    },

    async getProperty(parcelId: string): Promise<PropertyDetailResponse> {
      const sql = buildPropertyDetailSql(PROPERTIES_VIEW, parcelId);
      const row = await runQueryOne(sql);
      if (!row) throw new DataSourceError("Property not found", 404);
      const sourceSystemsValue = typeof row.source_systems === "string" ? row.source_systems : null;
      const enrichment = typeof row.enrichment_status === "string" ? row.enrichment_status : null;
      return {
        property: row,
        sources: parseSourceSystems(sourceSystemsValue),
        gating: parseEnrichmentStatus(enrichment),
        provenance: provenance(sql, sourceSystemsOf([row])),
      };
    },

    async getStats(): Promise<StatsResponse> {
      const statsSql = buildDatasetStatsSql(PROPERTIES_VIEW);
      const bandsSql = buildRoofAgeBandsSql(PROPERTIES_VIEW);
      const statsRow = await runQueryOne(statsSql);
      const bandRows = await runQuery(bandsSql);
      return {
        stats: rowToNumberRecord(statsRow),
        roofAgeBands: bandRows.map(toRoofAgeBand),
        provenance: provenance(`${statsSql};\n\n${bandsSql}`, [...ALL_SOURCE_SYSTEMS]),
      };
    },

    async getFacets(): Promise<FacetsResponse> {
      const [cities, propertyTypes, roofAgeBasis, zips] = await Promise.all([
        runQuery(buildFacetSql(PROPERTIES_VIEW, "address_city", 200)),
        runQuery(buildFacetSql(PROPERTIES_VIEW, "property_type", 200)),
        runQuery(buildFacetSql(PROPERTIES_VIEW, "roof_age_basis", 20)),
        runQuery(buildFacetSql(PROPERTIES_VIEW, "address_zip", 200)),
      ]);
      return {
        cities: toFacetValues(cities),
        propertyTypes: toFacetValues(propertyTypes),
        roofAgeBasis: toFacetValues(roofAgeBasis),
        zips: toFacetValues(zips),
      };
    },

    async getTenantView(): Promise<TenantViewResponse> {
      const postureSql = buildOwnerPostureSql(PROPERTIES_VIEW);
      const bandsSql = buildRoofAgeBandsSql(PROPERTIES_VIEW);
      const stateSql = buildFacetSql(PROPERTIES_VIEW, "owner_mailing_state", 30);
      const postureRow = await runQueryOne(postureSql);
      const bandRows = await runQuery(bandsSql);
      const stateRows = await runQuery(stateSql);
      return {
        ownerPosture: rowToNumberRecord(postureRow),
        roofAgeBands: bandRows.map(toRoofAgeBand),
        // "Out of state" means the owner's mailing state is not the county's
        // own state, so the home state is excluded from this ranking.
        topOutOfStateOwners: toFacetValues(stateRows)
          .filter((entry) => entry.value.trim().toUpperCase() !== COUNTY.stateCode)
          .slice(0, 20)
          .map((entry) => ({ owner_mailing_state: entry.value, properties: entry.count })),
        provenance: provenance(`${postureSql};\n\n${bandsSql};\n\n${stateSql}`, [
          ...ALL_SOURCE_SYSTEMS,
        ]),
      };
    },

    async getBusinessView(): Promise<BusinessViewResponse> {
      const totalsSql = buildDatasetStatsSql(PROPERTIES_VIEW);
      const bySql = buildBusinessByCitySql(PROPERTIES_VIEW, 40);
      const byTypeSql = buildBusinessByTypeSql(PROPERTIES_VIEW);
      const totalsRow = await runQueryOne(totalsSql);
      const cityRows = await runQuery(bySql);
      const typeRows = await runQuery(byTypeSql);
      const totals = rowToNumberRecord(totalsRow);
      const byCity: BusinessByCity[] = cityRows.map((row) => ({
        city: stringCell(row, "city") ?? "",
        properties_with_accounts: numberCell(row, "properties_with_accounts"),
        business_accounts: numberCell(row, "business_accounts"),
        properties: numberCell(row, "properties"),
      }));
      const byType: BusinessByType[] = typeRows.map((row) => ({
        property_type: stringCell(row, "property_type") ?? "unclassified",
        properties_with_accounts: numberCell(row, "properties_with_accounts"),
        business_accounts: numberCell(row, "business_accounts"),
      }));
      return {
        totals,
        byCity,
        byType,
        provenance: provenance(`${totalsSql};\n\n${bySql};\n\n${byTypeSql}`, ["fl_dor_tpp_2026p"]),
        note: BUSINESS_VIEW_NOTE,
      };
    },

    async getContractorView(): Promise<ContractorViewResponse> {
      const sql = buildPermitPostureSql(PROPERTIES_VIEW);
      const row = await runQueryOne(sql);
      return {
        posture: rowToNumberRecord(row),
        gating: parseEnrichmentStatus(GATED_ENRICHMENT_TOKENS),
        provenance: provenance(sql, ["lake_cdplus_permits"]),
        note: CONTRACTOR_VIEW_NOTE,
      };
    },

    async runSql(sql: string, limit?: number): Promise<SqlResponse> {
      const statement = assertReadOnlySql(sql);
      const capped = clampLimit(limit ?? 200);
      const executed = `SELECT * FROM (\n${statement}\n) AS q LIMIT ${capped}`;
      const rows = await runQuery(executed);
      return {
        rows,
        rowCount: rows.length,
        sql: statement,
        provenance: provenance(executed, sourceSystemsOf(rows)),
      };
    },
  };

  return source;
}
