/**
 * REST routes over the DuckDB data layer.
 *
 * Every data-bearing response carries a `provenance` block naming the SQL that
 * produced it, the Parquet it was read from, the upstream source systems, and
 * the published run id and root CID. That is the contract that lets the UI show
 * "the data is real" without the UI having to be trusted.
 */

import {
  ALWAYS_NULL_COLUMNS,
  assertReadOnlySql,
  clampLimit,
  COUNTY,
  IPFS_GATEWAYS,
  PARTIALLY_POPULATED_COLUMNS,
  QUERY_TABLE_COLUMNS,
  readOnlySqlSchema,
  searchOptionsSchema,
  TENURE_CAVEAT,
  UNUSABLE_IPFS_GATEWAYS,
} from "@oracle-lake/shared";
import type { AppContext } from "../context.js";
import {
  getBusinessView,
  getContractorView,
  getDatasetStats,
  getFacets,
  getProperty,
  getPropertyPermits,
  getTenantView,
  runReadOnlySql,
  searchProperties,
} from "../data/queries.js";
import { readCoverage, readLatest, readRunHistory, readVerification } from "../data/run.js";
import { callerOf, createRateLimiter, DEFAULT_QUERY_RATE_LIMIT } from "../chat/rate-limit.js";
import { fail, json, type Router } from "../http/router.js";
import { registerSearchRoutes } from "./search.js";

/** Turn a query string into the plain object the Zod schemas expect. */
function queryObject(query: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of query.entries()) {
    if (value.length > 0) out[key] = value;
  }
  return out;
}

/** Register every `/api/*` route on the router. */
export function registerApiRoutes(router: Router, context: AppContext): void {
  // `/api/sql` is unauthenticated compute over a 215,806-row table and had no
  // limit of any kind. Generous enough that the UI's own page-load bursts pass,
  // tight enough that a scraper does not run free.
  const queryLimiter = createRateLimiter(DEFAULT_QUERY_RATE_LIMIT);
  // Semantic retrieval lives in its own module but is part of the `/api/*`
  // surface, and is registered here so the composition root stays untouched.
  registerSearchRoutes(router, context);

  router.get("/api/health", async () => {
    const provenance = await context.provenance();
    const propertyCount = Number(
      (await context.store.queryScalar("SELECT count(*) FROM properties")) ?? 0,
    );
    return json(200, {
      ok: true,
      county: COUNTY,
      dataSource: provenance.dataSource,
      dataSourceKind: provenance.dataSourceKind,
      runId: provenance.runId,
      rootCid: provenance.rootCid,
      propertyCount,
    });
  });

  router.get("/api/meta/run", async () => {
    const [provenance, coverage, bundled] = await Promise.all([
      context.provenance(),
      readCoverage(context.config),
      readLatest(context.config),
    ]);
    // `latest.json` is bundled at deploy time, so it names whichever run was
    // current when the Lambda was built. The dataset itself is resolved from
    // IPNS at runtime and upgrades in place, so after any publish the two
    // disagree — and this endpoint feeds the run and root CID shown in the UI
    // header, which would then describe a run the runtime is no longer serving.
    //
    // The served run wins. The bundled record supplies the fields provenance
    // does not carry (manifest and CAR CIDs, publication time, verified
    // gateways) only while it describes that same run; once it is behind, those
    // fields are dropped rather than shown against the wrong run.
    const servedRunId = provenance.runId ?? bundled?.runId ?? null;
    const bundledDescribesServed = bundled !== null && bundled.runId === servedRunId;
    const run =
      bundled === null && provenance.runId === null
        ? null
        : {
            ...(bundledDescribesServed ? bundled : {}),
            runId: servedRunId,
            // A different bundled pointer must never donate a CID to local or
            // newly resolved bytes. `null` is the honest identity for an
            // unpublished local candidate.
            rootCid: provenance.rootCid,
          };
    const [verification, runHistory] = await Promise.all([
      readVerification(context.config, run?.runId ?? provenance.runId),
      readRunHistory(context.config),
    ]);
    return json(200, {
      run,
      coverage,
      verification,
      runHistory,
      dataSource: provenance.dataSource,
      dataSourceKind: provenance.dataSourceKind,
      gateways: IPFS_GATEWAYS,
      unusableGateways: UNUSABLE_IPFS_GATEWAYS,
      chatEnabled: context.config.openaiApiKey !== null,
      tenureCaveat: TENURE_CAVEAT,
    });
  });

  router.get("/api/meta/schema", () =>
    json(200, {
      columnCount: QUERY_TABLE_COLUMNS.length,
      columns: QUERY_TABLE_COLUMNS,
      alwaysNullColumns: ALWAYS_NULL_COLUMNS,
      // Served alongside, never merged into, the always-null map. A consumer
      // that saw only the always-null map would read contractor_name's absence
      // from it as "this column has no caveat", which is the opposite of true.
      partiallyPopulatedColumns: PARTIALLY_POPULATED_COLUMNS,
    }),
  );

  router.get("/api/meta/facets", async () => {
    const facets = await getFacets(context.store);
    return json(200, facets);
  });

  router.get("/api/stats", async () => {
    const provenance = await context.provenance();
    return json(200, await getDatasetStats(context.store, provenance));
  });

  router.get("/api/properties", async (request) => {
    const parsed = searchOptionsSchema.safeParse(queryObject(request.query));
    if (!parsed.success) {
      return fail(
        400,
        "invalid_query",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    const provenance = await context.provenance();
    try {
      return json(200, await searchProperties(context.store, provenance, parsed.data));
    } catch (error) {
      return fail(400, "invalid_search", error instanceof Error ? error.message : String(error));
    }
  });

  router.get("/api/properties/:parcelId", async (request) => {
    const parcelId = request.params.parcelId ?? "";
    if (parcelId.length < 3) return fail(400, "invalid_parcel_id");
    const provenance = await context.provenance();
    const detail = await getProperty(context.store, provenance, parcelId);
    if (detail === null) {
      return fail(404, "Property not found", `No published row for parcel ${parcelId}`);
    }
    return json(200, detail);
  });

  router.get("/api/properties/:parcelId/permits", async (request) => {
    const parcelId = request.params.parcelId ?? "";
    if (parcelId.length < 3) return fail(400, "invalid_parcel_id");
    const provenance = await context.provenance();
    return json(200, await getPropertyPermits(context.store, provenance, parcelId));
  });

  router.get("/api/views/tenant", async () => {
    const provenance = await context.provenance();
    const view = await getTenantView(context.store, provenance);
    return json(200, { ...view, tenureCaveat: TENURE_CAVEAT });
  });

  router.get("/api/views/business", async () => {
    const provenance = await context.provenance();
    return json(200, await getBusinessView(context.store, provenance));
  });

  router.get("/api/views/contractor", async () => {
    const provenance = await context.provenance();
    return json(200, await getContractorView(context.store, provenance));
  });

  router.post("/api/sql", async (request) => {
    const verdict = queryLimiter.take(callerOf(request.headers));
    if (!verdict.allowed) {
      return fail(
        429,
        "rate_limited",
        `Too many queries from this caller. Try again in ${verdict.retryAfterSeconds}s. The published Parquet is on IPFS and can be queried locally without any limit — see the README.`,
      );
    }
    const parsed = readOnlySqlSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(400, "invalid_body", parsed.error.issues.map((i) => i.message).join("; "));
    }
    let safeSql: string;
    try {
      safeSql = assertReadOnlySql(parsed.data.sql);
    } catch (error) {
      return fail(400, "sql_rejected", error instanceof Error ? error.message : String(error));
    }
    const provenance = await context.provenance();
    try {
      const result = await runReadOnlySql(
        context.store,
        provenance,
        safeSql,
        clampLimit(parsed.data.limit ?? 200),
      );
      return json(200, result);
    } catch (error) {
      return fail(400, "query_failed", error instanceof Error ? error.message : String(error));
    }
  });
}
