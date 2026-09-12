#!/usr/bin/env node
/**
 * Live-network half of the Clermont permit harvester.
 *
 * `src/counties/lake/clermont-permits.mjs` holds every parsing and
 * normalization decision and stays importable with no network; this script
 * drives it against the portal and writes the artifact tree the
 * `county-permit-adapter` skill specifies:
 *
 *   data/artifacts/permits/lake/<jobId>/
 *     permit-lists/clermont-permit-index.json   enumeration output
 *     raw/<permit>.html                         detail page as served
 *     extracted/<permit>.json                   normalized permit record
 *     dead/<permit>.json                        permanent source failure, recorded not retried
 *     status/<alt_key>.json                     per-parcel completion status
 *     license-directory.html                    the page the licence index is built from
 *     throughput.json                           measured source performance
 *     coverage.json                             honest per-jurisdiction coverage
 *
 * Everything is resumable: `enumerate` and `harvest` skip work whose artifact
 * already exists — captured under `extracted/` or recorded dead under `dead/` —
 * so re-running the same `--job-id` re-sends only what is missing or genuinely
 * retryable. A permanent source failure is recorded once and never refetched;
 * a fetched permit with no parcel key is retained as valid-unlinked
 * (`docs/lake-kit-deviations.md` §23).
 *
 * **Kit deviations recorded for this file:** §19 (this harvest was first run
 * before its benchmark, against `county-permit-adapter`'s ordering), §20 (permit-
 * number prefix enumeration is not a kit harvest pattern) and §23, all in
 * `docs/lake-kit-deviations.md`.
 *
 * Usage:
 *   node scripts/lake/clermont-permits.mjs measure   [--sample 20] [--parcel-sample 10]
 *                                                    [--prefix-sample 10] [--concurrency 1,2]
 *   node scripts/lake/clermont-permits.mjs enumerate [--years 25,26] [--job-id <id>]
 *                                                    [--max-attempts 4]
 *   node scripts/lake/clermont-permits.mjs harvest   [--job-id <id>] [--concurrency 2]
 *                                                    [--limit N] [--only-roofing] [--delay-ms 0]
 *                                                    [--max-attempts 4]
 *   node scripts/lake/clermont-permits.mjs renormalize [--job-id <id>]
 *   node scripts/lake/clermont-permits.mjs export    [--job-id <id>] [--out <path>]
 *   node scripts/lake/clermont-permits.mjs coverage  [--job-id <id>]
 *
 * @module scripts/lake/clermont-permits
 */

import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  clermontPermitLoadRow,
  createClermontPermitSession,
  estimateHarvestDuration,
  expandPermitPrefix,
  normalizeClermontPermit,
  parsePermitDetailHtml,
  permitYearPrefixes,
  selectContractorOfRecord,
  sizeClermontStrategies,
  summarizeLatencies,
  walkPermitPrefixes,
  CLERMONT_ETRAKIT_SEARCH_URL,
  CLERMONT_PERMIT_LOAD_COLUMNS,
  FEASIBILITY_GATE_HOURS,
  JURISDICTION_KEY,
} from "../../src/counties/lake/clermont-permits.mjs";
import { licenseIndexFromSearchPage } from "../../src/counties/lake/etrakit-adapter.mjs";
import { LAKE_PERMIT_JURISDICTIONS } from "../../src/counties/lake/permit-routing.mjs";
import { mapWithConcurrency } from "../../src/counties/lake/sources.mjs";
import { normalizedPermitRecordSchema } from "../../src/permits/contracts.mjs";

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEED_PATH = path.join(RUNTIME_ROOT, "data", "seeds", "lake.csv");
const LICENSE_DIRECTORY_SOURCE_URL = CLERMONT_ETRAKIT_SEARCH_URL;
const LICENSE_DIRECTORY_VALIDITY_BOUNDARY =
  "contractor-registration-at-capture-not-historical-license-validity";

export const CLERMONT_TERMINAL_DEAD_ERROR_CODES = Object.freeze([
  "source_record_not_found",
  "source_record_gone",
]);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const terminalDeadErrorCodeSchema = z.enum(CLERMONT_TERMINAL_DEAD_ERROR_CODES);
const permitIndexRowSchema = z
  .object({
    permitNumber: z.string().trim().min(1),
    alternateKey: z.string().trim().min(1).nullable().optional(),
  })
  .passthrough();
const deadAttemptEvidenceSchema = z
  .object({
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    observedAt: z.string().datetime({ offset: true }),
    requestUrl: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:"),
    requestMethod: z.literal("GET"),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    responseSha256: sha256Schema.nullable(),
    classification: z.enum(["transient", "permanent"]),
    errorCode: z.string().min(1),
  })
  .strict();

export const clermontPermanentDeadEvidenceSchema = z
  .object({
    schemaVersion: z.literal("elephant.clermont-permanent-dead-evidence.v2"),
    permitNumber: z.string().trim().min(1),
    alternateKey: z.string().trim().min(1).nullable(),
    classification: z.literal("permanent"),
    errorCode: terminalDeadErrorCodeSchema,
    message: z.string().min(1),
    observedAt: z.string().datetime({ offset: true }),
    attempts: z.array(deadAttemptEvidenceSchema).min(1),
    sourceProof: z
      .object({
        requestUrl: z
          .string()
          .url()
          .refine((value) => new URL(value).protocol === "https:"),
        requestMethod: z.literal("GET"),
        httpStatus: z.union([z.literal(404), z.literal(410)]),
        responseSha256: sha256Schema,
        responseBody: z.string(),
        observedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    searchRow: permitIndexRowSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    const expectedRequestUrl = `${LICENSE_DIRECTORY_SOURCE_URL}?activityNo=${encodeURIComponent(
      evidence.permitNumber,
    )}`;
    const expectedCode =
      evidence.sourceProof.httpStatus === 404 ? "source_record_not_found" : "source_record_gone";
    if (evidence.errorCode !== expectedCode) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Terminal code must match the source HTTP status",
      });
    }
    if (evidence.sourceProof.responseSha256 !== sha256Text(evidence.sourceProof.responseBody)) {
      context.addIssue({
        code: "custom",
        path: ["sourceProof", "responseSha256"],
        message: "Source proof digest must match the retained response body",
      });
    }
    if (evidence.sourceProof.requestUrl !== expectedRequestUrl) {
      context.addIssue({
        code: "custom",
        path: ["sourceProof", "requestUrl"],
        message: "Source proof URL must identify the exact enumerated permit",
      });
    }
    if (
      evidence.searchRow.permitNumber !== evidence.permitNumber ||
      (evidence.searchRow.alternateKey ?? null) !== evidence.alternateKey
    ) {
      context.addIssue({
        code: "custom",
        path: ["searchRow"],
        message: "Dead evidence must bind the exact enumeration identity",
      });
    }
    const lastAttempt = evidence.attempts.at(-1);
    const declaredMaximum = evidence.attempts[0]?.maxAttempts;
    if (
      evidence.attempts.length > (declaredMaximum ?? 0) ||
      evidence.attempts.some(
        (attempt, index) =>
          attempt.attempt !== index + 1 ||
          attempt.maxAttempts !== declaredMaximum ||
          attempt.requestUrl !== evidence.sourceProof.requestUrl ||
          (index < evidence.attempts.length - 1 && attempt.classification !== "transient"),
      ) ||
      lastAttempt?.classification !== "permanent" ||
      lastAttempt.errorCode !== evidence.errorCode ||
      lastAttempt.httpStatus !== evidence.sourceProof.httpStatus ||
      lastAttempt.responseSha256 !== evidence.sourceProof.responseSha256 ||
      lastAttempt.observedAt !== evidence.sourceProof.observedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["attempts"],
        message: "Ordered attempt evidence must end in the retained terminal source proof",
      });
    }
  });

export const clermontLicenseDirectoryProvenanceSchema = z
  .object({
    schemaVersion: z.literal("elephant.clermont-license-directory-provenance.v1"),
    jobId: z.string().min(1),
    sourceUrl: z.literal(LICENSE_DIRECTORY_SOURCE_URL),
    capturedAt: z.string().datetime({ offset: true }),
    sha256: sha256Schema,
    entries: z.number().int().nonnegative(),
    validityBoundary: z.literal(LICENSE_DIRECTORY_VALIDITY_BOUNDARY),
  })
  .strict();

/**
 * Validate a committed job-wide contractor-directory pin. The metadata file
 * is the commit marker: records may be written only after both files agree
 * byte-for-byte and the retained HTML reconstructs the declared index.
 *
 * @param {object} options - Validation options.
 * @param {string} options.html - Retained source HTML.
 * @param {unknown} options.metadata - Parsed provenance JSON.
 * @param {string} options.jobId - Exact job identity.
 * @returns {{ html: string, metadata: object, licenseIndex: Map<string, string> }} Valid pin.
 */
export function validateClermontLicenseDirectoryPair({ html, metadata, jobId }) {
  const parsed = clermontLicenseDirectoryProvenanceSchema.parse(metadata);
  const licenseIndex = licenseIndexFromSearchPage(html);
  if (
    parsed.jobId !== jobId ||
    parsed.sha256 !== sha256Text(html) ||
    parsed.entries !== licenseIndex.size
  ) {
    throw new Error("Pinned Clermont license-directory HTML and provenance do not match");
  }
  if (licenseIndex.size === 0) {
    throw new Error("Clermont license-directory pin contains no usable contractor entries");
  }
  return { html, metadata: parsed, licenseIndex };
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} jobId - Harvest job id.
 * @returns {string} Artifact root for that job.
 */
function jobDir(jobId) {
  return path.join(RUNTIME_ROOT, "data", "artifacts", "permits", "lake", jobId);
}

/**
 * @param {readonly string[]} argv - Raw CLI arguments.
 * @returns {Record<string, string | boolean>} Parsed flags.
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return flags;
}

/**
 * @param {string} message - Structured log line.
 * @param {Record<string, unknown>} [fields] - Additional fields.
 * @returns {void}
 */
function log(message, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), event: message, ...fields })}\n`,
  );
}

/**
 * Permit numbers contain a `/` in no observed case, but artifact keys must not
 * depend on that: every path segment is sanitised.
 *
 * @param {string} value - Raw key.
 * @returns {string} Filesystem-safe key.
 */
export function safeKeyPart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Commit one artifact by same-directory rename so a crash cannot expose
 * partially written final bytes.
 *
 * @param {string} filePath - Final artifact path.
 * @param {string | Buffer} body - Complete artifact bytes.
 * @returns {Promise<void>} Resolves after the atomic rename.
 */
export async function atomicWriteArtifact(filePath, body) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, body, { flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function hasExtractedPermitRecords(root) {
  return (await readdir(path.join(root, "extracted")).catch(() => [])).some((name) =>
    name.endsWith(".json"),
  );
}

/**
 * Reuse the first valid contractor-directory pair committed for a job. A
 * partial or invalid pair can be recovered only before any extracted permit
 * exists; once records exist, changing the directory would mix two license
 * snapshots inside one job and therefore fails closed.
 *
 * @param {object} options - Pin options.
 * @param {string} options.root - Job artifact root.
 * @param {string} options.jobId - Exact job identity.
 * @param {() => Promise<{ html: string, capturedAt: string }>} options.loadSource - Bounded upstream bootstrap.
 * @param {() => Promise<void>} [options.afterHtmlCommit] - Test-only crash hook.
 * @returns {Promise<{ html: string, metadata: object, licenseIndex: Map<string, string>, reused: boolean }>} Pinned pair.
 */
export async function ensureClermontLicenseDirectoryPin({
  root,
  jobId,
  loadSource,
  afterHtmlCommit = async () => {},
}) {
  const htmlPath = path.join(root, "license-directory.html");
  const metadataPath = path.join(root, "license-directory.meta.json");
  const [hasHtml, hasMetadata] = await Promise.all([
    pathExists(htmlPath),
    pathExists(metadataPath),
  ]);
  if (hasHtml && hasMetadata) {
    try {
      const committed = validateClermontLicenseDirectoryPair({
        html: await readFile(htmlPath, "utf8"),
        metadata: JSON.parse(await readFile(metadataPath, "utf8")),
        jobId,
      });
      return { ...committed, reused: true };
    } catch (error) {
      if (await hasExtractedPermitRecords(root)) {
        throw new Error(
          `Pinned Clermont license directory is invalid after permit capture: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else if ((hasHtml || hasMetadata) && (await hasExtractedPermitRecords(root))) {
    throw new Error("Pinned Clermont license directory is partial after permit capture");
  }

  const source = await loadSource();
  if (!Number.isFinite(Date.parse(source.capturedAt))) {
    throw new Error("Clermont license-directory capture time must be ISO-8601");
  }
  const licenseIndex = licenseIndexFromSearchPage(source.html);
  const metadata = clermontLicenseDirectoryProvenanceSchema.parse({
    schemaVersion: "elephant.clermont-license-directory-provenance.v1",
    jobId,
    sourceUrl: LICENSE_DIRECTORY_SOURCE_URL,
    capturedAt: source.capturedAt,
    sha256: sha256Text(source.html),
    entries: licenseIndex.size,
    validityBoundary: LICENSE_DIRECTORY_VALIDITY_BOUNDARY,
  });
  validateClermontLicenseDirectoryPair({ html: source.html, metadata, jobId });

  // HTML is committed first and metadata last. The metadata file is the pair's
  // commit marker, so the record loop below cannot observe a half-pinned pair.
  await atomicWriteArtifact(htmlPath, source.html);
  await afterHtmlCommit();
  await atomicWriteArtifact(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const committed = validateClermontLicenseDirectoryPair({
    html: await readFile(htmlPath, "utf8"),
    metadata: JSON.parse(await readFile(metadataPath, "utf8")),
    jobId,
  });
  return { ...committed, reused: false };
}

/**
 * Commit the raw/extracted pair. A process interruption between the two atomic
 * renames can leave one complete artifact, but resume validation treats that
 * state as pending and safely overwrites it on the next source fetch.
 *
 * @param {object} options - Pair options.
 * @param {string} options.rawPath - Final raw HTML path.
 * @param {string} options.extractedPath - Final normalized JSON path.
 * @param {string} options.rawBody - Raw HTML bytes.
 * @param {string} options.extractedBody - Typed normalized JSON bytes.
 * @param {() => Promise<void>} [options.afterRawCommit] - Test-only interruption hook.
 * @returns {Promise<void>} Resolves after both final paths are committed.
 */
export async function writeClermontPermitArtifactPair({
  rawPath,
  extractedPath,
  rawBody,
  extractedBody,
  afterRawCommit = async () => {},
}) {
  await atomicWriteArtifact(rawPath, rawBody);
  await afterRawCommit();
  await atomicWriteArtifact(extractedPath, extractedBody);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an on-disk terminal unit before a resume skips it. Filename
 * existence alone is never completion: success requires an exact raw HTML +
 * typed normalized JSON identity pair, while exclusion requires typed,
 * whitelisted permanent-dead proof bound to the enumeration row.
 *
 * @param {object} options - Inspection options.
 * @param {string} options.root - Live partition root.
 * @param {object} options.row - Exact permit enumeration row.
 * @param {string} [options.licenseDirectorySha256] - Required job-wide directory digest.
 * @returns {Promise<{ disposition: "completed" | "proven-dead" | "pending", reason: string | null }>} Resume state.
 */
export async function inspectClermontHarvestArtifactState({ root, row, licenseDirectorySha256 }) {
  const parsedRow = permitIndexRowSchema.parse(row);
  const permitKey = safeKeyPart(parsedRow.permitNumber);
  const rawPath = path.join(root, "raw", `${permitKey}.html`);
  const extractedPath = path.join(root, "extracted", `${permitKey}.json`);
  const deadPath = path.join(root, "dead", `${permitKey}.json`);
  const [hasRaw, hasExtracted, hasDead] = await Promise.all([
    pathExists(rawPath),
    pathExists(extractedPath),
    pathExists(deadPath),
  ]);
  if (hasDead && (hasRaw || hasExtracted)) {
    throw new Error(`Permit ${parsedRow.permitNumber} has conflicting captured and dead evidence`);
  }
  if (hasRaw && hasExtracted) {
    try {
      const [rawBody, extractedBody] = await Promise.all([
        readFile(rawPath, "utf8"),
        readFile(extractedPath, "utf8"),
      ]);
      const detail = parsePermitDetailHtml(rawBody, {
        expectedPermitNumber: parsedRow.permitNumber,
      });
      const record = normalizedPermitRecordSchema.parse(JSON.parse(extractedBody));
      if (
        detail.permitNumber !== parsedRow.permitNumber ||
        record.permit_number !== parsedRow.permitNumber ||
        (licenseDirectorySha256 !== undefined &&
          record.sourcePayload.licenseDirectorySha256 !== licenseDirectorySha256) ||
        record.sourcePayload.searchRow === null ||
        !isDeepStrictEqual(record.sourcePayload.searchRow, parsedRow)
      ) {
        return { disposition: "pending", reason: "captured_identity_mismatch" };
      }
      return { disposition: "completed", reason: null };
    } catch {
      return { disposition: "pending", reason: "captured_pair_invalid" };
    }
  }
  if (hasDead) {
    try {
      const evidence = clermontPermanentDeadEvidenceSchema.parse(
        JSON.parse(await readFile(deadPath, "utf8")),
      );
      if (!isDeepStrictEqual(evidence.searchRow, parsedRow)) {
        return { disposition: "pending", reason: "dead_enumeration_mismatch" };
      }
      return { disposition: "proven-dead", reason: null };
    } catch {
      return { disposition: "pending", reason: "dead_evidence_invalid" };
    }
  }
  if (hasRaw || hasExtracted) {
    return { disposition: "pending", reason: "partial_captured_pair" };
  }
  return { disposition: "pending", reason: "not_started" };
}

/**
 * Accept only a terminal source code carrying reproducible HTTP evidence.
 * Other permanent-looking adapter errors remain pending/human-blocking.
 *
 * @param {object} options - Evidence options.
 * @param {object} options.row - Exact enumeration row.
 * @param {unknown} options.error - Classified source error.
 * @param {string} options.observedAt - Failure observation time.
 * @returns {object | null} Typed terminal evidence, or null when exclusion is not proven.
 */
export function buildClermontPermanentDeadEvidence({ row, error, observedAt }) {
  const candidate = {
    schemaVersion: "elephant.clermont-permanent-dead-evidence.v2",
    permitNumber: row.permitNumber,
    alternateKey: row.alternateKey ?? null,
    classification: error?.classification,
    errorCode: error?.code,
    message: error?.message ?? String(error),
    observedAt,
    attempts: error?.attemptEvidence,
    sourceProof: error?.sourceProof,
    searchRow: row,
  };
  const parsed = clermontPermanentDeadEvidenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Read only dead evidence that proves a terminal outcome for an exact row in
 * the current enumeration. Invalid or orphan files fail closed instead of
 * inflating dead counts in summaries and coverage.
 *
 * @param {string} root - Live partition root.
 * @param {object | null} index - Current permit index.
 * @returns {Promise<object[]>} Validated permanent-dead evidence.
 */
async function readValidatedDeadEvidence(root, index) {
  const files = (await readdir(path.join(root, "dead")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  );
  if (files.length === 0) return [];
  if (!Array.isArray(index?.permits)) {
    throw new Error("Dead evidence cannot be counted without its exact permit enumeration");
  }
  const rows = new Map(index.permits.map((row) => [row.permitNumber, row]));
  return Promise.all(
    files.sort().map(async (file) => {
      const evidence = clermontPermanentDeadEvidenceSchema.parse(
        JSON.parse(await readFile(path.join(root, "dead", file), "utf8")),
      );
      const row = rows.get(evidence.permitNumber);
      if (
        file !== `${safeKeyPart(evidence.permitNumber)}.json` ||
        row === undefined ||
        !isDeepStrictEqual(evidence.searchRow, row)
      ) {
        throw new Error(`Dead evidence is not bound to this enumeration: ${file}`);
      }
      return evidence;
    }),
  );
}

/**
 * Stream the Lake seed and index the parcels the harvest may attach permits
 * to. The seed CSV is the input of record; parcel identity is never
 * re-derived from the query DB or from the portal.
 *
 * @param {object} [options] - Options.
 * @param {string} [options.seedPath] - Seed CSV path.
 * @returns {Promise<Map<string, { parcelId: string, city: string, address: string }>>} `alt_key` → seed row.
 */
export async function loadSeedIndex(options = {}) {
  const seedPath = options.seedPath ?? SEED_PATH;
  /** @type {Map<string, { parcelId: string, city: string, address: string }>} */
  const index = new Map();
  const reader = createInterface({ input: createReadStream(seedPath), crlfDelay: Infinity });
  let header = null;
  for await (const line of reader) {
    const cells = splitCsvLine(line);
    if (header === null) {
      header = cells;
      continue;
    }
    const row = Object.fromEntries(header.map((name, position) => [name, cells[position] ?? ""]));
    if (row.alt_key) {
      index.set(row.alt_key, { parcelId: row.parcel_id, city: row.city, address: row.address });
    }
  }
  return index;
}

/**
 * Minimal RFC-4180 line splitter; the Lake seed quotes any field containing a
 * comma (the `multiValueQueryString` JSON column always does).
 *
 * @param {string} line - One CSV line.
 * @returns {string[]} Cell values.
 */
export function splitCsvLine(line) {
  /** @type {string[]} */
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}

/**
 * Benchmark the portal before any bulk harvest.
 *
 * `county-permit-adapter` names six things a benchmark must cover — permit
 * search, list extraction, detail capture, session bootstrap, retry/failure
 * rate and bytes written — so this measures all six rather than detail latency
 * alone. Each phase runs at a politeness-bounded size; the whole benchmark is
 * around 60 requests.
 *
 * Search phases are deliberately serial. A search is an ASP.NET postback that
 * consumes the viewstate the previous response handed back, so concurrency in
 * the search half means independent sessions, not parallel requests on one —
 * and a benchmark that measured it any other way would not describe the
 * harvest it is meant to size.
 *
 * @param {object} options - Measurement options.
 * @param {readonly string[]} options.permitNumbers - Permits to fetch detail pages for.
 * @param {readonly string[]} options.alternateKeys - Parcel keys to search by, for the parcel-search phase.
 * @param {readonly string[]} options.prefixes - Permit-number prefixes, for the list-extraction phase.
 * @param {readonly number[]} [options.concurrencies] - Detail concurrency levels to try.
 * @param {number} [options.bootstrapSamples] - Session bootstraps to time.
 * @returns {Promise<{ bootstrap: object, parcelSearch: object, listSearch: object, detail: object[] }>}
 *   One measurement per phase.
 */
export async function measureThroughput({
  permitNumbers,
  alternateKeys = [],
  prefixes = [],
  concurrencies = [1, 2],
  bootstrapSamples = 3,
}) {
  /**
   * @param {number} ms - Delay.
   * @returns {Promise<void>} Resolves after the delay.
   */
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Phase 1 — session bootstrap. A fresh session per sample, because the cost
  // being measured is the one a cold worker pays, not a warm one.
  /** @type {number[]} */
  const bootstrapMs = [];
  /** @type {number[]} */
  const bootstrapBytes = [];
  let bootstrapFailures = 0;
  for (let sample = 0; sample < bootstrapSamples; sample += 1) {
    const session = createClermontPermitSession({ maxAttempts: 1 });
    const at = Date.now();
    try {
      // A bootstrap is only observable through the work it enables; loading the
      // contractor directory reads the very page the bootstrap GET fetches.
      const index = await session.loadContractorLicenseIndex();
      bootstrapMs.push(Date.now() - at);
      bootstrapBytes.push(index.size);
    } catch {
      bootstrapFailures += 1;
    }
    await pause(2000);
  }
  const bootstrap = {
    phase: "session-bootstrap",
    attempted: bootstrapSamples,
    failureCount: bootstrapFailures,
    latency: summarizeLatencies(bootstrapMs),
    contractorDirectoryEntries: bootstrapBytes[0] ?? null,
  };
  log("throughput.phase", bootstrap);

  // Phase 2 — permit search by parcel key, the kit's parcel-keyed entry point.
  /** @type {number[]} */
  const parcelSearchMs = [];
  let parcelSearchRows = 0;
  let parcelSearchHits = 0;
  let parcelSearchFailures = 0;
  if (alternateKeys.length > 0) {
    const session = createClermontPermitSession({ maxAttempts: 1 });
    for (const alternateKey of alternateKeys) {
      const at = Date.now();
      try {
        const result = await session.searchByAlternateKey(alternateKey);
        parcelSearchMs.push(Date.now() - at);
        parcelSearchRows += result.rows.length;
        if (result.rows.length > 0) parcelSearchHits += 1;
      } catch {
        parcelSearchFailures += 1;
      }
    }
  }
  const parcelSearch = {
    phase: "permit-search-by-parcel",
    attempted: alternateKeys.length,
    failureCount: parcelSearchFailures,
    latency: summarizeLatencies(parcelSearchMs),
    rowsReturned: parcelSearchRows,
    parcelsWithAnyPermit: parcelSearchHits,
    permitsPerSearchedParcel:
      parcelSearchMs.length > 0
        ? Number((parcelSearchRows / parcelSearchMs.length).toFixed(2))
        : null,
  };
  log("throughput.phase", parcelSearch);
  await pause(3000);

  // Phase 3 — list extraction by permit-number prefix, the enumeration walk.
  /** @type {number[]} */
  const listSearchMs = [];
  let listRows = 0;
  let listCapped = 0;
  let listSearchFailures = 0;
  if (prefixes.length > 0) {
    const session = createClermontPermitSession({ maxAttempts: 1 });
    for (const prefix of prefixes) {
      const at = Date.now();
      try {
        const result = await session.searchByPermitPrefix(prefix);
        listSearchMs.push(Date.now() - at);
        listRows += result.rows.length;
        if (result.capped) listCapped += 1;
      } catch {
        listSearchFailures += 1;
      }
    }
  }
  const listSearch = {
    phase: "permit-list-extraction",
    attempted: prefixes.length,
    failureCount: listSearchFailures,
    latency: summarizeLatencies(listSearchMs),
    rowsReturned: listRows,
    cappedResponses: listCapped,
    rowsPerSearch:
      listSearchMs.length > 0 ? Number((listRows / listSearchMs.length).toFixed(2)) : null,
  };
  log("throughput.phase", listSearch);
  await pause(3000);

  // Phase 4 — detail capture, across the concurrency levels under test.
  /** @type {object[]} */
  const detail = [];
  for (const concurrency of concurrencies) {
    // maxAttempts 1: a measurement must observe the portal's raw failure rate,
    // not the rate after the adapter has already hidden it behind retries.
    const session = createClermontPermitSession({ maxAttempts: 1 });
    const started = Date.now();
    const results = await mapWithConcurrency(permitNumbers, concurrency, async (permitNumber) => {
      const at = Date.now();
      try {
        const { detail: record, html } = await session.fetchPermitDetail(permitNumber);
        return {
          ms: Date.now() - at,
          ok: true,
          bytes: html.length,
          contractor: selectContractorOfRecord(record.contacts)?.name ?? null,
        };
      } catch (error) {
        return {
          ms: Date.now() - at,
          ok: false,
          code: error?.code ?? "unknown",
          bytes: 0,
          contractor: null,
        };
      }
    });
    const wallSeconds = (Date.now() - started) / 1000;
    const latency = summarizeLatencies(
      results.filter((result) => result.ok).map((result) => result.ms),
    );
    const failures = results.filter((result) => !result.ok);
    detail.push({
      phase: "permit-detail-capture",
      concurrency,
      attempted: results.length,
      wallSeconds: Number(wallSeconds.toFixed(1)),
      requestsPerSecond: Number((results.length / wallSeconds).toFixed(2)),
      latency,
      failureCount: failures.length,
      failureRate: Number((failures.length / results.length).toFixed(3)),
      failureCodes: [...new Set(failures.map((failure) => failure.code))],
      contractorCount: results.filter((result) => result.contractor !== null).length,
      averageBytes: Math.round(
        results.reduce((sum, result) => sum + result.bytes, 0) / results.length,
      ),
    });
    log("throughput.phase", detail.at(-1));
    await pause(5000);
  }

  return { bootstrap, parcelSearch, listSearch, detail };
}

/**
 * Measure bytes written per captured permit from the artifacts already on
 * disk. Storage cost is a measurement, not an estimate, the moment one pass
 * has run.
 *
 * @param {string} jobId - Harvest job id.
 * @returns {Promise<{ permits: number, rawBytes: number, extractedBytes: number, bytesPerPermit: number | null }>}
 *   Bytes-written summary.
 */
export async function measureBytesWritten(jobId) {
  const root = jobDir(jobId);
  /**
   * @param {string} dir - Directory to total.
   * @returns {Promise<{ files: number, bytes: number }>} File count and total bytes.
   */
  async function total(dir) {
    const names = await readdir(path.join(root, dir)).catch(() => []);
    let bytes = 0;
    for (const name of names) bytes += (await stat(path.join(root, dir, name))).size;
    return { files: names.length, bytes };
  }
  const raw = await total("raw");
  const extracted = await total("extracted");
  return {
    permits: extracted.files,
    rawBytes: raw.bytes,
    extractedBytes: extracted.bytes,
    bytesPerPermit:
      extracted.files > 0 ? Math.round((raw.bytes + extracted.bytes) / extracted.files) : null,
  };
}

/**
 * Enumerate Clermont permits by walking the permit-number prefix tree.
 *
 * The walk itself is serial within one session — every search postback
 * consumes the viewstate the previous response handed back — so concurrency is
 * obtained by sharding the year's ten depth-1 prefixes across independent
 * sessions. That keeps in-flight requests at the measured-safe level while
 * cutting wall time proportionally.
 *
 * @param {object} options - Enumeration options.
 * @param {string} options.jobId - Job id.
 * @param {readonly string[]} options.years - Two-digit permit-number years.
 * @param {number} [options.concurrency] - Independent sessions walking in parallel.
 * @param {number} [options.maxAttempts] - Executor-authorized attempts per source request.
 * @returns {Promise<object>} The written permit index.
 */
export async function enumeratePermits({ jobId, years, concurrency = 2, maxAttempts = 4 }) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 12) {
    throw new Error("maxAttempts must be an integer between 1 and 12");
  }
  const listDir = path.join(jobDir(jobId), "permit-lists");
  await mkdir(listDir, { recursive: true });
  const indexPath = path.join(listDir, "clermont-permit-index.json");

  const roots = permitYearPrefixes(years).flatMap((year) => expandPermitPrefix(year));
  const shards = Array.from({ length: concurrency }, (_, shard) =>
    roots.filter((_root, position) => position % concurrency === shard),
  );

  const started = Date.now();
  const walks = await mapWithConcurrency(shards, concurrency, async (rootPrefixes) => {
    const session = createClermontPermitSession({ maxAttempts });
    return walkPermitPrefixes({
      rootPrefixes,
      // A root here is already `YY-N`, one digit deep, so three more digits
      // reach the full `YY-NNNN` permit number.
      maxDepth: 3,
      search: (prefix) => session.searchByPermitPrefix(prefix),
      onPrefix: (event) => {
        if (event.rows > 0 || event.capped) log("enumerate.prefix", event);
      },
    });
  });

  const walk = {
    rows: [
      ...new Map(
        walks.flatMap((result) => result.rows).map((row) => [row.permitNumber, row]),
      ).values(),
    ].sort((left, right) => left.permitNumber.localeCompare(right.permitNumber)),
    prefixesSearched: walks.reduce((sum, result) => sum + result.prefixesSearched, 0),
    unresolvedPrefixes: walks.flatMap((result) => result.unresolvedPrefixes),
  };

  const index = {
    schemaVersion: "elephant.clermont-permit-index.v1",
    jobId,
    jurisdictionKey: JURISDICTION_KEY,
    sourceUrl: CLERMONT_ETRAKIT_SEARCH_URL,
    years: [...years],
    enumeratedAt: new Date().toISOString(),
    wallSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    prefixesSearched: walk.prefixesSearched,
    unresolvedPrefixes: walk.unresolvedPrefixes,
    permitCount: walk.rows.length,
    distinctAlternateKeys: new Set(walk.rows.map((row) => row.alternateKey).filter(Boolean)).size,
    permits: walk.rows,
  };
  await atomicWriteArtifact(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  log("enumerate.done", {
    jobId,
    permitCount: index.permitCount,
    distinctAlternateKeys: index.distinctAlternateKeys,
    prefixesSearched: index.prefixesSearched,
    unresolvedPrefixes: index.unresolvedPrefixes.length,
    wallSeconds: index.wallSeconds,
  });
  return index;
}

/**
 * Harvest permit detail pages and write normalized records.
 *
 * A permit whose parcel is not in the seed is still captured — the portal is
 * the record of origin for Clermont permits — but it is written with a null
 * `property_id` and counted separately, never silently dropped and never
 * counted as a linked record.
 *
 * @param {object} options - Harvest options.
 * @param {string} options.jobId - Job id.
 * @param {number} [options.concurrency] - In-flight detail requests.
 * @param {number} [options.limit] - Cap on permits to fetch this pass.
 * @param {boolean} [options.onlyRoofing] - Restrict to roofing permit types.
 * @param {number} [options.delayMs] - Politeness pause each worker takes after every permit.
 * @param {number} [options.maxAttempts] - Executor-authorized attempts per source request.
 * @param {string} [options.artifactRoot] - Injected job root for offline verification.
 * @param {string} [options.seedPath] - Injected seed path for offline verification.
 * @param {object} [options.session] - Injected source session for offline verification.
 * @param {() => string} [options.clock] - ISO-8601 capture clock.
 * @returns {Promise<object>} Harvest summary.
 */
export async function harvestPermits({
  jobId,
  concurrency = 2,
  limit = Infinity,
  onlyRoofing = false,
  delayMs = 0,
  maxAttempts = 4,
  artifactRoot,
  seedPath,
  session: suppliedSession,
  clock = () => new Date().toISOString(),
}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 12) {
    throw new Error("maxAttempts must be an integer between 1 and 12");
  }
  const root = artifactRoot ?? jobDir(jobId);
  const indexPath = path.join(root, "permit-lists", "clermont-permit-index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  for (const dir of ["raw", "extracted", "status", "dead"])
    await mkdir(path.join(root, dir), { recursive: true });

  const seed = await loadSeedIndex(seedPath === undefined ? {} : { seedPath });
  const session = suppliedSession ?? createClermontPermitSession({ maxAttempts });
  const licenseDirectory = await ensureClermontLicenseDirectoryPin({
    root,
    jobId,
    loadSource: async () => {
      await session.loadContractorLicenseIndex();
      const html = session.bootstrapHtml();
      if (html === null) {
        throw new Error("Contractor license directory bootstrap bytes were not retained");
      }
      return { html, capturedAt: clock() };
    },
  });
  const licenseIndex = licenseDirectory.licenseIndex;
  const licenseSha256 = licenseDirectory.metadata.sha256;
  log("harvest.license-directory", {
    entries: licenseDirectory.metadata.entries,
    sha256: licenseSha256,
    capturedAt: licenseDirectory.metadata.capturedAt,
    reused: licenseDirectory.reused,
  });

  // Resolve the immutable job-wide directory before inspecting or writing any
  // record. Resume is then evidence-based: an exact raw + typed extracted pair
  // is complete only when the record binds this same directory digest.
  const resumeStates = await mapWithConcurrency(index.permits, 32, async (row) => ({
    row,
    state: await inspectClermontHarvestArtifactState({
      root,
      row,
      licenseDirectorySha256: licenseSha256,
    }),
  }));
  const done = new Set(
    resumeStates
      .filter(({ state }) => state.disposition !== "pending")
      .map(({ row }) => safeKeyPart(row.permitNumber)),
  );
  const pendingReasonByKey = new Map(
    resumeStates
      .filter(({ state }) => state.disposition === "pending")
      .map(({ row, state }) => [safeKeyPart(row.permitNumber), state.reason]),
  );
  const queue = index.permits
    .filter((row) => !onlyRoofing || /roof/i.test(String(row.permitType ?? "")))
    .filter((row) => !done.has(safeKeyPart(row.permitNumber)))
    .slice(0, limit === Infinity ? undefined : limit);

  log("harvest.start", {
    jobId,
    queued: queue.length,
    alreadyDone: done.size,
    concurrency,
    onlyRoofing,
  });

  /** @type {Map<string, { permits: number, failures: number, contractors: number, parcelIdentifier: string | null, permitNumber: string | null, fromDisk?: boolean }>} */
  const perParcel = new Map();
  const failures = [];
  let contractorCount = 0;
  let unseededCount = 0;
  let processed = 0;

  await mapWithConcurrency(queue, concurrency, async (row) => {
    const permitKey = safeKeyPart(row.permitNumber);
    const alternateKey = row.alternateKey ?? null;
    const pendingReason = pendingReasonByKey.get(permitKey);
    if (pendingReason !== undefined && pendingReason !== "not_started") {
      const recoveryRoot = path.join(root, "recovery");
      await mkdir(recoveryRoot, { recursive: true });
      for (const [directory, extension] of [
        ["raw", "html"],
        ["extracted", "json"],
        ["dead", "json"],
      ]) {
        const source = path.join(root, directory, `${permitKey}.${extension}`);
        if (!(await pathExists(source))) continue;
        await rename(
          source,
          path.join(
            recoveryRoot,
            `${permitKey}.${directory}.${pendingReason}.${randomUUID()}.${extension}`,
          ),
        );
      }
    }
    try {
      const { detail, html } = await session.fetchPermitDetail(row.permitNumber);
      const boundKey = alternateKey ?? detail.alternateKey;
      const seedRow = boundKey === null ? null : (seed.get(boundKey) ?? null);
      if (seedRow === null) unseededCount += 1;
      const record = normalizeClermontPermit({
        detail,
        row,
        requestedAlternateKey: boundKey,
        requestedParcelId: seedRow?.parcelId ?? null,
        licenseIndex,
        licenseDirectorySha256: licenseSha256,
      });
      await writeClermontPermitArtifactPair({
        rawPath: path.join(root, "raw", `${permitKey}.html`),
        extractedPath: path.join(root, "extracted", `${permitKey}.json`),
        rawBody: html,
        extractedBody: `${JSON.stringify(record, null, 2)}\n`,
      });
      const bucketKey = boundKey ?? `permit:${row.permitNumber}`;
      const bucket = perParcel.get(bucketKey) ?? {
        permits: 0,
        failures: 0,
        contractors: 0,
        parcelIdentifier: boundKey,
        permitNumber: boundKey === null ? row.permitNumber : null,
      };
      bucket.permits += 1;
      if (record.sourcePayload.contractorOfRecord !== null) {
        bucket.contractors += 1;
        contractorCount += 1;
      }
      perParcel.set(bucketKey, bucket);
    } catch (error) {
      const observedAt = new Date().toISOString();
      const terminalEvidence = buildClermontPermanentDeadEvidence({ row, error, observedAt });
      const entry = {
        permitNumber: row.permitNumber,
        alternateKey,
        classification:
          terminalEvidence !== null
            ? "permanent"
            : error?.classification === "permanent"
              ? "blocked"
              : (error?.classification ?? "transient"),
        errorCode: error?.code ?? "unexpected_source_error",
        message: error?.message ?? String(error),
        attempts: Array.isArray(error?.attemptEvidence) ? error.attemptEvidence : [],
        observedAt,
      };
      failures.push(entry);
      if (terminalEvidence !== null) {
        await atomicWriteArtifact(
          path.join(root, "dead", `${permitKey}.json`),
          `${JSON.stringify(terminalEvidence, null, 2)}\n`,
        );
      }
      if (alternateKey) {
        const bucket = perParcel.get(alternateKey) ?? {
          permits: 0,
          failures: 0,
          contractors: 0,
          parcelIdentifier: alternateKey,
          permitNumber: null,
        };
        bucket.failures += 1;
        perParcel.set(alternateKey, bucket);
      }
      log("harvest.failure", entry);
    }
    processed += 1;
    if (processed % 100 === 0) {
      log("harvest.progress", {
        processed,
        queued: queue.length,
        contractors: contractorCount,
        failures: failures.length,
      });
    }
    // Politeness, not pacing: the portal's observed ceiling is cumulative
    // request volume rather than instantaneous concurrency (see
    // docs/lake-county-findings.md section 7), so the lever that keeps a long
    // resume inside it is the gap between requests, not the worker count.
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  });

  // Status is rebuilt from every extracted record on disk, not from this
  // pass's counters: a resumed run only fetches what is missing, so counting
  // in-memory would rewrite a complete parcel's status with a partial count.
  for (const file of (await readdir(path.join(root, "extracted")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  )) {
    const record = JSON.parse(await readFile(path.join(root, "extracted", file), "utf8"));
    const bucketKey = record.parcel_identifier ?? `permit:${record.permit_number}`;
    const bucket = perParcel.get(bucketKey) ?? {
      permits: 0,
      failures: 0,
      contractors: 0,
      parcelIdentifier: record.parcel_identifier,
      permitNumber: record.parcel_identifier === null ? record.permit_number : null,
    };
    if (!bucket.fromDisk) {
      bucket.permits = 0;
      bucket.contractors = 0;
      bucket.fromDisk = true;
    }
    bucket.permits += 1;
    if (record.sourcePayload.contractorOfRecord !== null) bucket.contractors += 1;
    perParcel.set(bucketKey, bucket);
  }

  for (const bucket of perParcel.values()) {
    const seedRow =
      bucket.parcelIdentifier === null ? null : (seed.get(bucket.parcelIdentifier) ?? null);
    const statusKey =
      bucket.parcelIdentifier ?? `permit-without-parcel-${String(bucket.permitNumber)}`;
    await atomicWriteArtifact(
      path.join(root, "status", `${safeKeyPart(statusKey)}.json`),
      `${JSON.stringify(
        {
          countyKey: "lake",
          jobId,
          parcelIdentifier: bucket.parcelIdentifier,
          permitNumber: bucket.permitNumber,
          linkage:
            seedRow !== null
              ? "linked"
              : bucket.parcelIdentifier === null
                ? "valid-unlinked-no-parcel-identifier"
                : "valid-unlinked",
          parcelId: seedRow?.parcelId ?? null,
          jurisdictionKey: JURISDICTION_KEY,
          status: bucket.failures > 0 && bucket.permits === 0 ? "failed" : "done",
          permitCount: bucket.permits,
          contractorCount: bucket.contractors,
          failureCount: bucket.failures,
          attempts: 1,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }

  const deadCount = (await readValidatedDeadEvidence(root, index)).length;
  const summary = {
    jobId,
    queued: queue.length,
    captured: queue.length - failures.length,
    deadCount,
    contractorCount,
    parcelsTouched: perParcel.size,
    unseededPermits: unseededCount,
    failureCount: failures.length,
    failuresByCode: Object.fromEntries(
      Object.entries(
        failures.reduce((counts, failure) => {
          counts[failure.errorCode] = (counts[failure.errorCode] ?? 0) + 1;
          return counts;
        }, /** @type {Record<string, number>} */ ({})),
      ),
    ),
    sessionStats: session.stats(),
  };
  await atomicWriteArtifact(
    path.join(root, "harvest-summary.json"),
    `${JSON.stringify({ ...summary, failures }, null, 2)}\n`,
  );
  log("harvest.done", summary);
  return summary;
}

/**
 * Re-run normalization over the raw HTML already on disk.
 *
 * This is the kit's transform-only redrive (`county-ingest-run` §7): a fixed
 * normalizer regenerates stale output without re-scraping. It touches the
 * network not at all, which is the whole point — the portal has already paid
 * for these pages once.
 *
 * @param {object} options - Options.
 * @param {string} options.jobId - Job id.
 * @returns {Promise<{ rewritten: number, unchanged: number, failed: number }>} Redrive summary.
 */
export async function renormalizePermits({ jobId }) {
  const root = jobDir(jobId);
  const index = JSON.parse(
    await readFile(path.join(root, "permit-lists", "clermont-permit-index.json"), "utf8"),
  );
  const rows = new Map(index.permits.map((row) => [safeKeyPart(row.permitNumber), row]));
  const seed = await loadSeedIndex();
  const licenseDirectory = validateClermontLicenseDirectoryPair({
    html: await readFile(path.join(root, "license-directory.html"), "utf8"),
    metadata: JSON.parse(await readFile(path.join(root, "license-directory.meta.json"), "utf8")),
    jobId,
  });
  const licenseIndex = licenseDirectory.licenseIndex;

  let rewritten = 0;
  let unchanged = 0;
  let failed = 0;
  for (const file of (await readdir(path.join(root, "extracted")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  )) {
    const key = file.replace(/\.json$/, "");
    const extractedPath = path.join(root, "extracted", file);
    const previous = JSON.parse(await readFile(extractedPath, "utf8"));
    try {
      const html = await readFile(path.join(root, "raw", `${key}.html`), "utf8");
      const detail = parsePermitDetailHtml(html, { expectedPermitNumber: previous.permit_number });
      const boundKey = previous.parcel_identifier;
      const seedRow = seed.get(boundKey) ?? null;
      const record = normalizeClermontPermit({
        detail,
        row: rows.get(key),
        requestedAlternateKey: boundKey,
        requestedParcelId: seedRow?.parcelId ?? null,
        licenseIndex,
        licenseDirectorySha256: licenseDirectory.metadata.sha256,
      });
      const next = `${JSON.stringify(record, null, 2)}\n`;
      if (next === `${JSON.stringify(previous, null, 2)}\n`) {
        unchanged += 1;
      } else {
        await atomicWriteArtifact(extractedPath, next);
        rewritten += 1;
      }
    } catch (error) {
      failed += 1;
      log("renormalize.failure", { permit: key, message: error?.message ?? String(error) });
    }
  }
  log("renormalize.done", { jobId, rewritten, unchanged, failed });
  return { rewritten, unchanged, failed };
}

/**
 * Export the harvested permits as a permit-load CSV the county consolidation
 * reads.
 *
 * The harvester writes artifacts and status only; it never merges into the
 * query table and never signals publish. `county-permit-adapter` is explicit
 * that DB merging is the loader's job and the loader is the single writer, so
 * this stage stops at a staged file with a stable key, which the consolidation
 * SQL then joins exactly like the county permit layer.
 *
 * @param {object} options - Options.
 * @param {string} options.jobId - Job id.
 * @param {string} [options.outPath] - Destination CSV.
 * @returns {Promise<{ rows: number, parcels: number, withContractor: number, outPath: string }>} Export summary.
 */
export async function exportPermitLoadCsv({ jobId, outPath }) {
  const root = jobDir(jobId);
  const destination =
    outPath ?? path.join(RUNTIME_ROOT, "data", "downloads", "lake", "clermont-permits.csv");
  const files = (await readdir(path.join(root, "extracted")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  );

  /**
   * @param {unknown} value - Cell value.
   * @returns {string} CSV cell.
   */
  const cell = (value) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const parcels = new Set();
  let withContractor = 0;
  const lines = [CLERMONT_PERMIT_LOAD_COLUMNS.join(",")];
  // Sorted by permit number so the file is byte-stable across runs: a load
  // artifact that reorders itself makes every downstream diff meaningless.
  for (const file of files.sort()) {
    const record = JSON.parse(await readFile(path.join(root, "extracted", file), "utf8"));
    const row = clermontPermitLoadRow(record);
    parcels.add(row.alternate_key);
    if (row.contractor_name !== null) withContractor += 1;
    lines.push(CLERMONT_PERMIT_LOAD_COLUMNS.map((column) => cell(row[column])).join(","));
  }

  // The dead count and the enumerated year list cannot be recovered from the
  // CSV - a dead permit has no row in it, by definition - so they travel beside
  // it. Without this the publish set would have to infer "everything the
  // portal had" from "everything that loaded", which is the exact substitution
  // the coverage contract forbids.
  const index = await readFile(
    path.join(root, "permit-lists", "clermont-permit-index.json"),
    "utf8",
  )
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const deadPermits = (await readValidatedDeadEvidence(root, index)).length;

  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${lines.join("\n")}\n`);
  const meta = {
    schemaVersion: "elephant.clermont-permit-load-meta.v1",
    jobId,
    exportedAt: new Date().toISOString(),
    sourceUrl: CLERMONT_ETRAKIT_SEARCH_URL,
    permitYears: index?.years ?? [],
    enumeratedPermits: index?.permitCount ?? files.length + deadPermits,
    deadPermits,
    achievablePermits: (index?.permitCount ?? files.length + deadPermits) - deadPermits,
    loadedPermits: files.length,
  };
  await writeFile(
    `${destination.replace(/\.csv$/, "")}.meta.json`,
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  const summary = {
    rows: files.length,
    parcels: parcels.size,
    withContractor,
    outPath: destination,
    ...meta,
  };
  log("export.done", summary);
  return summary;
}

/**
 * Recompute honest coverage from the artifacts on disk — never from the
 * in-memory counters of the run that happened to write them.
 *
 * `use-oracle`'s coverage publish contract types availability as `unsupported`,
 * `supported_partial` or `supported_full`, and Clermont is the textbook
 * `supported_partial`: one jurisdiction of fifteen is harvestable, so the data
 * is real where it exists and absent everywhere else. Every other
 * jurisdiction stays visible in the snapshot with the reason it is not here —
 * a blocked source is never allowed to read as zero records.
 *
 * Completion is judged against `achievable`, not against the enumerated total:
 * `achievable = enumerated - dead`. Missing parcel linkage never makes a
 * successfully captured permit dead; it remains valid-unlinked.
 *
 * @param {object} options - Options.
 * @param {string} options.jobId - Job id.
 * @param {string} [options.artifactRoot] - Injected artifact root for offline verification.
 * @param {string} [options.seedPath] - Injected seed path for offline verification.
 * @returns {Promise<object>} Coverage snapshot.
 */
export async function summarizeCoverage({ jobId, artifactRoot, seedPath }) {
  const root = artifactRoot ?? jobDir(jobId);
  const extractedDir = path.join(root, "extracted");
  const files = (await readdir(extractedDir).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  );
  const seed = await loadSeedIndex(seedPath === undefined ? {} : { seedPath });

  const index = await readFile(
    path.join(root, "permit-lists", "clermont-permit-index.json"),
    "utf8",
  )
    .then((text) => JSON.parse(text))
    .catch(() => null);

  /** @type {Record<string, number>} */
  const deadByReason = {};
  const deadEvidence = await readValidatedDeadEvidence(root, index);
  for (const entry of deadEvidence) {
    deadByReason[entry.errorCode] = (deadByReason[entry.errorCode] ?? 0) + 1;
  }

  let contractorPermits = 0;
  let roofPermits = 0;
  let linkedPermits = 0;
  let permitsWithoutParcelIdentifier = 0;
  let licensedContractors = 0;
  const parcels = new Set();
  const contractors = new Set();
  const permitTypes = new Map();
  let firstPermitDate = null;
  let lastPermitDate = null;

  for (const file of files) {
    const record = JSON.parse(await readFile(path.join(extractedDir, file), "utf8"));
    if (record.parcel_identifier === null) permitsWithoutParcelIdentifier += 1;
    else parcels.add(record.parcel_identifier);
    if (record.property_id !== null) linkedPermits += 1;
    if (record.isRoofPermit) roofPermits += 1;
    const name = record.sourcePayload.contractorOfRecord;
    if (name !== null) {
      contractorPermits += 1;
      contractors.add(name);
      if (record.sourcePayload.contractorOfRecordLicense !== null) licensedContractors += 1;
    }
    permitTypes.set(record.improvement_type, (permitTypes.get(record.improvement_type) ?? 0) + 1);
    const date = record.permit_issue_date ?? record.application_received_date;
    if (date !== null) {
      if (firstPermitDate === null || date < firstPermitDate) firstPermitDate = date;
      if (lastPermitDate === null || date > lastPermitDate) lastPermitDate = date;
    }
  }

  const enumerated = index?.permitCount ?? files.length + deadEvidence.length;
  const achievable = enumerated - deadEvidence.length;
  const linkedParcels = [...parcels].filter((key) => seed.has(key)).length;

  const coverage = {
    schemaVersion: "elephant.clermont-permit-coverage.v2",
    jobId,
    countyKey: "lake",
    jurisdictionKey: JURISDICTION_KEY,
    exportedAt: new Date().toISOString(),
    sourceUrl: CLERMONT_ETRAKIT_SEARCH_URL,
    // One jurisdiction of fifteen carries contractor identity, so contractor
    // coverage is partial by construction and says so in the type, not only in
    // a sentence somebody has to read.
    availability: "supported_partial",
    enumeratedPermits: enumerated,
    deadPermits: deadEvidence.length,
    deadByReason,
    achievablePermits: achievable,
    permitCount: files.length,
    complete: files.length >= achievable,
    permitsWithContractorOfRecord: contractorPermits,
    permitsWithLicensedContractor: licensedContractors,
    roofPermitCount: roofPermits,
    distinctContractors: contractors.size,
    distinctParcels: parcels.size,
    parcelsLinkedToSeed: linkedParcels,
    parcelsValidUnlinked: parcels.size - linkedParcels,
    permitsLinkedToSeedParcel: linkedPermits,
    permitsValidUnlinked: files.length - linkedPermits,
    permitsWithoutParcelIdentifier,
    countySeedParcels: seed.size,
    countyParcelSharePct:
      seed.size > 0 ? Number(((linkedParcels / seed.size) * 100).toFixed(3)) : null,
    permitYearsEnumerated: index?.years ?? [],
    firstPermitDate,
    lastPermitDate,
    topPermitTypes: [...permitTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    // Every jurisdiction in the county, harvested or not. A blocked source that
    // vanished from this list would be indistinguishable from a source with no
    // permits, which is the confusion the coverage contract exists to prevent.
    jurisdictions: LAKE_PERMIT_JURISDICTIONS.map((jurisdiction) => ({
      jurisdictionKey: jurisdiction.key,
      sourceStatus: jurisdiction.status,
      vendor: jurisdiction.vendor,
      harvestMode: jurisdiction.harvestMode,
      contractorIdentityAvailable: jurisdiction.key === JURISDICTION_KEY,
      permitCount: jurisdiction.key === JURISDICTION_KEY ? files.length : null,
    })),
    limitations: [
      "Clermont is ONE of fifteen permitting jurisdictions in Lake County; this covers no other municipality and no unincorporated parcel.",
      "Enumerated by permit-number prefix over the requested years only. The portal holds permit years 15 through 26 (earliest issue date observed 2015-01-02; prefixes 90-, 95-, 00-, 05-, 08-, 10- and 12- all return no results), so any year not listed in permitYearsEnumerated is absent from this job.",
      "The portal's contact grid carries no licence column. Licences shown are either printed inside the contractor name or resolved against the portal's own registered-contractor directory; unmatched contractors keep a null licence rather than a guessed one.",
      "Permits whose parcel key is absent from the Lake seed are captured with a null property_id and are NOT counted as linked.",
      "Successfully fetched permits with no parcel key are retained as valid-unlinked records with null property_id. Only genuine permanent source failures are recorded under dead/ with diagnostic evidence and their enumeration row.",
    ],
  };
  await atomicWriteArtifact(
    path.join(root, "coverage.json"),
    `${JSON.stringify(coverage, null, 2)}\n`,
  );
  log("coverage.done", {
    availability: coverage.availability,
    permitCount: coverage.permitCount,
    achievablePermits: coverage.achievablePermits,
    complete: coverage.complete,
    permitsWithContractorOfRecord: coverage.permitsWithContractorOfRecord,
    distinctContractors: coverage.distinctContractors,
    parcelsLinkedToSeed: coverage.parcelsLinkedToSeed,
  });
  return coverage;
}

/**
 * @returns {Promise<void>} Resolves when the requested command completes.
 */
async function main() {
  const [command] = process.argv.slice(2);
  const flags = parseArgs(process.argv.slice(3));
  const jobId = typeof flags["job-id"] === "string" ? flags["job-id"] : "clermont-2026-09-09";

  if (command === "measure") {
    const root = jobDir(jobId);
    const indexPath = path.join(root, "permit-lists", "clermont-permit-index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const sample = Number(flags.sample ?? 20);
    /**
     * Spread a sample evenly across the enumeration rather than taking a head
     * slice: permit numbers are issued in date order, so the first N are all
     * from the same fortnight and would not exercise the portal's range.
     *
     * @template T
     * @param {readonly T[]} values - Population.
     * @param {number} size - Sample size.
     * @returns {T[]} Evenly spaced sample.
     */
    const spread = (values, size) => {
      const step = Math.max(1, Math.floor(values.length / size));
      return values.filter((_value, position) => position % step === 0).slice(0, size);
    };

    const permitNumbers = spread(index.permits, sample).map((row) => row.permitNumber);
    const alternateKeys = spread(
      [...new Set(index.permits.map((row) => row.alternateKey).filter(Boolean))],
      Number(flags["parcel-sample"] ?? 10),
    );
    const prefixes = spread(
      [...new Set(index.permits.map((row) => String(row.permitNumber).slice(0, 5)))],
      Number(flags["prefix-sample"] ?? 10),
    );
    const concurrencies =
      typeof flags.concurrency === "string"
        ? String(flags.concurrency)
            .split(",")
            .map((level) => Number(level.trim()))
        : [1, 2];
    if (concurrencies.some((level) => !Number.isInteger(level) || level < 1 || level > 4)) {
      throw new Error(
        "Concurrency levels must be integers between 1 and 4; the portal is a municipal server",
      );
    }

    const measurements = await measureThroughput({
      permitNumbers,
      alternateKeys,
      prefixes,
      concurrencies,
    });
    const bytes = await measureBytesWritten(jobId);

    // The estimate is built on the SLOWEST measured detail level that did not
    // degrade, not the fastest: an estimate is a promise about the whole run.
    const safe = measurements.detail
      .filter((level) => level.failureRate <= 0.05)
      .sort((left, right) => right.concurrency - left.concurrency)[0];
    if (safe === undefined)
      throw new Error("No concurrency level met the 5% failure-rate bar; do not scale");

    const seed = await loadSeedIndex();
    const candidateParcels = [...seed.values()].filter(
      (row) =>
        String(row.city ?? "")
          .trim()
          .toUpperCase() === "CLERMONT",
    ).length;
    const strategies = sizeClermontStrategies({
      candidateParcels,
      permitCount: index.permitCount,
      prefixesSearched: index.prefixesSearched,
    });

    /**
     * @param {number} requests - Requests to charge.
     * @param {number} latencyMs - Latency to charge them at.
     * @returns {object} Estimate at the safe concurrency.
     */
    const estimate = (requests, latencyMs) =>
      estimateHarvestDuration({
        requests,
        latencyMs,
        concurrency: safe.concurrency,
        failureRate: safe.failureRate,
        // One retry per failure is what the adapter's backoff actually spends
        // on a transient failure that succeeds on its second attempt.
        retryAttemptsPerFailure: 1,
        fixedOverheadMs: measurements.bootstrap.latency.meanMs ?? 0,
      });

    const detailLatency = safe.latency.p50Ms ?? 0;
    const searchLatency = measurements.listSearch.latency.p50Ms ?? detailLatency;
    const parcelSearchLatency = measurements.parcelSearch.latency.p50Ms ?? detailLatency;
    const years = index.years.length;

    const feasibility = {
      safeConcurrency: safe.concurrency,
      basis: `slowest level at or below a 5% failure rate over ${safe.attempted} detail requests`,
      yearsEnumerated: years,
      candidateParcelsByMailingCity: candidateParcels,
      distinctParcelsInEnumeration: index.distinctAlternateKeys,
      strategies,
      enumeratedYearsInScope: {
        searchSeconds: estimate(strategies.enumerated.searches, searchLatency).seconds,
        detailSeconds: estimate(strategies.enumerated.details, detailLatency).seconds,
        total: estimate(strategies.enumerated.requests, (searchLatency + detailLatency) / 2),
      },
      parcelKeyedYearsInScope: {
        total: estimate(
          strategies.parcelKeyed.requests,
          (parcelSearchLatency * strategies.parcelKeyed.searches +
            detailLatency * strategies.parcelKeyed.details) /
            Math.max(1, strategies.parcelKeyed.requests),
        ),
      },
      gateHours: FEASIBILITY_GATE_HOURS,
    };

    await writeFile(
      path.join(root, "throughput.json"),
      `${JSON.stringify(
        {
          schemaVersion: "elephant.clermont-permit-throughput.v1",
          jobId,
          measuredAt: new Date().toISOString(),
          sourceUrl: CLERMONT_ETRAKIT_SEARCH_URL,
          detailSampleSize: permitNumbers.length,
          measurements,
          bytesWritten: bytes,
          feasibility,
        },
        null,
        2,
      )}\n`,
    );
    log("throughput.feasibility", {
      safeConcurrency: feasibility.safeConcurrency,
      enumeratedHours: feasibility.enumeratedYearsInScope.total.hours,
      parcelKeyedHours: feasibility.parcelKeyedYearsInScope.total.hours,
      withinGate: feasibility.enumeratedYearsInScope.total.withinGate,
    });
    return;
  }
  if (command === "enumerate") {
    const years = String(flags.years ?? "25,26")
      .split(",")
      .map((year) => year.trim());
    await enumeratePermits({
      jobId,
      years,
      concurrency: Number(flags.concurrency ?? 2),
      maxAttempts: Number(flags["max-attempts"] ?? 4),
    });
    return;
  }
  if (command === "harvest") {
    await harvestPermits({
      jobId,
      concurrency: Number(flags.concurrency ?? 2),
      limit: flags.limit === undefined ? Infinity : Number(flags.limit),
      onlyRoofing: flags["only-roofing"] === true,
      delayMs: Number(flags["delay-ms"] ?? 0),
      maxAttempts: Number(flags["max-attempts"] ?? 4),
    });
    return;
  }
  if (command === "renormalize") {
    await renormalizePermits({ jobId });
    return;
  }
  if (command === "export") {
    await exportPermitLoadCsv({
      jobId,
      ...(typeof flags.out === "string" ? { outPath: flags.out } : {}),
    });
    return;
  }
  if (command === "coverage") {
    await summarizeCoverage({ jobId });
    return;
  }
  process.stderr.write(
    "Usage: clermont-permits.mjs <measure|enumerate|harvest|renormalize|export|coverage> [flags]\n",
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
