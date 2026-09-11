/**
 * The evaluation set.
 *
 * Twenty-four realistic questions with the documents that should answer them, plus
 * five questions the corpus deliberately cannot answer. The negatives are not
 * padding: an evaluation that only measures whether the right document is found
 * cannot detect a retriever that returns something for everything, and the
 * whole point of the confidence policy is that this one does not.
 *
 * `expected` lists document ids, not chunk ids, because a question is answered
 * by a document regardless of which of its chunks surfaces.
 */

export interface EvalCase {
  id: string;
  question: string;
  /** Document ids that answer the question. Empty means it must abstain. */
  expected: string[];
  /** Why the question is in the set. */
  intent: string;
}

export const EVAL_CASES: readonly EvalCase[] = Object.freeze([
  {
    id: "contractor-null",
    // Asked on the reader's false premise on purpose: the column is empty on
    // most of the county but not all of it, and the retrieved documents have to
    // be the ones that correct that rather than confirm it.
    question: "Why is contractor_name empty for every property?",
    expected: ["column:contractor_name", "source:contractor-identity", "access:cloudflare"],
    intent: "The flagship 'why is this field empty' question the SQL tools cannot answer.",
  },
  {
    id: "blocked-jurisdictions",
    question: "Which permit jurisdictions are blocked and how do I request their records?",
    expected: ["jurisdiction:overview"],
    intent: "Multi-entity question that must land on the overview rather than one city.",
  },
  {
    id: "leesburg-records",
    question: "How do I request building permit records from Leesburg?",
    expected: ["jurisdiction:leesburg"],
    intent: "Named-entity records-request routing.",
  },
  {
    id: "mount-dora-records",
    question: "Who do I contact for Mount Dora building permit records?",
    expected: ["jurisdiction:mount-dora"],
    intent: "Named-entity routing where the city name is two words.",
  },
  {
    id: "roof-age-derivation",
    question: "How was roof age derived and what does the basis mean?",
    expected: ["column:roof_age_basis", "column:roof_age_years"],
    intent: "Derivation question; the answer is a methodology, not a number.",
  },
  {
    id: "permit-layer-coverage",
    question: "What does the Lake County CD Plus permit layer actually cover?",
    expected: ["source:cdplus", "limitation:permit-window", "limitation:municipal-coverage"],
    intent: "Source-coverage question spanning a source document and its limitations.",
  },
  {
    id: "permit-history-depth",
    question: "How far back does the permit history go?",
    expected: ["limitation:permit-window", "source:cdplus"],
    intent: "Time-coverage question phrased with none of the corpus's own vocabulary.",
  },
  {
    id: "missing-coordinates",
    question: "Why do some properties have no latitude or longitude?",
    expected: [
      "column:latitude",
      "column:longitude",
      "source:gio",
      "limitation:coordinate-vintage",
    ],
    intent: "Null-explanation question with a release-year cause.",
  },
  {
    id: "tenure",
    question: "Can I prove how long an owner has held a property?",
    expected: ["source:sdf", "column:no_recorded_sale_in_dor_window"],
    intent: "Honesty question: the answer is 'no, and here is why'.",
  },
  {
    id: "sunbiz",
    question: "What does has_sunbiz_tenant mean and why is it always false?",
    expected: ["column:has_sunbiz_tenant", "source:sunbiz"],
    intent: "Column semantics for a not-ingested source.",
  },
  {
    id: "bbb",
    question: "Why is bbb_rating null?",
    expected: ["column:bbb_rating", "source:bbb"],
    intent: "Second gated column, different blocker from the contractor one.",
  },
  {
    id: "parcel-count",
    question: "How many parcels are in the published dataset and what is the denominator?",
    expected: ["coverage:denominator", "coverage:tables"],
    intent: "Data-scale question that must reach the coverage snapshot.",
  },
  {
    id: "clermont-contractors",
    question: "Is there any city portal that publishes contractor names?",
    expected: ["jurisdiction:clermont", "source:contractor-identity"],
    intent: "Question whose answer is the one jurisdiction of fifteen that does, and is harvested.",
  },
  {
    id: "cost",
    question: "What is the ongoing infrastructure cost of running this?",
    expected: ["doc:cost"],
    intent: "Prose document retrieval.",
  },
  {
    id: "incremental-run",
    question: "How do I run an incremental refresh of just the permits?",
    expected: ["doc:runbook"],
    intent: "Operational prose retrieval with command-shaped vocabulary.",
  },
  {
    id: "publication",
    question: "What is the IPNS name and the root CID of the published data?",
    expected: ["publication:run"],
    intent: "Publication identity, answerable from the run pointer.",
  },
  {
    id: "permit-join",
    question: "How do permit records join to parcels?",
    expected: ["source:cdplus", "column:alt_key", "source:nal"],
    intent: "Join-rule question spanning two sources and a column.",
  },
  {
    id: "business-accounts",
    question: "What does business_account_count measure?",
    expected: ["column:business_account_count", "source:tpp"],
    intent: "Column semantics where the naive reading is wrong.",
  },
  {
    id: "appraiser",
    question: "Was the county property appraiser website used as a data source?",
    expected: ["source:appraiser"],
    intent: "Negative-result question with a correction attached.",
  },
  {
    id: "sample-extract",
    question: "What is in the open roofing permits sample extract?",
    expected: ["sample:open-roofing-permits"],
    intent: "Published-artifact retrieval.",
  },
  {
    id: "five-year-roofing-leads",
    question: "How is a roofing permit still open for five years defined and evidenced?",
    expected: [
      "permit:table",
      "column:longest_open_roofing_permit_days",
      "permit-column:days_open",
      "coverage:signals",
    ],
    intent:
      "Pins the roofing-specific duration semantic so a generic open permit cannot become a roofing lead.",
  },
  {
    id: "clermont-contractor-coverage",
    question: "How many Clermont permit rows name contractors and is that countywide coverage?",
    expected: [
      "coverage:clermont-contractors",
      "limitation:contractor-coverage",
      "jurisdiction:clermont",
    ],
    intent: "Measured partial contractor coverage with the one-of-fifteen boundary.",
  },
  {
    id: "permit-grain-details",
    question: "Where are full permit number status dates source URL and linkage details stored?",
    expected: [
      "permit:table",
      "permit-column:permit_number",
      "permit-column:source_url",
      "permit-column:linkage_status",
    ],
    intent: "Verifies that retrieval knows the companion one-row-per-permit table.",
  },
  {
    id: "source-limitations-overview",
    question: "What source coverage limitations constrain this candidate dataset?",
    expected: ["coverage:limitations"],
    intent: "Broad limitation question must reach the run-carried honesty statement.",
  },
  {
    id: "negative-income",
    question: "What is the median household income in Lake County?",
    expected: [],
    intent: "Plausible county question the corpus has no document for. Must abstain.",
  },
  {
    id: "negative-license",
    question: "How do I renew my Florida driver licence?",
    expected: [],
    intent: "Adjacent-government question. Must abstain.",
  },
  {
    id: "negative-other-county",
    question: "What is the population of Orange County California?",
    expected: [],
    intent: "Out-of-domain question sharing the word county. Must abstain.",
  },
  {
    id: "negative-weather",
    question: "Will it rain in Tavares tomorrow?",
    expected: [],
    intent: "Names a jurisdiction in the corpus but asks something it cannot answer. Must abstain.",
  },
  {
    id: "negative-recipe",
    question: "Give me a recipe for key lime pie",
    expected: [],
    intent: "Entirely unrelated. Must abstain.",
  },
]);

/** Cases that must return evidence. */
export const POSITIVE_CASES = EVAL_CASES.filter((entry) => entry.expected.length > 0);
/** Cases that must abstain. */
export const NEGATIVE_CASES = EVAL_CASES.filter((entry) => entry.expected.length === 0);
