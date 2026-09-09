/**
 * Natural language to the published table's own filter contract.
 *
 * Retrieval indexed the dataset's *metadata* — column definitions, docs, sample
 * extracts — so "why is contractor_name empty" was answered well and "aged roofs
 * with an open roofing permit in Clermont" was not answered at all. The obvious
 * fix, BM25 over a per-parcel text profile, was built and measured first and was
 * worse than nothing: that exact question returned a Clermont parcel with zero
 * open roofing permits, because a bag of words scores "open roofing permit" as
 * three soft terms rather than as a constraint.
 *
 * Constraints are therefore resolved structurally against `propertyFiltersSchema`
 * — the same contract the REST search, the MCP tool and the agent already use —
 * and only the words left over become free text. Nothing here is statistical, so
 * an interpretation is reproducible and can be shown to the reader instead of
 * being taken on trust.
 */

/** The roll's own vocabulary, so a city is only matched if it exists. */
export interface ParcelVocabulary {
  readonly cities: readonly string[];
  readonly propertyTypes: readonly string[];
}

/** One filter, and the words that produced it. */
export interface InterpretedFilter {
  /** Filter key in `propertyFiltersSchema`. */
  readonly filter: string;
  /** Value applied. */
  readonly value: string | number | boolean;
  /** The phrase from the question that produced it. */
  readonly phrase: string;
}

export interface InterpretedParcelQuery {
  /** Filters, shaped for `propertyFiltersSchema`. */
  readonly filters: Record<string, string | number | boolean>;
  /** One entry per applied filter, in the order they were found. */
  readonly interpretation: InterpretedFilter[];
  /** True when at least one constraint resolved against the parcels. */
  readonly answersAboutParcels: boolean;
}

/** Roof age a question means by "aged" or "old" with no number given. */
export const DEFAULT_AGED_ROOF_YEARS = 15;

/** Days in the "open more than five years" signal the coverage snapshot uses. */
const FIVE_YEARS_IN_DAYS = 1825;

/** Words that carry no constraint and should not survive as free text. */
const STOP_PHRASES = [
  "parcels",
  "parcel",
  "properties",
  "property",
  "homes",
  "home",
  "houses",
  "house",
  "show",
  "me",
  "find",
  "list",
  "all",
  "with",
  "an",
  "a",
  "the",
  "in",
  "on",
  "of",
  "and",
  "that",
  "which",
  "have",
  "has",
  "owned",
  "still",
  "are",
  "is",
  "years",
  "year",
  "old",
  "older",
  "than",
  "or",
  "over",
  "more",
  "roofs",
  "roof",
  "owners",
  "owner",
  "outside",
  "out",
  "state",
  "county",
  "worth",
  "market",
  "value",
  "built",
  "before",
  "after",
  "aged",
  "open",
  "roofing",
  "permit",
  "permits",
  "recorded",
  "sale",
  "no",
  "business",
  "account",
  "five",
  "absentee",
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

/** Lowercase, collapse whitespace, drop punctuation that is never meaningful. */
function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[?!,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse "300k", "1.5m", "250,000" into a number. */
function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(cleaned);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return base * multiplier;
}

/**
 * Resolve one natural-language question into filters over the published table.
 *
 * Matched phrases are removed from the text as they are found, so a phrase can
 * never be counted twice and whatever remains is genuinely unclaimed.
 */
export function interpretParcelQuery(
  question: string,
  vocabulary: ParcelVocabulary,
): InterpretedParcelQuery {
  let text = normalizeQuestion(question);
  const filters: Record<string, string | number | boolean> = {};
  const interpretation: InterpretedFilter[] = [];

  /** Apply a filter once, recording the phrase, and consume the phrase. */
  const apply = (
    filter: string,
    value: string | number | boolean,
    phrase: string,
    consume = true,
  ): void => {
    if (filter in filters) return;
    filters[filter] = value;
    interpretation.push({ filter, value, phrase: phrase.trim() });
    if (consume) text = text.replace(phrase, " ").replace(/\s+/g, " ").trim();
  };

  // Cities first, and longest first so "mount dora" is not shadowed by a
  // one-word city that happens to be a substring.
  for (const city of [...vocabulary.cities].sort((a, b) => b.length - a.length)) {
    const needle = city.toLowerCase();
    if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) {
      apply("city", city, needle);
      break;
    }
  }

  for (const type of [...vocabulary.propertyTypes].sort((a, b) => b.length - a.length)) {
    // "SingleFamily" is written "single family" in a question.
    const spaced = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    if (text.includes(spaced)) {
      apply("propertyType", type, spaced);
      break;
    }
  }

  // A permit open beyond five years, before the generic open-permit rule so the
  // more specific reading wins.
  const stalled =
    /(?:open|outstanding)[^.]{0,24}?(?:more than|over|longer than)\s+(\d+|five)\s+years?/.exec(
      text,
    ) ?? /(?:more than|over|longer than)\s+(\d+|five)\s+years?[^.]{0,24}?open/.exec(text);
  if (stalled) {
    const years = NUMBER_WORDS[stalled[1] ?? ""] ?? Number(stalled[1]);
    const days = Number.isFinite(years) ? Math.round(years * 365) : FIVE_YEARS_IN_DAYS;
    apply("minOpenPermitDays", days, stalled[0]);
  }

  // Roof age: an explicit number wins over the documented default.
  const roofNumber =
    /roofs?\s+(?:that are\s+)?(?:aged\s+)?(\d+)\s*(?:years?)?\s*(?:or older|or more|and older|\+)/.exec(
      text,
    ) ??
    /roofs?\s+(?:older|more)\s+than\s+(\d+)/.exec(text) ??
    /roofs?\s+(?:over|above|past)\s+(\d+)/.exec(text) ??
    /(\d+)\s*(?:\+|or more)?\s*years?\s+old(?:er)?\s+roofs?/.exec(text) ??
    /roofs?[^.]{0,16}?\b(\d+)\s+years?\s+(?:or older|old)/.exec(text);
  if (roofNumber) {
    const years = Number(roofNumber[1]);
    if (Number.isFinite(years)) apply("minRoofAge", years, roofNumber[0]);
  } else {
    const agedPhrase = /\b(aged|ageing|aging|old|older|ancient|failing)\s+roofs?\b/.exec(text);
    if (agedPhrase) apply("minRoofAge", DEFAULT_AGED_ROOF_YEARS, agedPhrase[0]);
  }

  // Permit posture. Roofing-specific first.
  const openRoofing =
    /open\s+roofing\s+permits?/.exec(text) ??
    /roofing\s+permits?\s+(?:that are\s+)?(?:still\s+)?open/.exec(text);
  if (openRoofing) apply("hasOpenRoofingPermit", true, openRoofing[0]);
  else {
    const anyPermit = /\b(?:with|has|having)\s+(?:a\s+|any\s+)?permits?\b/.exec(text);
    if (anyPermit) apply("hasPermits", true, anyPermit[0]);
  }

  // Owner locality.
  const outOfState = /\bout[\s-]of[\s-]state\b|\boutside (?:the )?state\b/.exec(text);
  if (outOfState) apply("ownerOutOfState", true, outOfState[0]);
  const outOfCounty = /\bout[\s-]of[\s-]county\b|\boutside (?:the )?county\b/.exec(text);
  if (outOfCounty) apply("ownerOutOfCounty", true, outOfCounty[0]);
  // "absentee" alone means out of county unless a stronger reading already won.
  if (!outOfState && !outOfCounty && /\babsentee\b/.test(text)) {
    apply("ownerOutOfCounty", true, "absentee");
  }

  const noSale = /\bno\s+(?:recorded\s+)?sale\b|\bnever\s+sold\b/.exec(text);
  if (noSale) apply("noRecordedSale", true, noSale[0]);

  const business = /\bbusiness\s+accounts?\b|\btpp\s+accounts?\b/.exec(text);
  if (business) apply("hasBusinessAccount", true, business[0]);

  // Money and year bounds.
  const minMoney =
    /(?:worth|value|valued)?\s*(?:more than|over|above|at least|greater than)\s*\$?\s*([\d.,]+\s*[km]?)/.exec(
      text,
    );
  if (minMoney) {
    const amount = parseMoney(minMoney[1] ?? "");
    if (amount !== null && amount >= 1000) apply("minMarketValue", amount, minMoney[0]);
  }
  const maxMoney = /(?:under|below|less than|at most)\s*\$?\s*([\d.,]+\s*[km]?)/.exec(text);
  if (maxMoney) {
    const amount = parseMoney(maxMoney[1] ?? "");
    if (amount !== null && amount >= 1000) apply("maxMarketValue", amount, maxMoney[0]);
  }

  const builtBefore = /built\s+(?:before|prior to|earlier than)\s+(\d{4})/.exec(text);
  if (builtBefore) apply("maxBuiltYear", Number(builtBefore[1]) - 1, builtBefore[0]);
  const builtAfter = /built\s+(?:after|since|later than)\s+(\d{4})/.exec(text);
  if (builtAfter) apply("minBuiltYear", Number(builtAfter[1]) + 1, builtAfter[0]);

  // Whatever is left, minus words that never carried a constraint, is free text.
  const residual = text
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_PHRASES.includes(word) && !/^\d+$/.test(word))
    .join(" ")
    .trim();
  if (residual.length > 0) filters.q = residual;

  return { filters, interpretation, answersAboutParcels: interpretation.length > 0 };
}
