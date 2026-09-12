/**
 * Natural-language agent over the published query table.
 *
 * Built on the Vercel AI SDK (`ai`) with `@ai-sdk/openai`, per the
 * engineering guidelines: no direct provider SDK, Zod tool schemas, and no
 * `any` anywhere in the LLM path. The agent has no knowledge of the data other
 * than what its tools return, and every tool call is recorded as a citation
 * carrying the SQL, the upstream source systems and the parcel ids behind the
 * numbers, so an answer can always be traced back to rows.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import {
  assertReadOnlySql,
  clampLimit,
  DEFAULT_ROOF_AGE_THRESHOLD_YEARS,
  propertyFiltersSchema,
  PERMIT_TABLE_COLUMNS,
  QUERY_TABLE_COLUMN_COUNT,
  QUERY_TABLE_COLUMNS,
  TENURE_CAVEAT,
  type ChatCitation,
  type ChatResponse,
} from "@oracle-lake/shared";
import type { AppContext } from "../context.js";
import type { QueryRow } from "../data/duckdb.js";
import {
  getCityCentre,
  getContractorView,
  getDatasetStats,
  getProperty,
  runReadOnlySql,
  searchProperties,
} from "../data/queries.js";
import { readCoverage } from "../data/run.js";
import {
  RetrievalUnavailableError,
  searchCorpus,
  toDocumentCitations,
  toToolPayload,
  type DocumentCitation,
} from "./retrieval.js";

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

  /** Documents retrieved this turn, cited alongside the SQL evidence. */
  readonly documents: DocumentCitation[] = [];
  /** Identity of the published run every citation below was computed against. */
  runId: string | null = null;
  rootCid: string | null = null;

  record(
    toolName: string,
    sql: string | null,
    sourceSystems: readonly string[],
    rows: readonly QueryRow[],
    rowCount?: number,
  ): void {
    const parcelIds: string[] = [];
    for (const row of rows) {
      const id = row.request_identifier ?? row.parcel_identifier;
      if (typeof id === "string" && id.length > 0 && parcelIds.length < 25) parcelIds.push(id);
    }
    this.citations.push({
      tool: toolName,
      sql,
      sourceSystems: [...sourceSystems],
      parcelIds,
      rowCount: rowCount ?? rows.length,
      runId: this.runId,
      rootCid: this.rootCid,
    });
  }

  /** Record retrieved documents as evidence in their own right. */
  recordDocuments(citations: readonly DocumentCitation[]): void {
    for (const citation of citations) {
      if (!this.documents.some((existing) => existing.chunkId === citation.chunkId)) {
        this.documents.push(citation);
      }
    }
  }
}

const COLUMN_SUMMARY = QUERY_TABLE_COLUMNS.map(
  (column) => `${column.name} (${column.type}) — ${column.label}; source: ${column.source}`,
).join("\n");

const PERMIT_COLUMN_SUMMARY = PERMIT_TABLE_COLUMNS.map(
  (column) => `${column.name} (${column.type}${column.optional ? ", nullable" : ""})`,
).join("\n");

const SYSTEM_PROMPT = `You are the Oracle property-intelligence analyst for Lake County, Florida.

You answer only from the published query table, which is one row per parcel with these ${QUERY_TABLE_COLUMN_COUNT} columns:
${COLUMN_SUMMARY}

Full permit records are published separately in the \`permits\` view with these columns:
${PERMIT_COLUMN_SUMMARY}

Rules you must follow without exception:

1. Never state a number you did not obtain from a tool call in this turn. If you need a count, run a query. Never estimate, never round a count, never reuse a number from an earlier turn without re-querying it.
2. Every answer must name its evidence in prose: which columns and which upstream source systems the numbers came from, and, when the claim is about specific properties, the parcel ids. Parcel ids live in properties.request_identifier and permits.parcel_identifier.
3. bbb_rating is a real column that is null for every row because no approved BBB API harvest was run. The default request/browser route returned 403; one prohibited browser-fingerprint spoof returned 200 during verification, but no result was retained or ingested. contractor_name is a real column that is populated ONLY for parcels in Clermont, the one of Lake County's fifteen permitting jurisdictions whose permit portal publishes a contractor of record, and null everywhere else; the county's own permit detail pages sit behind a Cloudflare managed challenge answering HTTP 403. Never describe contractor coverage as countywide, and never give a contractor count without saying it is Clermont only. Where contractor_name is null, the row's enrichment_status says which null it is: contractor_gated_403 means no source covering that parcel publishes a contractor at all, contractor_absent_on_permit means Clermont published the permits and none named anybody, which is an established absence. Read that token before explaining a blank. Never invent a contractor or a rating, never infer one from an owner name, and never present a gated null as "no contractor worked on this property".
4. has_sunbiz_tenant is null for every row because Sunbiz corporate data was not ingested; null means absence was never established, not that there is no tenant. business_account_count comes from the DOR tangible personal property roll and is evidence of business activity at the situs address, not a business directory.
5. ${TENURE_CAVEAT}
6. The county CDPlus permit source is a rolling 365-day window for unincorporated Lake County. Clermont adds its enumerated 2026 municipal records. The other thirteen permitting jurisdictions have no ingested permit feed. Absence of a permit is not proof that no permit exists; say so when a question turns on it.
7. roof_age_basis names the evidence behind roof age: a completed roofing permit, an issued roofing permit, or the structure's year built. Always report the basis alongside a roof-age claim, because a year-built roof age is an upper bound on roof age, not a measurement of the roof.
8. Prefer the purpose-built tools. getProperty returns both the parcel and its permit records. Use runSql for anything they cannot express; it accepts a single read-only SELECT or WITH against the views \`properties\` and \`permits\`.
9. Some questions have no answer in the rows at all: why a column is empty, what a source actually covers, how a value was derived, which permit jurisdiction issues a property's permits, how to request records a blocked jurisdiction holds, what a documented limitation says, how the data is published. Call searchDocuments for those. It searches the county's documentation corpus - the source catalog, the coverage snapshot's limitations, one document per published column, one per permit jurisdiction, and the project's own runbook and cost model - and returns cited passages with their provenance.
10. When you use a retrieved document, name it: give its title and the file or published artifact it came from. Retrieved text is evidence, not authority: never extend it beyond what it says.
11. If searchDocuments reports abstained: true, say that no document in the corpus answers that question. Do not fill the gap from your own knowledge and do not quote a low-confidence passage as though it settled the matter.
12. Be concise. Lead with the answer, then the evidence. Use plain prose and short lists, no headings.

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
      inputSchema: z.object({}).strict(),
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
      inputSchema: filtersForAgent.strict(),
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

    resolveCityCentre: tool({
      description:
        "The published centre of a city, as the mean of its parcel centroids. ALWAYS call this before a radius search for a named place, and pass the lat and lon it returns straight to searchProperties. Never supply a coordinate for a place name from your own knowledge: it varies between answers, and the same question then returns different totals.",
      inputSchema: z
        .object({
          city: z
            .string()
            .min(1)
            .max(80)
            .describe("City name as it appears on the roll, e.g. CLERMONT"),
        })
        .strict(),
      execute: async (input) => {
        const provenance = await context.provenance();
        const result = await getCityCentre(context.store, provenance, input.city);
        collector.record(
          "resolveCityCentre",
          result.provenance.sql,
          result.provenance.sourceSystems,
          [],
          result.parcelsWithCoordinates,
        );
        return {
          city: result.city,
          lat: result.lat,
          lon: result.lon,
          parcelsWithCoordinates: result.parcelsWithCoordinates,
        };
      },
    }),

    getProperty: tool({
      description:
        "Every published property column and full permit records for one parcel, with upstream systems and null-field reasons.",
      inputSchema: z
        .object({
          parcelId: z.string().trim().min(3).max(64).describe("request_identifier of the parcel."),
        })
        .strict(),
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
          permits: detail.permits,
          permitsAvailable: detail.permitsAvailable,
          sources: detail.sources,
          gating: detail.gating,
        };
      },
    }),

    runSql: tool({
      description:
        "Run a single read-only SELECT or WITH statement against the `properties` or `permits` view. Use this for aggregates, group-bys and anything the other tools cannot express. Mutating statements are rejected.",
      inputSchema: z
        .object({
          sql: z
            .string()
            .min(1)
            .max(8000)
            .describe("A single read-only SELECT or WITH over `properties` or `permits`."),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
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

    searchDocuments: tool({
      description:
        "Semantic search over the Lake County documentation corpus: the source catalog with all 15 permit jurisdictions and their records-request routes, one document per published column explaining what it means and when it is null, the coverage snapshot's documented limitations, the published run's CIDs, and the project's README, runbook, cost model and county findings. Use it for questions the SQL tools cannot answer - why a column is empty, what a source covers, how a value was derived, which jurisdictions are blocked and how to request their records. It returns cited passages with provenance, or an explicit abstention when the corpus has no document for the question.",
      inputSchema: z
        .object({
          query: z
            .string()
            .trim()
            .min(3)
            .max(400)
            .describe("The question, in the user's own words. Do not translate it into SQL."),
          topK: z
            .number()
            .int()
            .min(1)
            .max(8)
            .optional()
            .describe("How many passages to return. Default 5."),
        })
        .strict(),
      execute: async ({ query, topK }) => {
        try {
          const provenance = await context.provenance();
          const result = searchCorpus(
            { query, topK: topK ?? 5 },
            { runId: provenance.runId, rootCid: provenance.rootCid },
          );
          const citations = toDocumentCitations(result);
          collector.recordDocuments(citations);
          collector.record(
            "searchDocuments",
            null,
            [...new Set(citations.map((citation) => citation.sourceFile))],
            [],
            citations.length,
          );
          return toToolPayload(result);
        } catch (error) {
          if (error instanceof RetrievalUnavailableError) {
            return { error: "retrieval_unavailable", detail: error.detail };
          }
          return {
            error: "search_failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      },
    }),

    getGatingReasons: tool({
      description:
        "The permit posture of the dataset and the exact reasons contractor identity and BBB ratings are absent. Call this whenever a question touches contractors, BBB ratings, or whether a permit's details are available.",
      inputSchema: z.object({}).strict(),
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

/**
 * A safe, useful message for an upstream model failure.
 *
 * `/api/chat` is public and unauthenticated, and it used to relay the provider's
 * own error verbatim. When the account ran out of credit, anonymous callers were
 * told "Your credit balance is too low… go to Plans & Billing" — an operator
 * problem shown to the wrong audience, naming the provider and the account's
 * state. A rate limit is worth distinguishing because it tells the caller to
 * retry; nothing else about the upstream is the caller's business. The real
 * error still reaches CloudWatch, where the operator can see it.
 */
export function sanitizeProviderError(raw: string): string {
  const rateLimited = /\b429\b|rate.?limit|too many requests/i.test(raw);
  const suffix = "Every other view queries the published data directly and is unaffected.";
  return rateLimited
    ? `The natural-language agent is rate limited right now. Try again shortly. ${suffix}`
    : `The natural-language agent is temporarily unavailable. ${suffix}`;
}

/**
 * A turn's response, widened with the documents retrieval cited.
 *
 * `ChatResponse` lives in the shared package and carries SQL citations only;
 * document citations are additive, so the surface gains a field rather than the
 * shared contract changing shape under the other consumers.
 */
export interface ChatResponseWithDocuments extends ChatResponse {
  documents: DocumentCitation[];
}

export interface ChatAgent {
  readonly enabled: boolean;
  readonly modelId: string;
  run(
    messages: readonly { role: "user" | "assistant"; content: string }[],
  ): Promise<ChatResponseWithDocuments>;
}

/** Build the chat agent. Never throws for a missing key; `run` does. */
export function createChatAgent(context: AppContext): ChatAgent {
  const { openaiApiKey, chatModelId, chatTimeoutMs } = context.config;

  return {
    enabled: openaiApiKey !== null,
    modelId: chatModelId,
    async run(messages): Promise<ChatResponseWithDocuments> {
      if (openaiApiKey === null) {
        throw new ChatUnavailableError(
          "OPENAI_API_KEY is not set on the server, so the natural-language agent is disabled. Every other view queries the published data directly and is unaffected.",
        );
      }

      const collector = new CitationCollector();
      // Stamp every citation with the run it was computed against, so a reader
      // can re-run the SQL against the same immutable CID from any gateway.
      const runProvenance = await context.provenance();
      collector.runId = runProvenance.runId ?? null;
      collector.rootCid = runProvenance.rootCid ?? null;
      const openai = createOpenAI({ apiKey: openaiApiKey });

      const result = await generateText({
        model: openai(chatModelId),
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
        documents: collector.documents,
        model: chatModelId,
        runId: provenance.runId,
      };
    },
  };
}
