/**
 * Append-only run history for a county's publications.
 *
 * Each run pins a new immutable snapshot and re-points one mutable IPNS name
 * at it. The history is what keeps the superseded snapshots citable: it holds
 * every prior root, manifest and CAR CID, the sources and windows that were
 * read, the per-table row deltas that prove the run actually ingested
 * something new, the limitations that were hit, and which gateways served the
 * bytes back. Appending is therefore the only permitted mutation — a prior
 * entry can never be edited, re-numbered or dropped, because a rewritten
 * history is indistinguishable from a fabricated one.
 *
 * @module core/run-history
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { isCidV1Base32 } from "./cid.mjs";

/** Schema version stamped into every history document this runtime writes. */
export const RUN_HISTORY_SCHEMA_VERSION = "elephant.run-history.v1";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const IPNS_NAME_PATTERN = /^k[a-z0-9]{20,}$/;

const cidSchema = z.string().refine(isCidV1Base32, "must be a CIDv1 base32 string");
const isoTimestamp = z.string().regex(ISO_TIMESTAMP_PATTERN, "must be an ISO-8601 UTC timestamp");
const counter = z.number().int().nonnegative();

/** One source read by a run, with the window that was requested from it. */
export const runSourceSchema = z
  .object({
    name: z.string().trim().min(1),
    url: z.string().url(),
    window: z.string().trim().min(1).nullable(),
    recordCount: counter,
  })
  .strict();

/**
 * How a table's numbers were derived, for records old and new.
 *
 * @param {{basis?: string}} table - A run's table accounting record.
 * @returns {"row-hash" | "row-count"} The basis, defaulting for older records.
 */
export function tableBasis(table) {
  return table.basis === "row-count" ? "row-count" : "row-hash";
}

/**
 * Per-table row accounting, the evidence that ingestion is ongoing.
 *
 * Two bases, because only one table is hashed per row. `row-hash` carries real
 * insert/update/unchanged/removed counts derived from comparing every row's
 * hash against the previous run. `row-count` carries only the row total and its
 * movement since the previous run, because no per-row snapshot exists for that
 * table — and it says so rather than reporting four zeroes that would read as
 * "nothing changed" when the truth is "not measured at that grain".
 *
 * Tracking only the hashed table is what made a real permit movement
 * (17,457 -> 17,671 source-side, all of it validUnlinked) invisible in a run
 * that correctly reported no property row had changed.
 */
export const runTableSchema = z
  .object({
    name: z.string().trim().min(1),
    rows: counter,
    /**
     * Optional, never defaulted. A zod `.default()` here injects the field into
     * records read back from disk, which makes validation rewrite history that
     * is supposed to be immutable — `appendRun` compares the validated result
     * against the stored bytes and correctly refuses to write. Records written
     * before this field existed have no basis and are row-hash by construction;
     * read them with `tableBasis` rather than defaulting them at parse time.
     */
    basis: z.enum(["row-hash", "row-count"]).optional(),
    inserted: counter.optional(),
    updated: counter.optional(),
    unchanged: counter.optional(),
    removed: counter.optional(),
    previousRows: counter.optional(),
    rowsDelta: z.number().int().optional(),
  })
  .strict()
  .refine(
    (table) =>
      tableBasis(table) === "row-hash"
        ? [table.inserted, table.updated, table.unchanged, table.removed].every(
            (value) => typeof value === "number",
          )
        : true,
    { message: "a row-hash table must carry inserted/updated/unchanged/removed" },
  );

/** One immutable, already-published run. */
export const runRecordSchema = z
  .object({
    runId: z.string().regex(RUN_ID_PATTERN, "must be a stable run identifier"),
    candidateWorkflowRunId: z
      .string()
      .regex(/^(?:local|[1-9][0-9]{0,19})$/)
      .optional(),
    startedAt: isoTimestamp,
    finishedAt: isoTimestamp,
    mode: z.enum(["full", "incremental"]),
    sources: z.array(runSourceSchema),
    tables: z.array(runTableSchema),
    limitations: z.array(z.string().trim().min(1)),
    rootCid: cidSchema,
    manifestCid: cidSchema,
    carCid: cidSchema,
    ipnsName: z.string().regex(IPNS_NAME_PATTERN, "must be an IPNS network key").nullable(),
    resolvedCid: cidSchema.nullable(),
    verifiedGateways: z.array(z.string().url()),
    status: z.enum(["succeeded", "partial", "failed"]),
  })
  .strict()
  .refine(
    (run) => Date.parse(run.finishedAt) >= Date.parse(run.startedAt),
    "finishedAt must not precede startedAt",
  );

/** The whole history document, newest run first. */
export const runHistorySchema = z
  .object({
    schemaVersion: z.literal(RUN_HISTORY_SCHEMA_VERSION),
    runs: z.array(runRecordSchema),
  })
  .strict()
  .refine((history) => {
    const ids = history.runs.map((run) => run.runId);
    return new Set(ids).size === ids.length;
  }, "runs must have unique runId values");

/**
 * Render Zod issues as one readable, actionable error message.
 *
 * @param {import("zod").ZodError} error validation error
 * @returns {string}
 */
function describeIssues(error) {
  return error.issues
    .map((issue) => {
      const location = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Validate a run history document, throwing a single clear error.
 *
 * @param {unknown} value candidate history
 * @returns {import("zod").infer<typeof runHistorySchema>} the validated history
 */
export function validateRunHistory(value) {
  const result = runHistorySchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid run history: ${describeIssues(result.error)}`);
  }
  return result.data;
}

/**
 * Validate a single run record, throwing a single clear error.
 *
 * @param {unknown} value candidate run record
 * @returns {import("zod").infer<typeof runRecordSchema>} the validated record
 */
export function validateRunRecord(value) {
  const result = runRecordSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid run record: ${describeIssues(result.error)}`);
  }
  return result.data;
}

/**
 * Recursively serialize JSON with lexicographically sorted object keys, so two
 * documents can be compared for meaning rather than for formatting.
 *
 * @param {unknown} value JSON-compatible value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Read a history file, keeping both the validated document and the runs
 * exactly as they were stored, so an append can prove it changed nothing.
 *
 * @param {string} historyPath path to the history JSON file
 * @returns {Promise<{ history: import("zod").infer<typeof runHistorySchema>, storedRuns: unknown[] }>}
 */
async function loadRunHistory(historyPath) {
  let text;
  try {
    text = await readFile(historyPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        history: { schemaVersion: RUN_HISTORY_SCHEMA_VERSION, runs: [] },
        storedRuns: [],
      };
    }
    throw error;
  }
  const parsed = JSON.parse(text);
  return {
    history: validateRunHistory(parsed),
    storedRuns: Array.isArray(parsed?.runs) ? parsed.runs : [],
  };
}

/**
 * Read a run history from disk, returning an empty history when the file does
 * not exist yet.
 *
 * @param {string} historyPath path to the history JSON file
 * @returns {Promise<import("zod").infer<typeof runHistorySchema>>}
 */
export async function readRunHistory(historyPath) {
  return (await loadRunHistory(historyPath)).history;
}

/**
 * Prepend one completed run to the history and write it back.
 *
 * The only accepted change is a new newest entry. A repeated runId is refused
 * outright, and the retained tail is compared against what was on disk so a
 * silently altered prior run is refused too — published CIDs are immutable.
 *
 * @param {string} historyPath path to the history JSON file
 * @param {unknown} runRecord the completed run to record
 * @returns {Promise<import("zod").infer<typeof runHistorySchema>>} the written history
 */
export async function appendRun(historyPath, runRecord) {
  if (typeof historyPath !== "string" || historyPath.length === 0) {
    throw new TypeError("historyPath is required");
  }
  const { history: previous, storedRuns } = await loadRunHistory(historyPath);
  const record = validateRunRecord(runRecord);
  if (previous.runs.some((run) => run.runId === record.runId)) {
    throw new Error(
      `Run '${record.runId}' is already recorded in ${historyPath}; published run history is append-only`,
    );
  }
  const next = validateRunHistory({
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    runs: [record, ...previous.runs],
  });
  if (
    next.runs.length !== storedRuns.length + 1 ||
    canonicalJson(next.runs.slice(1)) !== canonicalJson(storedRuns)
  ) {
    throw new Error(
      `Refusing to write ${historyPath}: appending run '${record.runId}' would alter a previously recorded run`,
    );
  }
  const body = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(historyPath), { recursive: true });
  const temporaryPath = `${historyPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, body);
  await rename(temporaryPath, historyPath);
  return next;
}

/**
 * Union two histories of the same county without altering either's records.
 *
 * A scheduled run publishes from a fresh checkout, appends its run to the
 * repository's committed history, and then throws the file away with the
 * runner — so the next scheduled run started from the committed file again and
 * every publish between commits vanished from the record. Carrying the file
 * between runs fixes that, but a carried copy and a committed copy can each
 * hold runs the other does not, and neither may overwrite the other.
 *
 * This merges them: a runId in both must be byte-identical in both, a runId in
 * either survives, and the result is ordered newest first. Run ids are compact
 * UTC timestamps, so lexicographic order is chronological order. Nothing is
 * edited, re-numbered or dropped, which is the same guarantee `appendRun`
 * makes — a rewritten history is indistinguishable from a fabricated one.
 *
 * @param {unknown} base history to merge into
 * @param {unknown} incoming history to merge from
 * @returns {import("zod").infer<typeof runHistorySchema>} the merged history
 */
export function mergeRunHistories(base, incoming) {
  const left = validateRunHistory(base);
  const right = validateRunHistory(incoming);
  /** @type {Map<string, import("zod").infer<typeof runRecordSchema>>} */
  const byId = new Map();
  for (const run of [...left.runs, ...right.runs]) {
    const existing = byId.get(run.runId);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(run)) {
        throw new Error(
          `Refusing to merge run histories: run '${run.runId}' differs between them; a published run is immutable`,
        );
      }
      continue;
    }
    byId.set(run.runId, run);
  }
  return validateRunHistory({
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    runs: [...byId.values()].sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0)),
  });
}

/**
 * Merge a history file on disk with another, writing the union back.
 *
 * A missing file on either side is an empty history, so the first scheduled run
 * — which has no carried copy yet — is not a failure.
 *
 * @param {string} historyPath history file to write
 * @param {string} otherPath history file to merge in
 * @returns {Promise<import("zod").infer<typeof runHistorySchema>>} the written history
 */
export async function mergeRunHistoryFile(historyPath, otherPath) {
  const merged = mergeRunHistories(
    (await loadRunHistory(historyPath)).history,
    (await loadRunHistory(otherPath)).history,
  );
  const body = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(historyPath), { recursive: true });
  const temporaryPath = `${historyPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, body);
  await rename(temporaryPath, historyPath);
  return merged;
}

/**
 * Coerce a `key -> rowHash` input into a Map.
 *
 * @param {Map<string, string> | Record<string, string> | undefined | null} rows row hashes by key
 * @param {string} field field name used in the thrown error
 * @returns {Map<string, string>}
 */
function asRowMap(rows, field) {
  if (rows === undefined || rows === null) return new Map();
  if (rows instanceof Map) return rows;
  if (typeof rows === "object" && !Array.isArray(rows)) {
    return new Map(Object.entries(rows));
  }
  throw new TypeError(`${field} must be a Map or a plain object of key -> rowHash`);
}

/**
 * Compare two snapshots of a table by row hash.
 *
 * A row present in both with the same hash is unchanged, a differing hash is
 * an update, a key only in the current snapshot is an insert, and a key only
 * in the previous snapshot was removed. These counts are what an incremental
 * run publishes to show it ingested something.
 *
 * @param {Map<string, string> | Record<string, string>} previousRows key -> rowHash before the run
 * @param {Map<string, string> | Record<string, string>} currentRows key -> rowHash after the run
 * @returns {{ inserted: number, updated: number, unchanged: number, removed: number }}
 */
export function computeTableDeltas(previousRows, currentRows) {
  const previous = asRowMap(previousRows, "previousRows");
  const current = asRowMap(currentRows, "currentRows");
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [key, hash] of current) {
    if (!previous.has(key)) inserted += 1;
    else if (previous.get(key) === hash) unchanged += 1;
    else updated += 1;
  }
  let removed = 0;
  for (const key of previous.keys()) {
    if (!current.has(key)) removed += 1;
  }
  return { inserted, updated, unchanged, removed };
}
