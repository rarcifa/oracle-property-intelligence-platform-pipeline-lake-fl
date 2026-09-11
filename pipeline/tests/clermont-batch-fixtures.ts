import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Text } from "../src/batch/contracts.js";
import {
  CLERMONT_BASELINE_SCHEMA_VERSION,
  CLERMONT_MERGED_EXPORT_METADATA_SCHEMA_VERSION,
  CLERMONT_PARTITION_HANDOFF_SCHEMA_VERSION,
  CLERMONT_PERMIT_YEARS,
  CLERMONT_REQUEST_SCHEMA_VERSION,
  clermontBaselineDigest,
  clermontCertifiedBaselineSchema,
  clermontPartitionHandoffSchema,
  clermontPartitionId,
  clermontRunRequestSchema,
  type ClermontCertifiedBaseline,
  type ClermontRunRequest,
  type ClermontSignatureSet,
} from "../src/batch/clermont-contracts.js";

export const clermontSignatures: ClermontSignatureSet = {
  sourceSha256: "1".repeat(64),
  configurationSha256: "2".repeat(64),
  schemaSha256: "3".repeat(64),
};

const syntheticMergedMetadata = `${canonicalJson({
  schemaVersion: CLERMONT_MERGED_EXPORT_METADATA_SCHEMA_VERSION,
  jobId: "lake-clermont-capture-20260911",
  exportedAt: "2026-09-11T08:20:00.000Z",
  sourceUrl: "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx",
  permitYears: CLERMONT_PERMIT_YEARS.map((year) => String(year).slice(-2)),
  enumeratedPermits: 24,
  deadPermits: 0,
  achievablePermits: 24,
  loadedPermits: 24,
})}\n`;

const syntheticArtifactContents = {
  raw: '{"synthetic":"raw"}\n',
  extracted: '{"synthetic":"extracted"}\n',
  status: '{"synthetic":"status"}\n',
  mergedExport: `${[
    "permit_number,alternate_key",
    ...Array.from(
      { length: 24 },
      (_, index) => `synthetic-${index + 1},synthetic-key-${index + 1}`,
    ),
  ].join("\n")}\n`,
  mergedMetadata: syntheticMergedMetadata,
} as const;

export async function writeSyntheticClermontArtifacts(artifactRoot: string): Promise<void> {
  for (const year of CLERMONT_PERMIT_YEARS) {
    const partitionRoot = path.join(artifactRoot, "partitions", String(year));
    await mkdir(partitionRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(partitionRoot, "raw.ndjson"), syntheticArtifactContents.raw),
      writeFile(path.join(partitionRoot, "extracted.ndjson"), syntheticArtifactContents.extracted),
      writeFile(path.join(partitionRoot, "status.ndjson"), syntheticArtifactContents.status),
    ]);
  }
  const exportRoot = path.join(artifactRoot, "exports");
  await mkdir(exportRoot, { recursive: true });
  await writeFile(
    path.join(exportRoot, "clermont-permits.csv"),
    syntheticArtifactContents.mergedExport,
  );
  await writeFile(
    path.join(exportRoot, "clermont-permits.meta.json"),
    syntheticArtifactContents.mergedMetadata,
  );
}

const benchmark = JSON.parse(
  readFileSync(
    path.join(
      process.cwd(),
      "fixtures",
      "permits",
      "lake",
      "clermont",
      "synthetic-ingestion-plan.json",
    ),
    "utf8",
  ),
);

export function syntheticClermontBaseline(
  options: {
    certifiedAt?: string;
    expiresAt?: string;
    openYears?: number[];
    signatures?: ClermontSignatureSet;
  } = {},
): ClermontCertifiedBaseline {
  const signatures = options.signatures ?? clermontSignatures;
  const openYears = new Set(options.openYears ?? [2020, 2026]);
  const partitions = CLERMONT_PERMIT_YEARS.map((year) => {
    const openPermitStableIds = openYears.has(year) ? [`lake:clermont:etrakit:${year}-0001`] : [];
    return clermontPartitionHandoffSchema.parse({
      schemaVersion: CLERMONT_PARTITION_HANDOFF_SCHEMA_VERSION,
      runId: "lake-clermont-capture-20260911",
      county: "lake",
      jurisdiction: "clermont",
      sourceSystem: "lake_clermont_etrakit_permits",
      producer: "clermont-permit-acquisition",
      intendedConsumer: "clermont-baseline-certifier",
      privacyClassification: "public-record",
      nextStage: "reconciliation",
      year,
      partitionId: clermontPartitionId(year),
      createdAt: "2026-09-11T08:10:00.000Z",
      sourceWindowState: year >= 2025 ? "active" : "closed",
      status: "captured_complete",
      cappedOrTruncated: false,
      counts: {
        enumerated: 2,
        completed: 2,
        provenDead: 0,
        retryablePending: 0,
        linked: 1,
        validUnlinked: 1,
        withContractor: 1,
        withLicense: 1,
        open: openPermitStableIds.length,
        rawEvidence: 2,
        extractedEvidence: 2,
        statusEvidence: 2,
      },
      stableIdsSha256: "4".repeat(64),
      openPermitStableIds,
      checkpoint: {
        sequence: 2,
        cursor: `${year}:terminal`,
        checkpointSha256: "5".repeat(64),
        terminal: true,
        signatures,
      },
      artifacts: {
        raw: {
          logicalPath: `partitions/${year}/raw.ndjson`,
          sha256: sha256Text(syntheticArtifactContents.raw),
          bytes: Buffer.byteLength(syntheticArtifactContents.raw),
        },
        extracted: {
          logicalPath: `partitions/${year}/extracted.ndjson`,
          sha256: sha256Text(syntheticArtifactContents.extracted),
          bytes: Buffer.byteLength(syntheticArtifactContents.extracted),
        },
        status: {
          logicalPath: `partitions/${year}/status.ndjson`,
          sha256: sha256Text(syntheticArtifactContents.status),
          bytes: Buffer.byteLength(syntheticArtifactContents.status),
        },
      },
      signatures,
    });
  });
  return clermontCertifiedBaselineSchema.parse({
    schemaVersion: CLERMONT_BASELINE_SCHEMA_VERSION,
    baselineId: "lake-clermont-baseline-20260911",
    county: "lake",
    jurisdiction: "clermont",
    sourceSystem: "lake_clermont_etrakit_permits",
    requiredHistory: { firstYear: 2015, lastYear: 2026 },
    certifiedAt: options.certifiedAt ?? "2026-09-11T08:30:00.000Z",
    expiresAt: options.expiresAt ?? "2026-09-18T08:30:00.000Z",
    status: "certified",
    evidenceSha256: "9".repeat(64),
    signatures,
    partitions,
    mergedExport: {
      artifact: {
        logicalPath: "exports/clermont-permits.csv",
        sha256: sha256Text(syntheticArtifactContents.mergedExport),
        bytes: Buffer.byteLength(syntheticArtifactContents.mergedExport),
      },
      metadata: {
        logicalPath: "exports/clermont-permits.meta.json",
        sha256: sha256Text(syntheticArtifactContents.mergedMetadata),
        bytes: Buffer.byteLength(syntheticArtifactContents.mergedMetadata),
      },
      rows: partitions.reduce((sum, partition) => sum + partition.counts.completed, 0),
    },
  });
}

export function syntheticClermontRequest(
  options: {
    refreshMode?: "full" | "incremental";
    baseline?: ClermontCertifiedBaseline;
    terminalRecordsPerHour?: number;
    costCeilingUsd?: number;
    runnerHourlyUsd?: number;
    authorization?: ClermontRunRequest["authorization"];
    signatures?: ClermontSignatureSet;
  } = {},
): ClermontRunRequest {
  const refreshMode = options.refreshMode ?? "incremental";
  const baselineValue = options.baseline ?? syntheticClermontBaseline();
  return clermontRunRequestSchema.parse({
    schemaVersion: CLERMONT_REQUEST_SCHEMA_VERSION,
    runId: "lake-clermont-refresh-20260911",
    county: "lake",
    jurisdiction: "clermont",
    sourceSystem: "lake_clermont_etrakit_permits",
    requestedYears: [...CLERMONT_PERMIT_YEARS],
    refreshMode,
    asOfYear: 2026,
    signatures: options.signatures ?? clermontSignatures,
    baseline: {
      requiredSha256: refreshMode === "incremental" ? clermontBaselineDigest(baselineValue) : null,
      maxAgeHours: 24 * 7,
    },
    benchmark: {
      ...benchmark,
      terminalRecordsPerHour: options.terminalRecordsPerHour ?? benchmark.terminalRecordsPerHour,
    },
    limits: {
      costCeilingUsd: options.costCeilingUsd ?? 5,
      maxAutomaticHours: 48,
      runnerHourlyUsd: options.runnerHourlyUsd ?? 0.1,
      requestCostPerThousandUsd: 0.01,
      storagePerGbUsd: 0.03,
      maxAttempts: 3,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      circuitBreakerFailures: 2,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
    },
    authorization: options.authorization ?? null,
  });
}
