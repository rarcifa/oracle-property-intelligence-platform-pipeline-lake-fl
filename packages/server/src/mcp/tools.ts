/**
 * MCP tool definitions over the published Lake County query table.
 *
 * Tool names follow the Elephant MCP conventions the kit uses, so an agent that
 * already knows the Elephant open-data tools can point at this server without
 * relearning anything. Every tool runs through the same DuckDB layer and the
 * same shared SQL builders as the REST API, and every tool result carries the
 * SQL and the source systems behind it.
 */

import {
  assertReadOnlySql,
  clampLimit,
  COUNTY,
  DEFAULT_ROOF_AGE_THRESHOLD_YEARS,
  parcelIdSchema,
  QUERY_TABLE_COLUMN_COUNT,
  QUERY_TABLE_COLUMNS,
  radiusSchema,
  readOnlySqlSchema,
  searchOptionsSchema,
  TENURE_CAVEAT,
  ALWAYS_NULL_COLUMNS,
  PARTIALLY_POPULATED_COLUMNS,
} from "@oracle-lake/shared";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  getContractorView,
  getDatasetStats,
  getProperty,
  runReadOnlySql,
  searchProperties,
} from "../data/queries.js";
import { readCoverage, readLatest } from "../data/run.js";

/** JSON Schema fragment, kept as a plain structure for the wire. */
export type JsonSchema = Record<string, unknown>;

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface McpToolResult {
  /** JSON-serialisable payload returned to the caller. */
  payload: unknown;
  isError?: boolean;
}

const numberProp = (description: string, extra: JsonSchema = {}): JsonSchema => ({
  type: "number",
  description,
  ...extra,
});
const stringProp = (description: string, extra: JsonSchema = {}): JsonSchema => ({
  type: "string",
  description,
  ...extra,
});
const boolProp = (description: string): JsonSchema => ({ type: "boolean", description });

const FILTER_PROPERTIES: JsonSchema = {
  q: stringProp("Free text matched against parcel id, street address and owner name."),
  city: stringProp("Exact city name from address_city, e.g. CLERMONT."),
  zip: stringProp("Exact address_zip."),
  propertyType: stringProp(
    "Property type band, e.g. single_family, condo, commercial, mobile_home, vacant_residential.",
  ),
  roofAgeBasis: {
    type: "string",
    enum: ["roofing_permit_completed", "roofing_permit_issued", "year_built"],
    description: "How roof age was derived for the parcel.",
  },
  minRoofAge: numberProp("Minimum roof_age_years.", { minimum: 0 }),
  maxRoofAge: numberProp("Maximum roof_age_years.", { minimum: 0 }),
  hasPermits: boolProp("Only parcels with (true) or without (false) permit records."),
  hasOpenRoofingPermit: boolProp("Only parcels with open_roofing_permit_count > 0."),
  minOpenPermitDays: numberProp("Minimum longest_open_permit_days.", { minimum: 0 }),
  ownerOutOfCounty: boolProp("Owner mailing city is outside Lake County."),
  ownerOutOfState: boolProp("Owner mailing state is not FL."),
  noRecordedSale: boolProp(
    "No sale recorded in the published DOR window. A lower bound on tenure, not proof of it.",
  ),
  hasBusinessAccount: boolProp("Parcel has one or more DOR TPP business accounts."),
  minMarketValue: numberProp("Minimum market_value in dollars.", { minimum: 0 }),
  maxMarketValue: numberProp("Maximum market_value in dollars.", { minimum: 0 }),
  minBuiltYear: numberProp("Minimum built_year."),
  maxBuiltYear: numberProp("Maximum built_year."),
  requireCoordinates: boolProp("Only parcels that carry latitude and longitude."),
};

const SORT_ENUM = QUERY_TABLE_COLUMNS.map((column) => column.name);

/** The advertised tool list. */
export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: "getPropertyQuerySchema",
    title: "Get property query schema",
    description: `Return the ${QUERY_TABLE_COLUMN_COUNT}-column schema of the published Lake County query table, including each column's type, label, upstream source, and which columns are permanently null because their source is gated. Call this before writing SQL for queryProperties.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "queryProperties",
    title: "Query properties with SQL",
    description:
      "Run a single read-only SELECT or WITH statement against the published table, which is exposed as the view `properties`. Anything that mutates, attaches, installs or copies is rejected. Returns rows plus the SQL that produced them.",
    inputSchema: {
      type: "object",
      properties: {
        sql: stringProp(
          "A single read-only SELECT or WITH statement. Reference the table as `properties`.",
        ),
        limit: numberProp("Maximum rows to return.", { minimum: 1, maximum: 500 }),
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "getOracleDatasetInfo",
    title: "Get dataset info and coverage",
    description:
      "Return the published run identity (run id, root CID, IPNS name, verified gateways), the live headline counts queried from the Parquet, the coverage snapshot's per-table row counts, and every documented limitation of this dataset.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "listOracleProperties",
    title: "List properties with filters",
    description:
      "Filtered, sorted, paged property search over the published table. Returns the matching-row total alongside the page, so counts reported to a user are real.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_PROPERTIES,
        lat: numberProp("Centre latitude for a radius search.", { minimum: -90, maximum: 90 }),
        lon: numberProp("Centre longitude for a radius search.", { minimum: -180, maximum: 180 }),
        radiusMiles: numberProp("Radius in statute miles. Required with lat and lon.", {
          exclusiveMinimum: 0,
          maximum: 200,
        }),
        limit: numberProp("Rows per page.", { minimum: 1, maximum: 500 }),
        offset: numberProp("Rows to skip.", { minimum: 0 }),
        sortBy: { type: "string", enum: SORT_ENUM, description: "Column to sort by." },
        sortDir: { type: "string", enum: ["asc", "desc"], description: "Sort direction." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "getOracleProperty",
    title: "Get one property",
    description:
      "Return every published column for one parcel, plus the upstream systems that contributed to it and the reason each permanently-null column is null.",
    inputSchema: {
      type: "object",
      properties: {
        parcelId: stringProp(
          "Lake County parcel id (request_identifier), e.g. 05-18-25-0004-000-00400.",
        ),
      },
      required: ["parcelId"],
      additionalProperties: false,
    },
  },
  {
    name: "findAgedRoofs",
    title: "Find aged roofs",
    description: `Find parcels whose roof age meets a threshold (default ${DEFAULT_ROOF_AGE_THRESHOLD_YEARS} years), returning the roof age basis for each so the evidence behind the age is visible. Roof age derives from a completed roofing permit, then an issued roofing permit, then year built.`,
    inputSchema: {
      type: "object",
      properties: {
        minRoofAge: numberProp(
          `Minimum roof age in years. Defaults to ${DEFAULT_ROOF_AGE_THRESHOLD_YEARS}.`,
          { minimum: 0 },
        ),
        city: stringProp("Restrict to one city."),
        propertyType: stringProp("Restrict to one property type band."),
        roofAgeBasis: {
          type: "string",
          enum: ["roofing_permit_completed", "roofing_permit_issued", "year_built"],
          description: "Restrict to one basis, e.g. only permit-derived roof ages.",
        },
        limit: numberProp("Rows to return.", { minimum: 1, maximum: 500 }),
      },
      additionalProperties: false,
    },
  },
  {
    name: "findOpenRoofPermits",
    title: "Find open roofing permits",
    description:
      "Find parcels carrying at least one open roofing permit, ordered by how long the longest open permit has been open.",
    inputSchema: {
      type: "object",
      properties: {
        minOpenPermitDays: numberProp("Minimum longest_open_permit_days.", { minimum: 0 }),
        city: stringProp("Restrict to one city."),
        limit: numberProp("Rows to return.", { minimum: 1, maximum: 500 }),
      },
      additionalProperties: false,
    },
  },
  {
    name: "findPropertiesInRadius",
    title: "Find properties within a radius",
    description:
      "Find parcels within a radius of a point, ordered nearest first, with the great-circle distance in miles on every row. Coordinates come from the 2025 FL GIO centroid release, so parcels first assessed in 2026 have no coordinate and cannot appear.",
    inputSchema: {
      type: "object",
      properties: {
        lat: numberProp("Centre latitude in decimal degrees.", { minimum: -90, maximum: 90 }),
        lon: numberProp("Centre longitude in decimal degrees.", { minimum: -180, maximum: 180 }),
        radiusMiles: numberProp("Radius in statute miles.", { exclusiveMinimum: 0, maximum: 200 }),
        minRoofAge: numberProp("Optional minimum roof age within the radius.", { minimum: 0 }),
        hasOpenRoofingPermit: boolProp("Optional: only parcels with an open roofing permit."),
        limit: numberProp("Rows to return.", { minimum: 1, maximum: 500 }),
      },
      required: ["lat", "lon", "radiusMiles"],
      additionalProperties: false,
    },
  },
]);

/**
 * Every tool's arguments are parsed against a strict schema, so an argument
 * this server does not implement is an error rather than a silent no-op.
 *
 * Each tool advertises `additionalProperties: false`, but the Zod schemas
 * behind them were not strict, so Zod stripped anything unrecognised and the
 * tool ran with the arguments it did understand — usually none. A reviewer
 * calling `findOpenRoofPermits` with `minOpenDays` instead of `minOpenPermitDays`
 * got all 226 open-roofing-permit rows back and reasonably concluded the filter
 * was ignored. It was not: the argument was.
 *
 * A wrong answer that looks right is worse than an error, and a caller that
 * misspells an argument must be told, not quietly served the unfiltered table.
 */
const strictArgs = <Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
): z.ZodObject<Shape, "strict"> => schema.strict();

/** Tools that take no arguments at all still reject arguments they were sent. */
const noArgsSchema = strictArgs(z.object({}));

const sqlToolSchema = strictArgs(readOnlySqlSchema);
const listToolSchema = strictArgs(searchOptionsSchema);
const propertyToolSchema = strictArgs(parcelIdSchema);

const agedRoofsSchema = strictArgs(
  z.object({
    minRoofAge: z.coerce.number().min(0).max(500).default(DEFAULT_ROOF_AGE_THRESHOLD_YEARS),
    city: z.string().trim().min(1).max(80).optional(),
    propertyType: z.string().trim().min(1).max(60).optional(),
    roofAgeBasis: z
      .enum(["roofing_permit_completed", "roofing_permit_issued", "year_built"])
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
  }),
);

const openRoofPermitsSchema = strictArgs(
  z.object({
    minOpenPermitDays: z.coerce.number().min(0).max(100_000).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
  }),
);

const radiusToolSchema = strictArgs(
  radiusSchema.extend({
    minRoofAge: z.coerce.number().min(0).max(500).optional(),
    hasOpenRoofingPermit: z.boolean().optional(),
  }),
);

/** Every tool name this server advertises. */
export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((tool) => tool.name);

function invalid(message: string): McpToolResult {
  return { payload: { error: "invalid_arguments", detail: message }, isError: true };
}

/**
 * Execute one tool.
 *
 * Returns a result object rather than throwing, because a JSON-RPC tool error
 * is a normal result with `isError: true`, not a protocol error.
 */
export async function callTool(
  context: AppContext,
  name: string,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const provenance = await context.provenance();

  switch (name) {
    case "getPropertyQuerySchema": {
      const parsed = noArgsSchema.safeParse(args);
      if (!parsed.success) return invalid(parsed.error.issues.map((i) => i.message).join("; "));
      return {
        payload: {
          county: COUNTY,
          view: "properties",
          columnCount: QUERY_TABLE_COLUMNS.length,
          columns: QUERY_TABLE_COLUMNS,
          alwaysNullColumns: ALWAYS_NULL_COLUMNS,
          // contractor_name lives here, not above: an agent told only that a
          // column is "always null" will stop asking for it, and it is not.
          partiallyPopulatedColumns: PARTIALLY_POPULATED_COLUMNS,
          tenureCaveat: TENURE_CAVEAT,
          runId: provenance.runId,
          rootCid: provenance.rootCid,
        },
      };
    }

    case "getOracleDatasetInfo": {
      const parsed = noArgsSchema.safeParse(args);
      if (!parsed.success) return invalid(parsed.error.issues.map((i) => i.message).join("; "));
      const [stats, coverage, latest] = await Promise.all([
        getDatasetStats(context.store, provenance),
        readCoverage(context.config),
        readLatest(context.config),
      ]);
      return {
        payload: {
          county: COUNTY,
          run: latest,
          runId: provenance.runId,
          dataSource: provenance.dataSource,
          dataSourceKind: provenance.dataSourceKind,
          liveCounts: stats.stats,
          roofAgeBands: stats.roofAgeBands,
          coverageTables: coverage?.tables ?? null,
          coverageSignals: coverage?.signals ?? null,
          denominator: coverage?.denominator ?? null,
          limitations: coverage?.limitations ?? [],
          provenance: stats.provenance,
        },
      };
    }

    case "queryProperties": {
      const parsed = sqlToolSchema.safeParse(args);
      if (!parsed.success) return invalid(parsed.error.issues.map((i) => i.message).join("; "));
      let safeSql: string;
      try {
        safeSql = assertReadOnlySql(parsed.data.sql);
      } catch (error) {
        return {
          payload: {
            error: "sql_rejected",
            detail: error instanceof Error ? error.message : String(error),
          },
          isError: true,
        };
      }
      try {
        const result = await runReadOnlySql(
          context.store,
          provenance,
          safeSql,
          clampLimit(parsed.data.limit ?? 200),
        );
        return { payload: result };
      } catch (error) {
        return {
          payload: {
            error: "query_failed",
            detail: error instanceof Error ? error.message : String(error),
            sql: safeSql,
          },
          isError: true,
        };
      }
    }

    case "listOracleProperties": {
      const parsed = listToolSchema.safeParse(args);
      if (!parsed.success) return invalid(parsed.error.issues.map((i) => i.message).join("; "));
      try {
        return { payload: await searchProperties(context.store, provenance, parsed.data) };
      } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error));
      }
    }

    case "getOracleProperty": {
      const parsed = propertyToolSchema.safeParse(args);
      if (!parsed.success) return invalid(parsed.error.issues.map((i) => i.message).join("; "));
      const detail = await getProperty(context.store, provenance, parsed.data.parcelId);
      if (detail === null) {
        return {
          payload: {
            error: "not_found",
            detail: `No published row for parcel ${parsed.data.parcelId}`,
          },
          isError: true,
        };
      }
      return { payload: detail };
    }

    case "findAgedRoofs": {
      const parsed = agedRoofsSchema.safeParse(args);
      if (!parsed.success) return invalid(parsed.error.issues.map((i) => i.message).join("; "));
      const { minRoofAge, city, propertyType, roofAgeBasis, limit } = parsed.data;
      const result = await searchProperties(context.store, provenance, {
        minRoofAge,
        city,
        propertyType,
        roofAgeBasis,
        limit,
        sortBy: "roof_age_years",
        sortDir: "desc",
      });
      return {
        payload: {
          ...result,
          thresholdYears: minRoofAge,
          basisNote:
            "roof_age_basis names the evidence behind each age: a completed roofing permit, an issued roofing permit, or the structure's year built when no roofing permit is published.",
        },
      };
    }

    case "findOpenRoofPermits": {
      const parsed = openRoofPermitsSchema.safeParse(args);
      if (!parsed.success) return invalid(parsed.error.issues.map((i) => i.message).join("; "));
      const { minOpenPermitDays, city, limit } = parsed.data;
      const [result, contractor] = await Promise.all([
        searchProperties(context.store, provenance, {
          hasOpenRoofingPermit: true,
          minOpenPermitDays,
          city,
          limit,
          sortBy: "longest_open_permit_days",
          sortDir: "desc",
        }),
        getContractorView(context.store, provenance),
      ]);
      return {
        payload: {
          ...result,
          gating: contractor.gating,
          note: contractor.note,
        },
      };
    }

    case "findPropertiesInRadius": {
      const parsed = radiusToolSchema.safeParse(args);
      if (!parsed.success) return invalid(parsed.error.issues.map((i) => i.message).join("; "));
      const { lat, lon, radiusMiles, limit, minRoofAge, hasOpenRoofingPermit } = parsed.data;
      try {
        const result = await searchProperties(context.store, provenance, {
          lat,
          lon,
          radiusMiles,
          minRoofAge,
          hasOpenRoofingPermit,
          limit: limit ?? 50,
        });
        return {
          payload: {
            ...result,
            centre: { lat, lon },
            radiusMiles,
            coordinateNote:
              "Coordinates come from the 2025 FL GIO centroid release against the 2026 roll, so parcels first assessed in 2026 publish with a null coordinate and cannot match a radius search.",
          },
        };
      } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error));
      }
    }

    default:
      return {
        payload: { error: "unknown_tool", detail: `No tool named ${name}` },
        isError: true,
      };
  }
}
