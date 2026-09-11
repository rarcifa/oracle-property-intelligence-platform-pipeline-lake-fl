/**
 * Domain vocabulary: the bridge between how a person asks and how the corpus
 * is written.
 *
 * A retriever with no learned word embeddings still has to connect "why is this
 * field empty" to a document that says "gated at source, HTTP 403". That
 * connection is domain knowledge, not statistics, and encoding it explicitly is
 * both cheaper and more auditable than inferring it. Every expansion below is
 * grounded in vocabulary that actually occurs in the Lake County corpus.
 *
 * Expanded terms are scored at a fraction of the weight of terms the user
 * actually typed, so an expansion can raise a relevant document but cannot by
 * itself make an irrelevant one look relevant.
 */

import { normalize, stem, tokenize } from "./text.js";

/** Weight applied to a term the user did not type. */
export const EXPANSION_WEIGHT = 0.45;

export interface Expansion {
  /** Single words are matched as stemmed tokens; phrases as substrings. */
  readonly triggers: readonly string[];
  readonly add: readonly string[];
}

export const QUERY_EXPANSIONS: readonly Expansion[] = Object.freeze([
  {
    triggers: [
      "open roofing",
      "roofing permit still open",
      "five year roofing",
      "five years",
      "1825 days",
    ],
    add: [
      "longest_open_roofing_permit_days",
      "days_open",
      "is_roofing",
      "is_open",
      "five-year open-roofing lead",
      "1825",
      "permit table",
    ],
  },
  {
    triggers: [
      "empty",
      "blank",
      "missing",
      "null",
      "nothing",
      "unpopulated",
      "no value",
      "no data",
      "not populated",
      "always false",
    ],
    add: ["null", "empty", "missing", "unpopulated", "absent", "stays null", "reason"],
  },
  {
    triggers: [
      "blocked",
      "block",
      "gated",
      "denied",
      "forbidden",
      "403",
      "captcha",
      "recaptcha",
      "cloudflare",
      "login",
      "bot challenge",
      "unreachable",
      "tls",
      "unavailable",
      "scrape",
      "scraping",
    ],
    add: [
      "blocked",
      "gated",
      "403",
      "challenge",
      "captcha",
      "login",
      "unreachable",
      "fail-closed",
      "anonymous access",
      "enumeration status",
    ],
  },
  {
    triggers: [
      "records request",
      "public records",
      "foia",
      "chapter 119",
      "request the records",
      "how do i request",
      "who do i ask",
      "custodian",
      "clerk",
      "obtain",
    ],
    add: [
      "records request",
      "recipient office",
      "custodian",
      "clerk",
      "request email",
      "request portal",
      "system scope",
      "records-first",
      "chapter 119",
    ],
  },
  {
    triggers: ["roof", "roofing", "reroof", "re-roof", "shingle"],
    add: ["roof_age_years", "roof_age_basis", "roofing_permit_count", "roofing", "reroof"],
  },
  {
    triggers: [
      "derive",
      "derived",
      "computed",
      "calculated",
      "how was",
      "how is",
      "basis",
      "methodology",
      "formula",
      "where does",
      "come from",
    ],
    add: ["derived", "basis", "computed", "pipeline", "source system"],
  },
  {
    triggers: ["contractor", "who did the work", "builder", "installer", "tradesman"],
    add: [
      "contractor_name",
      "contractor of record",
      "gated",
      "403",
      "cloudflare",
      "clermont",
      "etrakit",
    ],
  },
  {
    triggers: ["bbb", "better business bureau", "rating", "reputation", "review"],
    add: ["bbb_rating", "bbb", "gated", "403", "enrichment"],
  },
  {
    triggers: [
      "tenure",
      "how long",
      "owned",
      "ownership",
      "absentee",
      "holding period",
      "same owner",
    ],
    add: ["no_recorded_sale_in_dor_window", "tenure", "lower bound", "sale window", "dor roll"],
  },
  {
    triggers: [
      "jurisdiction",
      "municipality",
      "municipal",
      "city",
      "town",
      "incorporated",
      "unincorporated",
      "who issues",
    ],
    add: [
      "jurisdiction",
      "municipality",
      "permit authority",
      "unincorporated",
      "building department",
    ],
  },
  {
    triggers: ["coverage", "how many", "count", "total", "rows", "denominator", "scale"],
    add: ["coverage", "denominator", "rows", "count", "assessed parcel count"],
  },
  {
    triggers: [
      "cost",
      "price to run",
      "expensive",
      "cheap",
      "free",
      "spend",
      "bill",
      "infrastructure cost",
      "ongoing",
    ],
    add: ["cost", "ongoing", "infrastructure", "free", "read path", "no server"],
  },
  {
    triggers: [
      "ipfs",
      "cid",
      "gateway",
      "pin",
      "pinning",
      "immutable",
      "publish",
      "published",
      "ipns",
      "filebase",
      "car file",
    ],
    add: ["cid", "ipfs", "ipns", "gateway", "published", "immutable", "filebase", "manifest"],
  },
  {
    triggers: [
      "history",
      "historical",
      "archive",
      "how far back",
      "past permits",
      "older permits",
      "rolling",
    ],
    add: ["rolling window", "365", "archive", "history", "permit_lastmoddate", "current permit"],
  },
  {
    triggers: [
      "coordinate",
      "coordinates",
      "latitude",
      "longitude",
      "geocode",
      "map",
      "radius",
      "location",
      "lat lon",
      "centroid",
    ],
    add: ["latitude", "longitude", "centroid", "gio", "coordinates", "geometry"],
  },
  {
    triggers: ["business", "tenant", "commercial", "naics", "sunbiz", "corporate", "company"],
    add: ["business_account_count", "tangible personal property", "tpp", "naics", "sunbiz"],
  },
  {
    triggers: ["column", "field", "schema", "meaning", "means", "definition", "what is"],
    add: ["column", "schema", "query table", "field", "published column"],
  },
  {
    triggers: ["sale", "sold", "transfer", "deed", "sale price"],
    add: ["last_sale_date", "sale_records_in_window", "sdf", "sale"],
  },
  {
    triggers: ["refresh", "incremental", "update", "rerun", "daily", "delta", "re-run"],
    add: ["incremental", "run", "delta", "window", "refresh", "run history"],
  },
  {
    triggers: ["mcp", "agent", "tool", "chat", "api", "endpoint"],
    add: ["mcp", "agent", "tool", "endpoint", "duckdb"],
  },
  {
    triggers: ["verify", "verified", "proof", "prove", "trust", "checksum", "sha256", "tamper"],
    add: ["verification", "gateway", "sha256", "manifest", "verified"],
  },
  {
    triggers: ["appraiser", "property appraiser", "lakecopropappr"],
    add: ["appraiser", "lakecopropappr", "dor roll", "not exercised"],
  },
  {
    triggers: ["parcel id", "alternate key", "alt key", "join", "key", "identifier"],
    add: ["parcel_identifier", "alt_key", "alternate_key", "join rule", "identifier"],
  },
]);

/** A term the retriever will score, with the weight it carries. */
export interface WeightedTerm {
  term: string;
  weight: number;
}

/**
 * Turn a raw question into weighted terms.
 *
 * Terms the user typed carry weight 1. Terms added by an expansion carry
 * {@link EXPANSION_WEIGHT}, and never overwrite a typed term's weight.
 */
export function expandQuery(query: string): WeightedTerm[] {
  const typed = tokenize(query);
  const weights = new Map<string, number>();
  for (const term of typed) weights.set(term, 1);

  const lowered = normalize(query);
  const typedStems = new Set(typed);

  for (const expansion of QUERY_EXPANSIONS) {
    const hit = expansion.triggers.some((trigger) =>
      trigger.includes(" ") ? lowered.includes(trigger) : typedStems.has(stem(trigger)),
    );
    if (!hit) continue;
    for (const term of tokenize(expansion.add.join(" "))) {
      if (!weights.has(term)) weights.set(term, EXPANSION_WEIGHT);
    }
  }

  return [...weights.entries()].map(([term, weight]) => ({ term, weight }));
}

/**
 * Score literal entity aliases against a question.
 *
 * Alias tables are the deterministic half of the pipeline: when a question
 * names "Groveland" or "roof_age_basis", that document should surface whatever
 * the statistics say. Returns 1 for a whole-phrase hit, 0 otherwise.
 */
export function aliasScore(query: string, aliases: readonly string[]): number {
  if (aliases.length === 0) return 0;
  const lowered = ` ${normalize(query)
    .replace(/[^a-z0-9_ ]+/g, " ")
    .replace(/\s+/g, " ")} `;
  let best = 0;
  for (const alias of aliases) {
    const target = normalize(alias)
      .replace(/[^a-z0-9_ ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (target.length < 3) continue;
    if (lowered.includes(` ${target} `)) {
      // Longer aliases are more specific, so they earn more of the boost.
      best = Math.max(best, Math.min(1, 0.6 + target.length / 40));
    }
  }
  return best;
}
