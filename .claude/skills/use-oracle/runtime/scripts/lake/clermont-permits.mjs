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
 *     status/<alt_key>.json                     per-parcel completion status
 *     throughput.json                           measured source performance
 *     coverage.json                             honest per-jurisdiction coverage
 *
 * Everything is resumable: `enumerate` and `harvest` skip work whose artifact
 * already exists, so re-running the same `--job-id` re-sends only what is
 * missing or failed.
 *
 * Usage:
 *   node scripts/lake/clermont-permits.mjs measure   [--sample 20] [--concurrency 2]
 *   node scripts/lake/clermont-permits.mjs enumerate [--years 25,26] [--job-id <id>]
 *   node scripts/lake/clermont-permits.mjs harvest   [--job-id <id>] [--concurrency 2]
 *                                                    [--limit N] [--only-roofing]
 *   node scripts/lake/clermont-permits.mjs coverage  [--job-id <id>]
 *
 * @module scripts/lake/clermont-permits
 */

import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  createClermontPermitSession,
  expandPermitPrefix,
  normalizeClermontPermit,
  permitYearPrefixes,
  selectContractorOfRecord,
  walkPermitPrefixes,
  CLERMONT_ETRAKIT_SEARCH_URL,
  JURISDICTION_KEY,
} from "../../src/counties/lake/clermont-permits.mjs";
import { mapWithConcurrency } from "../../src/counties/lake/sources.mjs";

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEED_PATH = path.join(RUNTIME_ROOT, "data", "seeds", "lake.csv");

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
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: message, ...fields })}\n`);
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
 * Measure the portal before any bulk harvest: latency, safe concurrency and
 * failure rate on real detail pages, so the full-run estimate is measured
 * rather than assumed.
 *
 * @param {object} options - Measurement options.
 * @param {readonly string[]} options.permitNumbers - Permits to fetch.
 * @param {readonly number[]} [options.concurrencies] - Concurrency levels to try.
 * @returns {Promise<object[]>} One measurement per concurrency level.
 */
export async function measureThroughput({ permitNumbers, concurrencies = [1, 2, 3, 4] }) {
  /** @type {object[]} */
  const measurements = [];
  for (const concurrency of concurrencies) {
    // maxAttempts 1: a measurement must observe the portal's raw failure rate,
    // not the rate after the adapter has already hidden it behind retries.
    const session = createClermontPermitSession({ maxAttempts: 1 });
    const started = Date.now();
    const results = await mapWithConcurrency(permitNumbers, concurrency, async (permitNumber) => {
      const at = Date.now();
      try {
        const { detail, html } = await session.fetchPermitDetail(permitNumber);
        return {
          ms: Date.now() - at,
          ok: true,
          bytes: html.length,
          contractor: selectContractorOfRecord(detail.contacts)?.name ?? null,
        };
      } catch (error) {
        return { ms: Date.now() - at, ok: false, code: error?.code ?? "unknown", bytes: 0, contractor: null };
      }
    });
    const wallSeconds = (Date.now() - started) / 1000;
    const latencies = results.filter((result) => result.ok).map((result) => result.ms).sort((a, b) => a - b);
    const failures = results.filter((result) => !result.ok);
    measurements.push({
      concurrency,
      attempted: results.length,
      wallSeconds: Number(wallSeconds.toFixed(1)),
      requestsPerSecond: Number((results.length / wallSeconds).toFixed(2)),
      p50Ms: latencies[Math.floor(latencies.length * 0.5)] ?? null,
      p95Ms: latencies[Math.floor(latencies.length * 0.95)] ?? null,
      failureCount: failures.length,
      failureRate: Number((failures.length / results.length).toFixed(3)),
      failureCodes: [...new Set(failures.map((failure) => failure.code))],
      contractorCount: results.filter((result) => result.contractor !== null).length,
      averageBytes: Math.round(results.reduce((sum, result) => sum + result.bytes, 0) / results.length),
    });
    log("throughput.level", measurements.at(-1));
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return measurements;
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
 * @returns {Promise<object>} The written permit index.
 */
export async function enumeratePermits({ jobId, years, concurrency = 2 }) {
  const listDir = path.join(jobDir(jobId), "permit-lists");
  await mkdir(listDir, { recursive: true });
  const indexPath = path.join(listDir, "clermont-permit-index.json");

  const roots = permitYearPrefixes(years).flatMap((year) => expandPermitPrefix(year));
  const shards = Array.from({ length: concurrency }, (_, shard) => roots.filter((_root, position) => position % concurrency === shard));

  const started = Date.now();
  const walks = await mapWithConcurrency(shards, concurrency, async (rootPrefixes) => {
    const session = createClermontPermitSession();
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
    rows: [...new Map(walks.flatMap((result) => result.rows).map((row) => [row.permitNumber, row])).values()].sort(
      (left, right) => left.permitNumber.localeCompare(right.permitNumber),
    ),
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
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
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
 * @returns {Promise<object>} Harvest summary.
 */
export async function harvestPermits({ jobId, concurrency = 2, limit = Infinity, onlyRoofing = false }) {
  const root = jobDir(jobId);
  const indexPath = path.join(root, "permit-lists", "clermont-permit-index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  for (const dir of ["raw", "extracted", "status"]) await mkdir(path.join(root, dir), { recursive: true });

  const done = new Set(
    (await readdir(path.join(root, "extracted")).catch(() => [])).map((name) => name.replace(/\.json$/, "")),
  );
  const seed = await loadSeedIndex();
  const session = createClermontPermitSession({ maxAttempts: 4 });
  const licenseIndex = await session.loadContractorLicenseIndex();
  log("harvest.license-directory", { entries: licenseIndex.size });

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

  /** @type {Map<string, { permits: number, failures: number, contractors: number }>} */
  const perParcel = new Map();
  const failures = [];
  let contractorCount = 0;
  let unseededCount = 0;
  let processed = 0;

  await mapWithConcurrency(queue, concurrency, async (row) => {
    const permitKey = safeKeyPart(row.permitNumber);
    const alternateKey = row.alternateKey ?? null;
    try {
      const { detail, html } = await session.fetchPermitDetail(row.permitNumber);
      const boundKey = alternateKey ?? detail.alternateKey;
      if (boundKey === null) {
        throw Object.assign(new Error(`Permit ${row.permitNumber} carries no parcel key`), {
          classification: "permanent",
          code: "permit_without_parcel_key",
        });
      }
      const seedRow = seed.get(boundKey) ?? null;
      if (seedRow === null) unseededCount += 1;
      const record = normalizeClermontPermit({
        detail,
        row,
        requestedAlternateKey: boundKey,
        requestedParcelId: seedRow?.parcelId ?? null,
        licenseIndex,
      });
      await writeFile(path.join(root, "raw", `${permitKey}.html`), html);
      await writeFile(path.join(root, "extracted", `${permitKey}.json`), `${JSON.stringify(record, null, 2)}\n`);
      const bucket = perParcel.get(boundKey) ?? { permits: 0, failures: 0, contractors: 0 };
      bucket.permits += 1;
      if (record.sourcePayload.contractorOfRecord !== null) {
        bucket.contractors += 1;
        contractorCount += 1;
      }
      perParcel.set(boundKey, bucket);
    } catch (error) {
      const entry = {
        permitNumber: row.permitNumber,
        alternateKey,
        classification: error?.classification ?? "transient",
        errorCode: error?.code ?? "unexpected_source_error",
        message: error?.message ?? String(error),
        observedAt: new Date().toISOString(),
      };
      failures.push(entry);
      if (alternateKey) {
        const bucket = perParcel.get(alternateKey) ?? { permits: 0, failures: 0, contractors: 0 };
        bucket.failures += 1;
        perParcel.set(alternateKey, bucket);
      }
      log("harvest.failure", entry);
    }
    processed += 1;
    if (processed % 100 === 0) {
      log("harvest.progress", { processed, queued: queue.length, contractors: contractorCount, failures: failures.length });
    }
  });

  // Status is rebuilt from every extracted record on disk, not from this
  // pass's counters: a resumed run only fetches what is missing, so counting
  // in-memory would rewrite a complete parcel's status with a partial count.
  for (const file of (await readdir(path.join(root, "extracted")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  )) {
    const record = JSON.parse(await readFile(path.join(root, "extracted", file), "utf8"));
    const bucket = perParcel.get(record.parcel_identifier) ?? { permits: 0, failures: 0, contractors: 0 };
    if (!bucket.fromDisk) {
      bucket.permits = 0;
      bucket.contractors = 0;
      bucket.fromDisk = true;
    }
    bucket.permits += 1;
    if (record.sourcePayload.contractorOfRecord !== null) bucket.contractors += 1;
    perParcel.set(record.parcel_identifier, bucket);
  }

  for (const [alternateKey, bucket] of perParcel) {
    const seedRow = seed.get(alternateKey) ?? null;
    await writeFile(
      path.join(root, "status", `${safeKeyPart(alternateKey)}.json`),
      `${JSON.stringify(
        {
          countyKey: "lake",
          jobId,
          parcelIdentifier: alternateKey,
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

  const summary = {
    jobId,
    queued: queue.length,
    captured: queue.length - failures.length,
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
  await writeFile(path.join(root, "harvest-summary.json"), `${JSON.stringify({ ...summary, failures }, null, 2)}\n`);
  log("harvest.done", summary);
  return summary;
}

/**
 * Recompute honest coverage from the artifacts on disk — never from the
 * in-memory counters of the run that happened to write them.
 *
 * @param {object} options - Options.
 * @param {string} options.jobId - Job id.
 * @returns {Promise<object>} Coverage snapshot.
 */
export async function summarizeCoverage({ jobId }) {
  const root = jobDir(jobId);
  const extractedDir = path.join(root, "extracted");
  const files = (await readdir(extractedDir).catch(() => [])).filter((name) => name.endsWith(".json"));
  const seed = await loadSeedIndex();

  let contractorPermits = 0;
  let roofPermits = 0;
  let linkedPermits = 0;
  let licensedContractors = 0;
  const parcels = new Set();
  const contractors = new Set();
  const permitTypes = new Map();
  let firstPermitDate = null;
  let lastPermitDate = null;

  for (const file of files) {
    const record = JSON.parse(await readFile(path.join(extractedDir, file), "utf8"));
    parcels.add(record.parcel_identifier);
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

  const coverage = {
    schemaVersion: "elephant.clermont-permit-coverage.v1",
    jobId,
    countyKey: "lake",
    jurisdictionKey: JURISDICTION_KEY,
    exportedAt: new Date().toISOString(),
    sourceUrl: CLERMONT_ETRAKIT_SEARCH_URL,
    permitCount: files.length,
    permitsWithContractorOfRecord: contractorPermits,
    permitsWithLicensedContractor: licensedContractors,
    roofPermitCount: roofPermits,
    distinctContractors: contractors.size,
    distinctParcels: parcels.size,
    parcelsLinkedToSeed: [...parcels].filter((key) => seed.has(key)).length,
    permitsLinkedToSeedParcel: linkedPermits,
    countySeedParcels: seed.size,
    firstPermitDate,
    lastPermitDate,
    topPermitTypes: [...permitTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    limitations: [
      "Clermont is ONE of fifteen permitting jurisdictions in Lake County; this covers no other municipality and no unincorporated parcel.",
      "Enumerated by permit-number prefix over the requested years only. Clermont permit history reaches back to at least 2015; earlier years are not in this job.",
      "The portal's contact grid carries no licence column. Licences shown are either printed inside the contractor name or resolved against the portal's own registered-contractor directory; unmatched contractors keep a null licence rather than a guessed one.",
      "Permits whose parcel key is absent from the Lake seed are captured with a null property_id and are NOT counted as linked.",
    ],
  };
  await writeFile(path.join(root, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`);
  log("coverage.done", {
    permitCount: coverage.permitCount,
    permitsWithContractorOfRecord: coverage.permitsWithContractorOfRecord,
    distinctContractors: coverage.distinctContractors,
    distinctParcels: coverage.distinctParcels,
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
    const step = Math.max(1, Math.floor(index.permits.length / sample));
    const permitNumbers = index.permits.filter((_, position) => position % step === 0).slice(0, sample).map((row) => row.permitNumber);
    const measurements = await measureThroughput({
      permitNumbers,
      concurrencies: typeof flags.concurrency === "string" ? [Number(flags.concurrency)] : [1, 2, 3, 4],
    });
    await writeFile(
      path.join(root, "throughput.json"),
      `${JSON.stringify({ measuredAt: new Date().toISOString(), sampleSize: permitNumbers.length, measurements }, null, 2)}\n`,
    );
    return;
  }
  if (command === "enumerate") {
    const years = String(flags.years ?? "25,26").split(",").map((year) => year.trim());
    await enumeratePermits({ jobId, years, concurrency: Number(flags.concurrency ?? 2) });
    return;
  }
  if (command === "harvest") {
    await harvestPermits({
      jobId,
      concurrency: Number(flags.concurrency ?? 2),
      limit: flags.limit === undefined ? Infinity : Number(flags.limit),
      onlyRoofing: flags["only-roofing"] === true,
    });
    return;
  }
  if (command === "coverage") {
    await summarizeCoverage({ jobId });
    return;
  }
  process.stderr.write("Usage: clermont-permits.mjs <measure|enumerate|harvest|coverage> [flags]\n");
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
