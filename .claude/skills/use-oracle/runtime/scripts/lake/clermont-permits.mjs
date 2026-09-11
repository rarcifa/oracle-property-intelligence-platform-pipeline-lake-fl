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
 *     dead/<permit>.json                        permanently unattachable permit, recorded not retried
 *     status/<alt_key>.json                     per-parcel completion status
 *     throughput.json                           measured source performance
 *     coverage.json                             honest per-jurisdiction coverage
 *
 * Everything is resumable: `enumerate` and `harvest` skip work whose artifact
 * already exists — captured under `extracted/` or recorded dead under `dead/` —
 * so re-running the same `--job-id` re-sends only what is missing or genuinely
 * retryable. A permanently unattachable permit is recorded once and never
 * refetched (`docs/lake-kit-deviations.md` §23).
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
 *   node scripts/lake/clermont-permits.mjs harvest   [--job-id <id>] [--concurrency 2]
 *                                                    [--limit N] [--only-roofing] [--delay-ms 0]
 *   node scripts/lake/clermont-permits.mjs renormalize [--job-id <id>]
 *   node scripts/lake/clermont-permits.mjs export    [--job-id <id>] [--out <path>]
 *   node scripts/lake/clermont-permits.mjs coverage  [--job-id <id>]
 *
 * @module scripts/lake/clermont-permits
 */

import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  clermontPermitLoadRow,
  contractorMatchKey,
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
      parcelSearchMs.length > 0 ? Number((parcelSearchRows / parcelSearchMs.length).toFixed(2)) : null,
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
    rowsPerSearch: listSearchMs.length > 0 ? Number((listRows / listSearchMs.length).toFixed(2)) : null,
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
        return { ms: Date.now() - at, ok: false, code: error?.code ?? "unknown", bytes: 0, contractor: null };
      }
    });
    const wallSeconds = (Date.now() - started) / 1000;
    const latency = summarizeLatencies(results.filter((result) => result.ok).map((result) => result.ms));
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
      averageBytes: Math.round(results.reduce((sum, result) => sum + result.bytes, 0) / results.length),
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
 * @param {number} [options.delayMs] - Politeness pause each worker takes after every permit.
 * @returns {Promise<object>} Harvest summary.
 */
export async function harvestPermits({
  jobId,
  concurrency = 2,
  limit = Infinity,
  onlyRoofing = false,
  delayMs = 0,
}) {
  const root = jobDir(jobId);
  const indexPath = path.join(root, "permit-lists", "clermont-permit-index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  for (const dir of ["raw", "extracted", "status", "dead"]) await mkdir(path.join(root, dir), { recursive: true });

  // Resume skips what is already captured AND what is already known dead.
  // Without the second half a permanently unattachable permit is re-fetched on
  // every pass forever: `county-ingest-run` section 5 is explicit that a DEAD
  // record is recorded and never retried, and that the achievable total is
  // enumerated minus dead, so a pass that keeps re-attempting them can never
  // reach its own completion gate.
  const done = new Set(
    [
      ...(await readdir(path.join(root, "extracted")).catch(() => [])),
      ...(await readdir(path.join(root, "dead")).catch(() => [])),
    ].map((name) => name.replace(/\.json$/, "")),
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
      if (entry.classification === "permanent") {
        // The enumeration row is kept alongside the reason. A permit the
        // portal will never attach to a parcel is still a permit that exists,
        // and the coverage snapshot reports it as one; dropping the row here
        // would turn a known record into an absence nobody could audit.
        await writeFile(
          path.join(root, "dead", `${permitKey}.json`),
          `${JSON.stringify({ ...entry, searchRow: row }, null, 2)}\n`,
        );
      }
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

  const deadCount = (await readdir(path.join(root, "dead")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  ).length;
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
  await writeFile(path.join(root, "harvest-summary.json"), `${JSON.stringify({ ...summary, failures }, null, 2)}\n`);
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
  const index = JSON.parse(await readFile(path.join(root, "permit-lists", "clermont-permit-index.json"), "utf8"));
  const rows = new Map(index.permits.map((row) => [safeKeyPart(row.permitNumber), row]));
  const seed = await loadSeedIndex();
  const licenseIndex = licenseIndexFromSearchPage(
    await readFile(path.join(root, "license-directory.html"), "utf8").catch(() => ""),
  );

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
        // The licence index is rebuilt from a saved page when one exists. When
        // it does not, a licence already resolved on the harvest pass is kept
        // rather than dropped: re-normalizing must never lose a fact.
        licenseIndex:
          licenseIndex.size > 0
            ? licenseIndex
            : new Map(
                (previous.contractors ?? [])
                  .filter((contractor) => contractor.licenseNumber !== null)
                  .map((contractor) => [contractorMatchKey(contractor.businessName), contractor.licenseNumber]),
              ),
      });
      const next = `${JSON.stringify(record, null, 2)}\n`;
      if (next === `${JSON.stringify(previous, null, 2)}\n`) {
        unchanged += 1;
      } else {
        await writeFile(extractedPath, next);
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
  const destination = outPath ?? path.join(RUNTIME_ROOT, "data", "downloads", "lake", "clermont-permits.csv");
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
  const index = await readFile(path.join(root, "permit-lists", "clermont-permit-index.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const deadPermits = (await readdir(path.join(root, "dead")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  ).length;

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
  await writeFile(`${destination.replace(/\.csv$/, "")}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  const summary = { rows: files.length, parcels: parcels.size, withContractor, outPath: destination, ...meta };
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
 * `achievable = enumerated - dead`, and a permit the portal will not attach to
 * any parcel is dead by the source's own answer.
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

  const index = await readFile(path.join(root, "permit-lists", "clermont-permit-index.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);

  /** @type {Record<string, number>} */
  const deadByReason = {};
  const deadFiles = (await readdir(path.join(root, "dead")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  );
  for (const file of deadFiles) {
    const entry = JSON.parse(await readFile(path.join(root, "dead", file), "utf8"));
    deadByReason[entry.errorCode] = (deadByReason[entry.errorCode] ?? 0) + 1;
  }

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

  const enumerated = index?.permitCount ?? files.length + deadFiles.length;
  const achievable = enumerated - deadFiles.length;
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
    deadPermits: deadFiles.length,
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
      "Permits the portal files against no parcel key at all are recorded under dead/ with their enumeration row and counted in deadPermits. They are real permits that attach to no property, never a property with no permits.",
    ],
  };
  await writeFile(path.join(root, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`);
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
      throw new Error("Concurrency levels must be integers between 1 and 4; the portal is a municipal server");
    }

    const measurements = await measureThroughput({ permitNumbers, alternateKeys, prefixes, concurrencies });
    const bytes = await measureBytesWritten(jobId);

    // The estimate is built on the SLOWEST measured detail level that did not
    // degrade, not the fastest: an estimate is a promise about the whole run.
    const safe = measurements.detail
      .filter((level) => level.failureRate <= 0.05)
      .sort((left, right) => right.concurrency - left.concurrency)[0];
    if (safe === undefined) throw new Error("No concurrency level met the 5% failure-rate bar; do not scale");

    const seed = await loadSeedIndex();
    const candidateParcels = [...seed.values()].filter(
      (row) => String(row.city ?? "").trim().toUpperCase() === "CLERMONT",
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
          (parcelSearchLatency * strategies.parcelKeyed.searches + detailLatency * strategies.parcelKeyed.details) /
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
      delayMs: Number(flags["delay-ms"] ?? 0),
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
