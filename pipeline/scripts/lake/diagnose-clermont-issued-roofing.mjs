#!/usr/bin/env node
/**
 * Bounded read-only diagnosis for retained Clermont source-listed issued
 * roofing permits. This is not a harvest and does not promote countywide
 * conclusions. It binds the retained CSV digest before fetching exactly ten
 * existing candidate detail pages through normal GET requests.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseCsvRecords } from "../../src/core/csv.mjs";
import { parsePermitDetailHtml } from "../../src/counties/lake/clermont-permits.mjs";

const DEFAULT_CSV =
  "pipeline/data/baselines/lake/clermont/baselines/05959a36584293386b52127513aa5b90728b3f634424b2141518ae8fb8e85e02/exports/clermont-permits.csv";
const DEFAULT_OUTPUT_ROOT = path.join(
  homedir(),
  ".local/share/oracle-lake-fl-kit/score-repair-20260917-9msga0",
);
const EXPECTED_CSV_SHA =
  "bbd2f8ba7361ffc4740b9f4aa20649cc56cddac31c49250f8bfecf41c3473c2a";
const LIMIT = 10;
const DELAY_MS = 600;
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const literalRoofType = (row) =>
  /(^|[^A-Z])(ROOF|REROOF)([^A-Z]|$)/u.test(row.permit_type ?? "");
export const sourceIssuedRoofing = (row) =>
  row.source_system === "lake_clermont_etrakit_permits" &&
  row.permit_status === "ISSUED" &&
  row.issued_date !== "" &&
  literalRoofType(row);

export function selectIssuedRoofingCandidates(rows, limit = LIMIT) {
  return rows
    .filter(sourceIssuedRoofing)
    .sort(
      (a, b) =>
        a.issued_date.localeCompare(b.issued_date) ||
        a.permit_number.localeCompare(b.permit_number),
    )
    .slice(0, limit);
}

function assertPrivateOutputRoot(outputRoot) {
  const resolved = path.resolve(outputRoot);
  const cwd = path.resolve(process.cwd());
  if (resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`)) {
    throw new Error("Diagnostic raw output root must be outside the repository");
  }
  return resolved;
}

export function parseArgs(argv) {
  const options = { csv: DEFAULT_CSV, outputRoot: DEFAULT_OUTPUT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--csv" && value) {
      options.csv = value;
      index += 1;
    } else if (flag === "--output-root" && value) {
      options.outputRoot = value;
      index += 1;
    } else {
      throw new Error(`Unsupported argument ${flag}`);
    }
  }
  options.outputRoot = assertPrivateOutputRoot(options.outputRoot);
  return options;
}

async function fetchDetail(row, directory) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(DELAY_MS);
    const observedAt = new Date().toISOString();
    const htmlPath = path.join(directory, `${row.permit_number}.html`);
    try {
      const { stdout } = await execFileAsync(
        "curl",
        [
          "--silent",
          "--show-error",
          "--max-time",
          String(Math.ceil(TIMEOUT_MS / 1000)),
          "--write-out",
          "\\n%{http_code}",
          "--output",
          htmlPath,
          row.permit_url,
        ],
        { timeout: TIMEOUT_MS + 5_000, maxBuffer: 1024 * 1024 },
      );
      const statusLine = stdout.trim().split(/\s+/u).at(-1);
      const httpStatus = Number(statusLine);
      if (!Number.isInteger(httpStatus)) throw new Error("curl did not report an HTTP status");
      const body = await readFile(htmlPath);
      const htmlSha256 = sha256(body);
      if (httpStatus < 200 || httpStatus > 299) throw new Error(`HTTP ${httpStatus}`);
      const detail = parsePermitDetailHtml(body.toString("utf8"), {
        expectedPermitNumber: row.permit_number,
      });
      return {
        ok: true,
        attempt,
        observedAt,
        htmlFile: path.basename(htmlPath),
        htmlSha256,
        httpStatus,
        detail,
      };
    } catch (error) {
      lastError = {
        attempt,
        observedAt,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: false, error: lastError };
}

function summarize(row, result) {
  const source = {
    permitNumber: row.permit_number,
    permitType: row.permit_type,
    permitStatus: row.permit_status,
    appliedDate: row.applied_date || null,
    issuedDate: row.issued_date || null,
    finaledOrCoDate: row.co_date || null,
    expiresDate: null,
    urlSha256: sha256(Buffer.from(row.permit_url)),
  };
  if (!result.ok) return { source, result };
  const detail = result.detail;
  const identityMatches =
    detail.permitNumber === row.permit_number &&
    detail.issuedDate === (row.issued_date || null) &&
    detail.permitType?.toUpperCase() === row.permit_type;
  const detailStatus = detail.status?.toUpperCase() ?? null;
  const detailType = detail.permitType?.toUpperCase() ?? null;
  const detailRoofLiteral = /(^|[^A-Z])(ROOF|REROOF)([^A-Z]|$)/u.test(detailType ?? "");
  const detailIssued = detailStatus === "ISSUED";
  const terminalDatePresent = detail.finaledDate !== null;
  const contradictions = [
    ...(detailStatus !== row.permit_status
      ? [`source_status_${row.permit_status}_detail_status_${detailStatus ?? "NULL"}`]
      : []),
    ...(detailType !== row.permit_type
      ? [`source_type_${row.permit_type}_detail_type_${detailType ?? "NULL"}`]
      : []),
    ...(row.issued_date && detail.issuedDate !== row.issued_date
      ? [`source_issued_${row.issued_date}_detail_issued_${detail.issuedDate ?? "NULL"}`]
      : []),
    ...(detailIssued && terminalDatePresent ? ["issued_status_with_finaled_date"] : []),
  ];
  return {
    source,
    result: {
      ok: true,
      attempt: result.attempt,
      observedAt: result.observedAt,
      httpStatus: result.httpStatus,
      htmlFile: result.htmlFile,
      htmlSha256: result.htmlSha256,
      identityMatches,
      sourceFieldsCompleteness: {
        detailPermitNumber: detail.permitNumber !== null,
        detailType: detail.permitType !== null,
        detailStatus: detail.status !== null,
        detailAppliedDate: detail.appliedDate !== null,
        detailIssuedDate: detail.issuedDate !== null,
        detailFinaledDate: detail.finaledDate !== null,
        detailExpirationDate: detail.expirationDate !== null,
        detailDescription: detail.description !== null,
      },
      detailObservation: {
        permitType: detail.permitType,
        status: detail.status,
        appliedDate: detail.appliedDate,
        approvedDate: detail.approvedDate,
        issuedDate: detail.issuedDate,
        finaledDate: detail.finaledDate,
        expirationDate: detail.expirationDate,
        workDescriptionPresent: detail.description !== null,
        contactRows: detail.contacts.length,
        inspectionRows: detail.inspections.length,
      },
      support: {
        sourceListedIssuedRoofingAsOfObservation:
          identityMatches && detailIssued && detailRoofLiteral && contradictions.length === 0,
        primaryRoofAgeResetSupported: false,
        legalIdentitySupported: false,
      },
      lifecycleContradictions: contradictions,
    },
  };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const csvPath = path.resolve(options.csv);
  const csvBytes = await readFile(csvPath);
  const csvSha256 = sha256(csvBytes);
  if (csvSha256 !== EXPECTED_CSV_SHA) {
    throw new Error(`retained CSV digest mismatch: ${csvSha256}`);
  }
  const rows = parseCsvRecords(csvBytes.toString("utf8"));
  const candidates = selectIssuedRoofingCandidates(rows, LIMIT);
  if (candidates.length !== LIMIT) throw new Error(`expected ${LIMIT} candidates`);
  await mkdir(options.outputRoot, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(path.join(options.outputRoot, "diagnostic-"));
  const rawDirectory = path.join(output, "raw-html");
  await mkdir(rawDirectory, { mode: 0o700 });
  const results = [];
  for (const row of candidates) {
    if (results.length > 0) await sleep(DELAY_MS);
    results.push(summarize(row, await fetchDetail(row, rawDirectory)));
  }
  const success = results.filter((entry) => entry.result.ok);
  const supported = success.filter(
    (entry) => entry.result.support.sourceListedIssuedRoofingAsOfObservation,
  );
  const report = {
    schemaVersion: "oracle.lake.clermont-issued-roofing-diagnostic.v1",
    generatedAt: new Date().toISOString(),
    scope: {
      county: "lake",
      jurisdiction: "clermont",
      sourceSystem: "lake_clermont_etrakit_permits",
      candidateRule: "oldest retained CSV rows where permit_type literal ROOF/REROOF, permit_status ISSUED, issued_date non-null",
      limit: LIMIT,
      concurrency: 1,
      delayMs: DELAY_MS,
      maxAttempts: MAX_ATTEMPTS,
      timeoutMs: TIMEOUT_MS,
      userAgentSpoofing: false,
      authentication: false,
    },
    retainedCsv: {
      path: path.relative(process.cwd(), csvPath),
      rows: rows.length,
      sha256: csvSha256,
    },
    counts: {
      retainedLiteralRoofReroof: rows.filter(literalRoofType).length,
      retainedIssued: rows.filter((row) => row.permit_status === "ISSUED").length,
      retainedIssuedLiteralRoofReroofWithIssueDate: rows.filter(sourceIssuedRoofing).length,
      sampled: results.length,
      detailSuccess: success.length,
      detailSupport: supported.length,
      identityMatches: success.filter((entry) => entry.result.identityMatches).length,
      contradictions: success.filter((entry) => entry.result.lifecycleContradictions.length > 0)
        .length,
    },
    conclusion: {
      supportsScopedSampleConclusion:
        success.length === LIMIT && supported.length === LIMIT,
      allowedWording:
        "For the sampled permits only: source-listed ISSUED literal ROOF/REROOF permits as of each successful detail observedAt.",
      blockedWording:
        "Do not generalize to all retained rows as current open roofing permits; do not use for primary roof-age reset or legal contractor identity.",
    },
    permits: results,
  };
  await writeFile(path.join(output, "diagnostic-report.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        output,
        retainedCsvSha256: csvSha256,
        counts: report.counts,
        supportsScopedSampleConclusion: report.conclusion.supportsScopedSampleConclusion,
      },
      null,
      2,
    ),
  );
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
