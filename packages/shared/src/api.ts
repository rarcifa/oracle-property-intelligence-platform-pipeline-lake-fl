/**
 * Zod schemas for every API request and response shape.
 *
 * The server validates inbound requests against these, the MCP tool
 * definitions reuse the filter schema verbatim, and the UI imports the inferred
 * types. One definition, three consumers.
 */

import { z } from "zod";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./sql.js";
import { QUERY_TABLE_COLUMN_NAMES } from "./schema.js";

/** Coerce `"true"`/`"1"` query-string values into booleans. */
const boolish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

const finiteNumber = z.coerce.number().finite();

export const propertyFiltersSchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  zip: z.string().trim().min(1).max(12).optional(),
  propertyType: z.string().trim().min(1).max(60).optional(),
  roofAgeBasis: z
    .enum(["roofing_permit_completed", "roofing_permit_issued", "year_built"])
    .optional(),
  minRoofAge: finiteNumber.min(0).max(500).optional(),
  maxRoofAge: finiteNumber.min(0).max(500).optional(),
  hasPermits: boolish.optional(),
  hasOpenRoofingPermit: boolish.optional(),
  minOpenPermitDays: finiteNumber.min(0).max(100_000).optional(),
  ownerOutOfCounty: boolish.optional(),
  ownerOutOfState: boolish.optional(),
  noRecordedSale: boolish.optional(),
  hasBusinessAccount: boolish.optional(),
  minMarketValue: finiteNumber.min(0).optional(),
  maxMarketValue: finiteNumber.min(0).optional(),
  minBuiltYear: finiteNumber.min(1700).max(2100).optional(),
  maxBuiltYear: finiteNumber.min(1700).max(2100).optional(),
  lat: finiteNumber.min(-90).max(90).optional(),
  lon: finiteNumber.min(-180).max(180).optional(),
  radiusMiles: finiteNumber.gt(0).max(200).optional(),
  requireCoordinates: boolish.optional(),
});

export const searchOptionsSchema = propertyFiltersSchema.extend({
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  sortBy: z.enum(QUERY_TABLE_COLUMN_NAMES as unknown as [string, ...string[]]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export type PropertyFiltersInput = z.input<typeof propertyFiltersSchema>;
export type SearchOptionsInput = z.input<typeof searchOptionsSchema>;
export type SearchOptionsParsed = z.output<typeof searchOptionsSchema>;

export const readOnlySqlSchema = z.object({
  sql: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "A single read-only SELECT or WITH statement. The published table is exposed as the view `properties`.",
    ),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(200).optional(),
});

export const parcelIdSchema = z.object({
  parcelId: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .describe("Lake County parcel id (`request_identifier`), e.g. 05-18-25-0004-000-00400."),
});

export const radiusSchema = z.object({
  lat: finiteNumber.min(-90).max(90).describe("Centre latitude in decimal degrees."),
  lon: finiteNumber.min(-180).max(180).describe("Centre longitude in decimal degrees."),
  radiusMiles: finiteNumber.gt(0).max(200).default(1).describe("Search radius in statute miles."),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(50).optional(),
});

/** Provenance attached to every data-bearing response. */
export interface ResponseProvenance {
  /** The exact SQL that produced the payload. */
  sql: string;
  /** Where the Parquet was read from. */
  dataSource: string;
  /** Whether that source was IPFS or the local development file. */
  dataSourceKind: "ipfs" | "local";
  /** Upstream systems behind the columns in this payload. */
  sourceSystems: string[];
  /** The published run this answer came from. */
  runId: string | null;
  rootCid: string | null;
}

export interface SearchResponse {
  rows: Record<string, unknown>[];
  matched: number;
  limit: number;
  offset: number;
  provenance: ResponseProvenance;
}

export interface PropertyDetailResponse {
  property: Record<string, unknown>;
  sources: { token: string; label: string }[];
  gating: { token: string; field: string | null; headline: string; detail: string }[];
  provenance: ResponseProvenance;
}

export interface ChatCitation {
  /** Tool that produced the evidence. */
  tool: string;
  /** SQL executed, when the tool ran SQL. */
  sql: string | null;
  /** Upstream systems behind the numbers. */
  sourceSystems: string[];
  /** Parcel ids the claim rests on. */
  parcelIds: string[];
  /** Row count the tool returned. */
  rowCount: number;
}

/**
 * One retrieved corpus chunk the answer was grounded in.
 *
 * Distinct from `ChatCitation`, which is evidence the agent computed by running
 * SQL. This is evidence it *read*: the documentation, source catalog and
 * published run record behind a claim, with the relevance score that surfaced
 * it and — when the chunk came from a published artifact rather than a
 * repository file — the CID and an `ipfs://` path a reader can resolve.
 */
export interface ChatDocument {
  /** Stable id of the chunk. */
  chunkId: string;
  /** Stable id of the document the chunk belongs to. */
  docId: string;
  /** Corpus family: doc, column, coverage, source, limitation, publication… */
  docType: string;
  /** Document title, including its heading path. */
  title: string;
  /** Retrieval score, higher is closer. */
  score: number;
  /** Repository-relative path the text came from. */
  sourceFile: string;
  /** Published artifact name, when the text is also published to IPFS. */
  artifact: string | null;
  /** CID of that artifact. */
  cid: string | null;
  /** Resolvable `ipfs://` path, when published. */
  ipfsPath: string | null;
}

export interface ChatResponse {
  answer: string;
  citations: ChatCitation[];
  /** Corpus chunks retrieval surfaced for this turn. */
  documents: ChatDocument[];
  model: string;
  runId: string | null;
}

export const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(30),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
