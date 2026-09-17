import type { QueryRow } from "../data/duckdb.js";

export interface TurnMessage {
  role: "user" | "assistant";
  content: string;
}

/** Exact query output, never fields parsed from model-written prose. */
export interface QueryEvidence {
  tool: string;
  sql: string | null;
  sourceSystems: string[];
  runId: string | null;
  rootCid: string | null;
  rowCount: number;
  rows: QueryRow[];
}

export type AnswerGrounding =
  | { mode: "canonical-query-rows" | "no-verified-records"; evidence: QueryEvidence[] }
  | {
      mode: "source-only-refusal";
      runId: string | null;
      rootCid: string | null;
      capabilities: { currentOpenPermitStatus: "unsupported"; openPermitDuration: "unsupported" };
    };

export const RECORD_TOOLS = new Set([
  "searchProperties",
  "getProperty",
  "searchBusinessAccounts",
  "runSql",
]);

const MAX_ANSWER_ROWS = 25;

/** Clarifying a duration cannot make a previously unsupported open query eligible. */
export function requestsUnsupportedOpenPermits(messages: readonly TurnMessage[]): boolean {
  const users = messages.filter((message) => message.role === "user");
  const latest = users.at(-1)?.content ?? "";
  const direct = (text: string): boolean =>
    /\b(?:permits?|roofing)\b/i.test(text) &&
    /\b(?:open|unclosed|outstanding|pending|active)\b/i.test(text);
  if (direct(latest)) return true;
  // An explicit independent building-age question ends the prior open-query
  // context. A bare "over five years" or "use 365 days" does not.
  if (/\b(?:roof\s+age|roofs?\s+(?:older|aged)|aged[- ]roofs?|built[- ]year)\b/i.test(latest)) {
    return false;
  }
  const clarifiesDuration =
    /\b(?:days?|weeks?|months?|years?)\b/i.test(latest) ||
    /^\s*(?:yes[,\s]*)?(?:(?:use|over|more than|at least|>)\s*)?(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*[.!?]*\s*$/i.test(
      latest,
    );
  return clarifiesDuration && users.slice(0, -1).some((message) => direct(message.content));
}

export function requestsPropertyList(messages: readonly TurnMessage[]): boolean {
  const latest = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  return (
    /\b(?:propert(?:y|ies)|parcels?|homes?)\b/i.test(latest) &&
    /\b(?:which|show|list|find|give|identify|return)\b/i.test(latest)
  );
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  return typeof value === "string" ? value : JSON.stringify(value);
}

const PROPERTY_FIELDS = [
  "request_identifier",
  "parcel_identifier",
  "address_street",
  "address_city",
  "address_zip",
  "latitude",
  "longitude",
  "built_year",
  "year_built",
  "roof_age_years",
  "roof_age_basis",
  "roof_age_confidence",
  "roof_age_caveat",
  "roof_age_as_of",
  "roof_age_as_of_date",
  "source_systems",
] as const;

/** Discard model prose for record tools; even a correct citation is not grounding. */
export function finalizeRecordAnswer(
  evidence: readonly QueryEvidence[],
  propertyList: boolean,
): { answer: string; grounding: AnswerGrounding } | null {
  const records = evidence.filter((entry) => RECORD_TOOLS.has(entry.tool));
  if (records.length === 0 && !propertyList) return null;
  let remaining = MAX_ANSWER_ROWS;
  const bounded = records.map((entry) => {
    const eligible = propertyList
      ? entry.rows.filter(
          (row) => typeof row.request_identifier === "string" && row.request_identifier.length > 0,
        )
      : entry.rows;
    const rows = eligible.slice(0, remaining).map((row) => ({ ...row }));
    remaining -= rows.length;
    return { ...entry, rows };
  });
  if (!bounded.some((entry) => entry.rows.length > 0)) {
    return {
      answer:
        "No verified property or account rows were returned by record queries in this turn to support the requested result list. Metadata, city-centre results, and model-written examples are not property records. This is not proof that no matching records exist; no identifiers, addresses, coordinates, or totals will be guessed.",
      grounding: { mode: "no-verified-records", evidence: bounded },
    };
  }
  const sections = bounded
    .filter((entry) => entry.rows.length > 0)
    .map((entry) => {
      const lines = entry.rows.map((row) => {
        const fields =
          typeof row.request_identifier === "string"
            ? PROPERTY_FIELDS.filter((field) => field in row)
            : Object.keys(row);
        return `- ${fields.map((field) => `${field}: ${valueText(row[field])}`).join("; ")}`;
      });
      return [
        `${entry.tool}: showing ${entry.rows.length} exact returned rows; tool-reported row count: ${entry.rowCount} (not asserted as total matches).`,
        ...lines,
        `Evidence: ${entry.sourceSystems.join(", ") || "source systems not supplied"}; snapshot ${entry.runId ?? "unknown"}; CID ${entry.rootCid ?? "unpublished/unknown"}.`,
      ].join("\n");
    });
  return {
    answer: [
      "These results are rendered directly from this turn's query rows; model-written record details are not used.",
      ...sections,
      "Roof ages with built_year or built_year_proxy basis (including year_built evidence) are low-confidence building-age proxies, not measured roof ages; incomplete permit history may omit a later replacement. The snapshot identity is listed above; an age as-of date not returned in a row is not inferred. Unknown values are not zero, a confirmed absence, current permit status, or verified contractor/license/BBB evidence.",
    ].join("\n\n"),
    grounding: { mode: "canonical-query-rows", evidence: bounded },
  };
}
