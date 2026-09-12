import { z } from "zod";

import { canonicalJson, sha256Text } from "./contracts.js";

export const CLERMONT_REQUEST_SCHEMA_VERSION = "elephant.clermont-permit-run-request.v1";
export const CLERMONT_PARTITION_HANDOFF_SCHEMA_VERSION =
  "elephant.clermont-permit-partition-handoff.v2";
export const CLERMONT_BASELINE_SCHEMA_VERSION = "elephant.clermont-permit-certified-baseline.v1";
export const CLERMONT_BASELINE_POINTER_SCHEMA_VERSION =
  "elephant.clermont-permit-last-good-pointer.v1";
export const CLERMONT_MERGED_EXPORT_METADATA_SCHEMA_VERSION =
  "elephant.clermont-permit-load-meta.v1";
export const CLERMONT_REMOTE_STORAGE_LIMIT_BYTES = 150 * 1024 ** 3;

export const CLERMONT_PERMIT_YEARS = Object.freeze([
  2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
] as const);
export const CLERMONT_HARVESTER_REQUEST_ATTEMPTS = 4 as const;
export const CLERMONT_MAX_ENUMERATION_PREFIXES_PER_YEAR = 11_111 as const;
export const CLERMONT_ENUMERATION_RESULT_CAP = 100 as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const runIdSchema = z
  .string()
  .min(8)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const stablePermitIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^lake:clermont:etrakit:[A-Za-z0-9._:/-]+$/);
const permitYearSchema = z.number().int().min(2015).max(2026);

export const clermontCostAuthorizationSchema = z
  .object({
    authorizationId: z.string().regex(/^[a-z0-9][a-z0-9-]{15,119}$/),
    runId: runIdSchema,
    requestScopeSha256: sha256Schema,
    provenanceSha256: sha256Schema,
    estimateSha256: sha256Schema,
    maxExecutionHours: z
      .number()
      .positive()
      .finite()
      .max(24 * 24),
    maxCostUsd: z.number().positive().finite().max(1_000),
    approvedBy: z.string().min(1).max(200),
    approvedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((authorization, context) => {
    if (Date.parse(authorization.expiresAt) <= Date.parse(authorization.approvedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Cost authorization must expire after approval",
      });
    }
  });

export function clermontPartitionId(year: number): string {
  permitYearSchema.parse(year);
  return `lake-clermont-etrakit-${year}`;
}

export const clermontSignatureSetSchema = z
  .object({
    sourceSha256: sha256Schema,
    configurationSha256: sha256Schema,
    schemaSha256: sha256Schema,
  })
  .strict();

export type ClermontSignatureSet = z.infer<typeof clermontSignatureSetSchema>;

export const clermontRemoteBaselineSchema = z
  .object({
    accountId: z.string().regex(/^[0-9]{12}$/),
    region: z.string().regex(/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    prefix: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.endsWith("/") &&
          !value.split("/").some((part) => part === "" || part === ".."),
        "Remote baseline prefix must be canonical, relative, and cannot traverse parents",
      ),
    maxRetainedBytes: z.literal(CLERMONT_REMOTE_STORAGE_LIMIT_BYTES),
  })
  .strict();

export const clermontRuntimeSchema = z
  .object({
    nodeVersion: z.string().regex(/^v22\.[0-9]+\.[0-9]+$/),
    platform: z.enum(["darwin", "linux"]),
    architecture: z.enum(["arm64", "x64"]),
  })
  .strict();

export const clermontImmutableArtifactSchema = z
  .object({
    logicalPath: z
      .string()
      .min(1)
      .max(500)
      .refine(
        (value) => !value.startsWith("/") && !value.split("/").some((segment) => segment === ".."),
        "Artifact paths must be relative and cannot contain parent traversal",
      ),
    sha256: sha256Schema,
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export type ClermontImmutableArtifact = z.infer<typeof clermontImmutableArtifactSchema>;

export const CLERMONT_LICENSE_DIRECTORY_VALIDITY_BOUNDARY =
  "contractor-registration-at-capture-not-historical-license-validity" as const;

export const clermontLicenseDirectoryProvenanceSchema = z
  .object({
    sourceUrl: z.literal("https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx"),
    capturedAt: z.string().datetime({ offset: true }),
    entries: z.number().int().nonnegative(),
    validityBoundary: z.literal(CLERMONT_LICENSE_DIRECTORY_VALIDITY_BOUNDARY),
    sha256: sha256Schema,
  })
  .strict();

export const clermontCheckpointSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    cursor: z.string().min(1).max(500),
    checkpointSha256: sha256Schema,
    terminal: z.boolean(),
    signatures: clermontSignatureSetSchema,
  })
  .strict();

export const clermontPartitionCountsSchema = z
  .object({
    enumerated: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    provenDead: z.number().int().nonnegative(),
    retryablePending: z.number().int().nonnegative(),
    linked: z.number().int().nonnegative(),
    validUnlinked: z.number().int().nonnegative(),
    withContractor: z.number().int().nonnegative(),
    withLicense: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    rawEvidence: z.number().int().nonnegative(),
    extractedEvidence: z.number().int().nonnegative(),
    statusEvidence: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((counts, context) => {
    const issues: Array<[keyof typeof counts, string]> = [];
    if (counts.enumerated !== counts.completed + counts.provenDead + counts.retryablePending) {
      issues.push([
        "enumerated",
        "enumerated must equal completed + provenDead + retryablePending",
      ]);
    }
    if (counts.completed !== counts.linked + counts.validUnlinked) {
      issues.push(["completed", "completed must equal linked + validUnlinked"]);
    }
    if (counts.withContractor > counts.completed) {
      issues.push(["withContractor", "contractor count cannot exceed completed records"]);
    }
    if (counts.withLicense > counts.withContractor) {
      issues.push(["withLicense", "license count cannot exceed contractor count"]);
    }
    if (counts.open > counts.completed) {
      issues.push(["open", "open count cannot exceed completed records"]);
    }
    if (
      counts.rawEvidence < counts.completed + counts.provenDead ||
      counts.rawEvidence > counts.enumerated
    ) {
      issues.push([
        "rawEvidence",
        "raw evidence must cover completed/proven-dead records and cannot exceed enumeration",
      ]);
    }
    if (counts.extractedEvidence !== counts.completed) {
      issues.push(["extractedEvidence", "extracted evidence must cover every completed record"]);
    }
    if (counts.statusEvidence !== counts.enumerated) {
      issues.push(["statusEvidence", "status evidence must cover every enumerated record"]);
    }
    for (const [path, message] of issues) {
      context.addIssue({ code: "custom", path: [path], message });
    }
  });

export type ClermontPartitionCounts = z.infer<typeof clermontPartitionCountsSchema>;

export const clermontPartitionHandoffSchema = z
  .object({
    schemaVersion: z.literal(CLERMONT_PARTITION_HANDOFF_SCHEMA_VERSION),
    runId: runIdSchema,
    county: z.literal("lake"),
    jurisdiction: z.literal("clermont"),
    sourceSystem: z.literal("lake_clermont_etrakit_permits"),
    producer: z.literal("clermont-permit-acquisition"),
    intendedConsumer: z.literal("clermont-baseline-certifier"),
    privacyClassification: z.literal("public-record"),
    nextStage: z.literal("reconciliation"),
    year: permitYearSchema,
    partitionId: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    producerLease: z
      .object({
        owner: z.string().min(1).max(200),
        fencingToken: z.number().int().positive(),
        heartbeatAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    sourceWindowState: z.enum(["closed", "active"]),
    status: z.enum([
      "enumerating",
      "running",
      "cooling_down",
      "captured_complete",
      "failed_exhausted",
    ]),
    cappedOrTruncated: z.boolean(),
    counts: clermontPartitionCountsSchema,
    stableIdsSha256: sha256Schema,
    openPermitStableIds: z.array(stablePermitIdSchema),
    checkpoint: clermontCheckpointSchema,
    artifacts: z
      .object({
        raw: clermontImmutableArtifactSchema,
        extracted: clermontImmutableArtifactSchema,
        status: clermontImmutableArtifactSchema,
        licenseDirectory: clermontImmutableArtifactSchema,
      })
      .strict(),
    licenseDirectory: clermontLicenseDirectoryProvenanceSchema,
    signatures: clermontSignatureSetSchema,
  })
  .strict()
  .superRefine((handoff, context) => {
    if (handoff.partitionId !== clermontPartitionId(handoff.year)) {
      context.addIssue({
        code: "custom",
        path: ["partitionId"],
        message: "Partition ID is not the stable Clermont year identity",
      });
    }
    if (Date.parse(handoff.producerLease.heartbeatAt) > Date.parse(handoff.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["producerLease", "heartbeatAt"],
        message: "Producer lease heartbeat cannot postdate the fenced handoff",
      });
    }
    if (new Set(handoff.openPermitStableIds).size !== handoff.openPermitStableIds.length) {
      context.addIssue({
        code: "custom",
        path: ["openPermitStableIds"],
        message: "Open permit stable IDs must be unique",
      });
    }
    if (handoff.openPermitStableIds.length !== handoff.counts.open) {
      context.addIssue({
        code: "custom",
        path: ["openPermitStableIds"],
        message: "Open permit stable IDs must reconcile to the open count",
      });
    }
    if (canonicalJson(handoff.checkpoint.signatures) !== canonicalJson(handoff.signatures)) {
      context.addIssue({
        code: "custom",
        path: ["checkpoint", "signatures"],
        message: "Checkpoint signatures must match the handoff exactly",
      });
    }
    if (handoff.licenseDirectory.sha256 !== handoff.artifacts.licenseDirectory.sha256) {
      context.addIssue({
        code: "custom",
        path: ["licenseDirectory", "sha256"],
        message: "License-directory provenance must bind the exact immutable artifact digest",
      });
    }
    if (Date.parse(handoff.licenseDirectory.capturedAt) > Date.parse(handoff.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["licenseDirectory", "capturedAt"],
        message: "License-directory capture cannot postdate its partition handoff",
      });
    }
    if (handoff.status === "captured_complete") {
      if (handoff.cappedOrTruncated) {
        context.addIssue({
          code: "custom",
          path: ["cappedOrTruncated"],
          message: "A capped or truncated partition cannot be complete",
        });
      }
      if (handoff.counts.retryablePending !== 0) {
        context.addIssue({
          code: "custom",
          path: ["counts", "retryablePending"],
          message: "A complete partition cannot retain retryable work",
        });
      }
      if (!handoff.checkpoint.terminal) {
        context.addIssue({
          code: "custom",
          path: ["checkpoint", "terminal"],
          message: "A complete partition requires a terminal checkpoint",
        });
      }
    }
  });

export type ClermontPartitionHandoff = z.infer<typeof clermontPartitionHandoffSchema>;

export const clermontMergedExportMetadataSchema = z
  .object({
    schemaVersion: z.literal(CLERMONT_MERGED_EXPORT_METADATA_SCHEMA_VERSION),
    jobId: runIdSchema,
    exportedAt: z.string().datetime({ offset: true }),
    sourceUrl: z.literal("https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx"),
    permitYears: z.tuple([
      z.literal("15"),
      z.literal("16"),
      z.literal("17"),
      z.literal("18"),
      z.literal("19"),
      z.literal("20"),
      z.literal("21"),
      z.literal("22"),
      z.literal("23"),
      z.literal("24"),
      z.literal("25"),
      z.literal("26"),
    ]),
    enumeratedPermits: z.number().int().nonnegative(),
    deadPermits: z.number().int().nonnegative(),
    achievablePermits: z.number().int().nonnegative(),
    loadedPermits: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.achievablePermits !== metadata.enumeratedPermits - metadata.deadPermits) {
      context.addIssue({
        code: "custom",
        path: ["achievablePermits"],
        message: "Achievable permits must equal enumerated permits minus proven-dead permits",
      });
    }
    if (metadata.loadedPermits !== metadata.achievablePermits) {
      context.addIssue({
        code: "custom",
        path: ["loadedPermits"],
        message: "A certified merged export must load every achievable permit",
      });
    }
  });

export type ClermontMergedExportMetadata = z.infer<typeof clermontMergedExportMetadataSchema>;

export const clermontCertifiedBaselineSchema = z
  .object({
    schemaVersion: z.literal(CLERMONT_BASELINE_SCHEMA_VERSION),
    baselineId: z
      .string()
      .min(8)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    county: z.literal("lake"),
    jurisdiction: z.literal("clermont"),
    sourceSystem: z.literal("lake_clermont_etrakit_permits"),
    requiredHistory: z.object({ firstYear: z.literal(2015), lastYear: z.literal(2026) }).strict(),
    certifiedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    status: z.literal("certified"),
    evidenceSha256: sha256Schema,
    signatures: clermontSignatureSetSchema,
    partitions: z.array(clermontPartitionHandoffSchema).length(12),
    mergedExport: z
      .object({
        artifact: clermontImmutableArtifactSchema,
        metadata: clermontImmutableArtifactSchema,
        rows: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((baseline, context) => {
    const years = baseline.partitions.map(({ year }) => year);
    if (canonicalJson(years) !== canonicalJson(CLERMONT_PERMIT_YEARS)) {
      context.addIssue({
        code: "custom",
        path: ["partitions"],
        message: "Certified baseline must contain ordered partitions for every year 2015-2026",
      });
    }
    if (Date.parse(baseline.expiresAt) <= Date.parse(baseline.certifiedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Baseline expiry must be after certification",
      });
    }
    baseline.partitions.forEach((partition, index) => {
      if (partition.status !== "captured_complete") {
        context.addIssue({
          code: "custom",
          path: ["partitions", index, "status"],
          message: "Every certified partition must be captured_complete",
        });
      }
      if (canonicalJson(partition.signatures) !== canonicalJson(baseline.signatures)) {
        context.addIssue({
          code: "custom",
          path: ["partitions", index, "signatures"],
          message: "Every partition must use the certified baseline signatures",
        });
      }
    });
    if (new Set(baseline.partitions.map(({ runId }) => runId)).size !== 1) {
      context.addIssue({
        code: "custom",
        path: ["partitions"],
        message: "Every certified partition must come from the same fenced acquisition run",
      });
    }
    const completedRows = baseline.partitions.reduce(
      (sum, partition) => sum + partition.counts.completed,
      0,
    );
    if (baseline.mergedExport.rows !== completedRows) {
      context.addIssue({
        code: "custom",
        path: ["mergedExport", "rows"],
        message: "Merged export rows must equal completed rows across every partition",
      });
    }
  });

export type ClermontCertifiedBaseline = z.infer<typeof clermontCertifiedBaselineSchema>;

export const clermontBaselinePointerSchema = z
  .object({
    schemaVersion: z.literal(CLERMONT_BASELINE_POINTER_SCHEMA_VERSION),
    baselineSha256: sha256Schema,
    baselineRelativePath: z.string().regex(/^baselines\/[a-f0-9]{64}\/baseline\.json$/),
    promotedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((pointer, context) => {
    if (!pointer.baselineRelativePath.includes(pointer.baselineSha256)) {
      context.addIssue({
        code: "custom",
        path: ["baselineRelativePath"],
        message: "Baseline pointer path must contain its exact digest",
      });
    }
  });

export type ClermontBaselinePointer = z.infer<typeof clermontBaselinePointerSchema>;

const expectedYearCountSchema = z
  .object({ year: permitYearSchema, expectedRecords: z.number().int().nonnegative() })
  .strict();

export const clermontThroughputBenchmarkSchema = z
  .object({
    measuredAt: z.string().datetime({ offset: true }),
    sampleSize: z.number().int().min(10),
    terminalRecordsPerHour: z.number().positive().finite(),
    p50RequestLatencyMs: z.number().positive().finite(),
    p95RequestLatencyMs: z.number().positive().finite(),
    observedErrorRate: z.number().min(0).max(0.5),
    safeConcurrency: z.number().int().min(1).max(4),
    averageRawBytesPerRecord: z.number().int().nonnegative(),
    expectedByYear: z.array(expectedYearCountSchema).length(12),
  })
  .strict()
  .superRefine((benchmark, context) => {
    const years = benchmark.expectedByYear.map(({ year }) => year);
    if (canonicalJson(years) !== canonicalJson(CLERMONT_PERMIT_YEARS)) {
      context.addIssue({
        code: "custom",
        path: ["expectedByYear"],
        message: "Benchmark must estimate every ordered year from 2015 through 2026",
      });
    }
    if (benchmark.p95RequestLatencyMs < benchmark.p50RequestLatencyMs) {
      context.addIssue({
        code: "custom",
        path: ["p95RequestLatencyMs"],
        message: "p95 latency cannot be below p50 latency",
      });
    }
  });

export const clermontRunRequestSchema = z
  .object({
    schemaVersion: z.literal(CLERMONT_REQUEST_SCHEMA_VERSION),
    runId: runIdSchema,
    county: z.literal("lake"),
    jurisdiction: z.literal("clermont"),
    sourceSystem: z.literal("lake_clermont_etrakit_permits"),
    requestedYears: z.array(permitYearSchema).length(12),
    refreshMode: z.enum(["full", "incremental"]),
    asOfYear: z.literal(2026),
    runtime: clermontRuntimeSchema,
    remoteBaseline: clermontRemoteBaselineSchema,
    signatures: clermontSignatureSetSchema,
    baseline: z
      .object({
        requiredSha256: sha256Schema.nullable(),
        maxAgeHours: z
          .number()
          .positive()
          .max(24 * 31),
      })
      .strict(),
    benchmark: clermontThroughputBenchmarkSchema,
    limits: z
      .object({
        costCeilingUsd: z.number().positive().finite().max(1_000),
        maxAutomaticHours: z.literal(48),
        runnerHourlyUsd: z.number().nonnegative().finite(),
        requestCostPerThousandUsd: z.number().nonnegative().finite(),
        storagePerGbUsd: z.number().nonnegative().finite(),
        maxAttempts: z.number().int().min(1).max(12),
        requestAttemptsPerOperation: z
          .literal(CLERMONT_HARVESTER_REQUEST_ATTEMPTS)
          .default(CLERMONT_HARVESTER_REQUEST_ATTEMPTS),
        maxEnumerationPrefixesPerYear: z
          .literal(CLERMONT_MAX_ENUMERATION_PREFIXES_PER_YEAR)
          .default(CLERMONT_MAX_ENUMERATION_PREFIXES_PER_YEAR),
        enumerationResultCap: z
          .literal(CLERMONT_ENUMERATION_RESULT_CAP)
          .default(CLERMONT_ENUMERATION_RESULT_CAP),
        baseBackoffMs: z.number().int().min(100).max(60_000),
        maxBackoffMs: z
          .number()
          .int()
          .min(1_000)
          .max(24 * 60 * 60 * 1_000),
        circuitBreakerFailures: z.number().int().min(1).max(12),
        leaseDurationMs: z
          .number()
          .int()
          .min(1_000)
          .max(60 * 60 * 1_000),
        heartbeatIntervalMs: z
          .number()
          .int()
          .min(250)
          .max(15 * 60 * 1_000),
      })
      .strict(),
    authorization: clermontCostAuthorizationSchema.nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    if (canonicalJson(request.requestedYears) !== canonicalJson(CLERMONT_PERMIT_YEARS)) {
      context.addIssue({
        code: "custom",
        path: ["requestedYears"],
        message: "A Clermont run must cover every year 2015 through 2026",
      });
    }
    if (request.refreshMode === "incremental" && request.baseline.requiredSha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["baseline", "requiredSha256"],
        message: "Incremental refresh requires an exact certified baseline digest",
      });
    }
    if (request.limits.maxBackoffMs < request.limits.baseBackoffMs) {
      context.addIssue({
        code: "custom",
        path: ["limits", "maxBackoffMs"],
        message: "Maximum backoff cannot be below base backoff",
      });
    }
    if (request.limits.heartbeatIntervalMs * 2 >= request.limits.leaseDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["limits", "heartbeatIntervalMs"],
        message: "Lease duration must exceed two heartbeat intervals",
      });
    }
    if (request.authorization !== null) {
      if (request.authorization.runId !== request.runId) {
        context.addIssue({
          code: "custom",
          path: ["authorization", "runId"],
          message: "Cost authorization must bind the exact run ID",
        });
      }
      if (request.authorization.requestScopeSha256 !== clermontAuthorizationScopeDigest(request)) {
        context.addIssue({
          code: "custom",
          path: ["authorization", "requestScopeSha256"],
          message: "Cost authorization must bind the exact request scope",
        });
      }
    }
  });

export type ClermontRunRequest = z.infer<typeof clermontRunRequestSchema>;

export function clermontAuthorizationScopeDigest(request: ClermontRunRequest): string {
  const { authorization: _authorization, ...scope } = request;
  return sha256Text(canonicalJson(scope));
}

export const clermontRecordEvidenceSchema = z
  .object({
    stableId: stablePermitIdSchema,
    disposition: z.enum(["completed", "proven-dead", "retryable-pending"]),
    linkage: z.enum(["linked", "valid-unlinked"]).nullable(),
    contractorPresent: z.boolean(),
    licensePresent: z.boolean(),
    open: z.boolean(),
    rawSha256: sha256Schema.nullable(),
    extractedSha256: sha256Schema.nullable(),
    statusSha256: sha256Schema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.disposition === "completed") {
      if (record.linkage === null || record.rawSha256 === null || record.extractedSha256 === null) {
        context.addIssue({
          code: "custom",
          message: "Completed records require linkage plus raw and extracted evidence",
        });
      }
    } else if (
      record.linkage !== null ||
      record.contractorPresent ||
      record.licensePresent ||
      record.open ||
      record.extractedSha256 !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Non-completed records cannot claim extracted record facts",
      });
    }
    if (record.disposition === "proven-dead" && record.rawSha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["rawSha256"],
        message: "Proven-dead records require immutable raw source evidence",
      });
    }
    if (record.licensePresent && !record.contractorPresent) {
      context.addIssue({
        code: "custom",
        path: ["licensePresent"],
        message: "A license cannot exist without a contractor",
      });
    }
  });

export type ClermontRecordEvidence = z.infer<typeof clermontRecordEvidenceSchema>;

export function clermontBaselineDigest(baseline: ClermontCertifiedBaseline): string {
  return sha256Text(canonicalJson(clermontCertifiedBaselineSchema.parse(baseline)));
}

export function clermontRequestDigest(request: ClermontRunRequest): string {
  return sha256Text(canonicalJson(clermontRunRequestSchema.parse(request)));
}
