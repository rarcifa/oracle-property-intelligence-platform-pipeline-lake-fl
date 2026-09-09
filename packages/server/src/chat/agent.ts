/**
 * Natural-language agent over the published query table.
 *
 * Built on the Vercel AI SDK (`ai`) with `@ai-sdk/anthropic`, per the
 * engineering guidelines: no direct provider SDK, Zod tool schemas, and no
 * `any` anywhere in the LLM path. The agent has no knowledge of the data other
 * than what its tools return, and every tool call is recorded as a citation
 * carrying the SQL, the upstream source systems and the parcel ids behind the
 * numbers, so an answer can always be traced back to rows.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import {
  assertReadOnlySql,
  clampLimit,
  DEFAULT_ROOF_AGE_THRESHOLD_YEARS,
  propertyFiltersSchema,
  QUERY_TABLE_COLUMNS,
  TENURE_CAVEAT,
  type ChatCitation,
  type ChatResponse,
} from "@oracle-lake/shared";
import type { AppContext } from "../context.js";
import type { QueryRow } from "../data/duckdb.js";
import {
  getContractorView,
  getDatasetStats,
  getProperty,
  runReadOnlySql,
  searchProperties,
} from "../data/queries.js";
import { readCoverage } from "../data/run.js";

/** Thrown when the chat surface is asked to run without a model key. */
export class ChatUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = "ChatUnavailableError";
    this.detail = detail;
  }
}

/** Collects the evidence behind one turn. */
class CitationCollector {
  readonly citations: ChatCitation[] = [];

  record(
    toolName: string,
    sql: string | null,
    sourceSystems: readonly string[],
    rows: readonly QueryRow[],
    rowCount?: number,
  ): void {
    const parcelIds: string[] = [];
    for (const row of rows) {
      const id = row.request_identifier;
      if (typeof id === "string" && id.length > 0 && parcelIds.length < 25) parcelIds.push(id);
    }
    this.citations.push({
      tool: toolName,
      sql,
      sourceSystems: [...sourceSystems],
      parcelIds,
      rowCount: rowCount ?? rows.length,
    });
  }
}

const COLUMN_SUMMARY = QUERY_TABLE_COLUMNS.map(
  (column) => `${column.name} (${column.type}) — ${column.label}; source: ${column.source}`,
).join("\n");

const SYSTEM_PROMPT = `You are the Oracle property-intelligence analyst for Lake County, Florida.

You answer only from the published query table, which is one row per parcel with these 59 columns:
${COLUMN_SUMMARY}

Rules you must follow without exception:

1. Never state a number you did not obtain from a tool call in this turn. If you need a count, run a query. Never estimate, never round a count, never reuse a number from an earlier turn without re-querying it.
2. Every answer must name its evidence in prose: which columns and which upstream source systems the numbers came from, and, when the claim is about specific properties, the parcel ids. Parcel ids live in request_identifier.
3. contractor_name and bbb_rating are real columns that are null for every row because their sources answer HTTP 403: county permit detail pages sit behind a Cloudflare managed challenge, and bbb.org refuses this egress. If a question needs a contractor name or a BBB rating, say plainly that the value is gated at the source and give the reason. Never invent one, never infer one from an owner name, and never present the null as "no contractor worked on this property".
4. has_sunbiz_tenant is false for every row because Sunbiz search is gated and was not ingested. business_account_count comes from the DOR tangible personal property roll and is evidence of business activity at the situs address, not a business directory.
5. ${TENURE_CAVEAT}
6. The permit layer publishes a rolling 365-day window and covers unincorporated Lake County only. Absence of a permit is not proof that no permit exists; say so when a question turns on it.
7. roof_age_basis names the evidence behind roof age: a completed roofing permit, an issued roofing permit, or the structure's year built. Always report the basis alongside a roof-age claim, because a year-built roof age is an upper bound on roof age, not a measurement of the roof.
8. Prefer the purpose-built tools. Use runSql for anything they cannot express; it accepts a single read-only SELECT or WITH against the view \`properties\`.
9. Be concise. Lead with the answer, then the evidence. Use plain prose and short lists, no headings.

The default aged-roof threshold used by this county's onboarding is ${DEFAULT_ROOF_AGE_THRESHOLD_YEARS} years.`;

const filtersForAgent = propertyFiltersSchema.extend({
  limit: z.number().int().min(1).max(200).optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

/** Build the tool set for one turn, wired to the collector. */
function buildTools(context: AppContext, collector: CitationCollector) {
  return {
    getDatasetInfo: tool({
      description:
        "Headline counts for the whole published dataset, the coverage snapshot's per-table row counts, and every documented limitation. Call this when a question is about the dataset as a whole, or to establish a denominator.",
      inputSchema: z.object({}),
      execute: async () => {
        const provenance = await context.provenance();
        const [stats, coverage] = await Promise.all([
          getDatasetStats(context.store, provenance),
          readCoverage(context.config),
        ]);
        collector.record(
          "getDatasetInfo",
          stats.provenance.sql,
          stats.provenance.sourceSystems,
          [],
        );
        return {
          runId: provenance.runId,
          rootCid: provenance.rootCid,
          liveCounts: stats.stats,
          roofAgeBands: stats.roofAgeBands,
          coverageTables: coverage?.tables ?? null,
          denominator: coverage?.denominator ?? null,
          limitations: coverage?.limitations ?? [],
        };
      },
    }),

    searchProperties: tool({
      description:
        "Filtered property search. Returns a page of rows plus the true total number of matching parcels, which is the number to quote for 'how many' questions. Supports roof-age thresholds, permit posture, owner locality, value and year ranges, city, property type, and radius search (lat, lon and radiusMiles together).",
      inputSchema: filtersForAgent,
      execute: async (input) => {
        const provenance = await context.provenance();
        const result = await searchProperties(context.store, provenance, {
          ...input,
          limit: clampLimit(input.limit ?? 25),
        });
        collector.record(
          "searchProperties",
          result.provenance.sql,
          result.provenance.sourceSystems,
          result.rows,
          result.matched,
        );
        return {
          matched: result.matched,
          returned: result.rows.length,
          rows: result.rows,
        };
      },
    }),

    getProperty: tool({
      description:
        "Every published column for one parcel, with the upstream systems that contributed to it and the reason each permanently-null column is null.",
      inputSchema: z.object({
        parcelId: z.string().trim().min(3).max(64).describe("request_identifier of the parcel."),
      }),
      execute: async ({ parcelId }) => {
        const provenance = await context.provenance();
        const detail = await getProperty(context.store, provenance, parcelId);
        if (detail === null) {
          collector.record("getProperty", null, [], []);
          return { found: false, parcelId };
        }
        collector.record("getProperty", detail.provenance.sql, detail.provenance.sourceSystems, [
          detail.property,
        ]);
        return {
          found: true,
          property: detail.property,
          sources: detail.sources,
          gating: detail.gating,
        };
      },
    }),

    runSql: tool({
      description:
        "Run a single read-only SELECT or WITH statement against the view `properties`. Use this for aggregates, group-bys and anything the other tools cannot express. Mutating statements are rejected.",
      inputSchema: z.object({
        sql: z
          .string()
          .min(1)
          .max(8000)
          .describe("A single read-only SELECT or WITH statement over the view `properties`."),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ sql, limit }) => {
        let safeSql: string;
        try {
          safeSql = assertReadOnlySql(sql);
        } catch (error) {
          return {
            error: "sql_rejected",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        const provenance = await context.provenance();
        try {
          const result = await runReadOnlySql(
            context.store,
            provenance,
            safeSql,
            clampLimit(limit ?? 100),
          );
          collector.record(
            "runSql",
            result.sql,
            result.provenance.sourceSystems,
            result.rows,
            result.rowCount,
          );
          return { rowCount: result.rowCount, rows: result.rows, sql: result.sql };
        } catch (error) {
          return {
            error: "query_failed",
            detail: error instanceof Error ? error.message : String(error),
            sql: safeSql,
          };
        }
      },
    }),

    getGatingReasons: tool({
      description:
        "The permit posture of the dataset and the exact reasons contractor identity and BBB ratings are absent. Call this whenever a question touches contractors, BBB ratings, or whether a permit's details are available.",
      inputSchema: z.object({}),
      execute: async () => {
        const provenance = await context.provenance();
        const view = await getContractorView(context.store, provenance);
        collector.record(
          "getGatingReasons",
          view.provenance.sql,
          view.provenance.sourceSystems,
          [],
        );
        return { posture: view.posture, gating: view.gating, note: view.note };
      },
    }),
  };
}

export interface ChatAgent {
  readonly enabled: boolean;
  readonly modelId: string;
  run(messages: readonly { role: "user" | "assistant"; content: string }[]): Promise<ChatResponse>;
}

/** Build the chat agent. Never throws for a missing key; `run` does. */
export function createChatAgent(context: AppContext): ChatAgent {
  const { anthropicApiKey, chatModelId, chatTimeoutMs } = context.config;

  return {
    enabled: anthropicApiKey !== null,
    modelId: chatModelId,
    async run(messages): Promise<ChatResponse> {
      if (anthropicApiKey === null) {
        throw new ChatUnavailableError(
          "ANTHROPIC_API_KEY is not set on the server, so the natural-language agent is disabled. Every other view queries the published data directly and is unaffected.",
        );
      }

      const collector = new CitationCollector();
      const anthropic = createAnthropic({ apiKey: anthropicApiKey });

      const result = await generateText({
        model: anthropic(chatModelId),
        system: SYSTEM_PROMPT,
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        tools: buildTools(context, collector),
        stopWhen: stepCountIs(10),
        abortSignal: AbortSignal.timeout(chatTimeoutMs),
      });

      const provenance = await context.provenance();
      return {
        answer: result.text.trim(),
        citations: collector.citations,
        model: chatModelId,
        runId: provenance.runId,
      };
    },
  };
}
