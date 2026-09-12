import { z } from "zod";

import {
  CLERMONT_PERMIT_YEARS,
  CLERMONT_HARVESTER_REQUEST_ATTEMPTS,
  CLERMONT_MAX_ENUMERATION_PREFIXES_PER_YEAR,
  CLERMONT_ENUMERATION_RESULT_CAP,
  clermontBaselinePointerSchema,
  clermontRemoteBaselineSchema,
  clermontRequestDigest,
  clermontRunRequestSchema,
  clermontRuntimeSchema,
  clermontSignatureSetSchema,
  clermontThroughputBenchmarkSchema,
  clermontCostAuthorizationSchema,
} from "./clermont-contracts.js";
import { canonicalJson, sha256Text } from "./contracts.js";

export const CLERMONT_PREPARE_TEMPLATE_SCHEMA_VERSION =
  "elephant.clermont-permit-prepare-template.v1";
export const CLERMONT_PREPARED_RUN_SCHEMA_VERSION = "elephant.clermont-permit-prepared-run.v1";
export const CLERMONT_CONSUMPTION_REQUEST_SCHEMA_VERSION =
  "elephant.clermont-permit-consumption-request.v1";

export const CLERMONT_SOURCE_SCOPE_FILES = Object.freeze([
  "pipeline/data/seeds/lake.csv",
  "pipeline/docs/lake-sources.yaml",
  "pipeline/scripts/lake/clermont-permits.mjs",
  "pipeline/src/counties/lake/clermont-permits.mjs",
  "pipeline/src/counties/lake/etrakit-adapter.mjs",
  "pipeline/src/counties/lake/permit-routing.mjs",
  "pipeline/src/counties/lake/sources.mjs",
  "pipeline/src/permits/contracts.mjs",
  "pipeline/src/permits/errors.mjs",
  "pipeline/src/permits/normalization.mjs",
] as const);

export const CLERMONT_CONFIGURATION_SCOPE_FILES = Object.freeze([
  "pipeline/Dockerfile.batch",
  "pipeline/bin/clermont-ingestion.ts",
  "pipeline/package-lock.json",
  "pipeline/package.json",
  "pipeline/src/batch/clermont-baseline-store.ts",
  "pipeline/src/batch/clermont-certifier.ts",
  "pipeline/src/batch/clermont-consumption.ts",
  "pipeline/src/batch/clermont-coordinator.ts",
  "pipeline/src/batch/clermont-executor.ts",
  "pipeline/src/batch/clermont-preparation.ts",
  "pipeline/src/batch/clermont-run-store.ts",
  "pipeline/src/batch/clermont-s3-baseline-store.ts",
  "pipeline/src/batch/clermont-status.ts",
  "pipeline/src/batch/contracts.ts",
  "pipeline/tsconfig.batch.json",
] as const);

export const CLERMONT_SCHEMA_SCOPE_FILES = Object.freeze([
  "pipeline/scripts/lake/build-query-table.sql",
  "pipeline/src/batch/clermont-contracts.ts",
  "pipeline/src/batch/clermont-run-contracts.ts",
  "pipeline/src/counties/lake/query-table.mjs",
] as const);

export const CLERMONT_EXECUTOR_SCOPE_PATH = "input/clermont-executor.json";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const runIdSchema = z
  .string()
  .min(8)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const relativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) => !value.startsWith("/") && !value.split("/").some((segment) => segment === ".."),
    "Path must be relative and cannot contain parent traversal",
  );

export const clermontPrepareTemplateSchema = z
  .object({
    schemaVersion: z.literal(CLERMONT_PREPARE_TEMPLATE_SCHEMA_VERSION),
    runId: runIdSchema,
    refreshMode: z.enum(["full", "incremental"]),
    runtime: clermontRuntimeSchema,
    remoteBaseline: clermontRemoteBaselineSchema,
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
    executor: z
      .object({
        concurrency: z.literal(2),
        delayMs: z.number().int().min(0).max(60_000),
        partitionTimeoutMs: z
          .number()
          .int()
          .min(60_000)
          .max(24 * 60 * 60 * 1_000),
      })
      .strict(),
    authorization: clermontCostAuthorizationSchema.nullable(),
  })
  .strict()
  .superRefine((template, context) => {
    if (template.refreshMode === "incremental" && template.baseline.requiredSha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["baseline", "requiredSha256"],
        message: "Incremental preparation requires an exact certified baseline digest",
      });
    }
    if (template.limits.maxBackoffMs < template.limits.baseBackoffMs) {
      context.addIssue({
        code: "custom",
        path: ["limits", "maxBackoffMs"],
        message: "Maximum backoff cannot be below base backoff",
      });
    }
    if (template.limits.heartbeatIntervalMs * 2 >= template.limits.leaseDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["limits", "heartbeatIntervalMs"],
        message: "Lease duration must exceed two heartbeat intervals",
      });
    }
    if (template.executor.concurrency > template.benchmark.safeConcurrency) {
      context.addIssue({
        code: "custom",
        path: ["executor", "concurrency"],
        message: "Executor concurrency cannot exceed the measured safe concurrency",
      });
    }
    if (template.authorization !== null && template.authorization.runId !== template.runId) {
      context.addIssue({
        code: "custom",
        path: ["authorization", "runId"],
        message: "Cost authorization must bind the exact template run ID",
      });
    }
  });

export type ClermontPrepareTemplate = z.infer<typeof clermontPrepareTemplateSchema>;

export const clermontScopeEntrySchema = z
  .object({
    logicalPath: relativePathSchema,
    sha256: sha256Schema,
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const clermontScopeSchema = z
  .object({
    aggregateSha256: sha256Schema,
    entries: z.array(clermontScopeEntrySchema).min(1),
  })
  .strict()
  .superRefine((scope, context) => {
    const paths = scope.entries.map(({ logicalPath }) => logicalPath);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Scope paths must be unique",
      });
    }
    if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Scope paths must be sorted",
      });
    }
    if (scope.aggregateSha256 !== sha256Text(canonicalJson(scope.entries))) {
      context.addIssue({
        code: "custom",
        path: ["aggregateSha256"],
        message: "Scope aggregate must bind the exact canonical entries",
      });
    }
  });

export const clermontPreparedRunSchema = z
  .object({
    schemaVersion: z.literal(CLERMONT_PREPARED_RUN_SCHEMA_VERSION),
    preparedAt: z.string().datetime({ offset: true }),
    requestSha256: sha256Schema,
    provenanceSha256: sha256Schema,
    template: clermontPrepareTemplateSchema,
    request: clermontRunRequestSchema,
    executor: clermontPrepareTemplateSchema.shape.executor,
    scopes: z
      .object({
        source: clermontScopeSchema,
        configuration: clermontScopeSchema,
        schema: clermontScopeSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((prepared, context) => {
    if (canonicalJson(prepared.executor) !== canonicalJson(prepared.template.executor)) {
      context.addIssue({
        code: "custom",
        path: ["executor"],
        message: "Prepared executor policy must equal the exact template executor policy",
      });
    }
    const templateRequestProjection = {
      runId: prepared.template.runId,
      refreshMode: prepared.template.refreshMode,
      runtime: prepared.template.runtime,
      remoteBaseline: prepared.template.remoteBaseline,
      baseline: prepared.template.baseline,
      benchmark: prepared.template.benchmark,
      limits: prepared.template.limits,
      authorization: prepared.template.authorization,
    };
    const preparedRequestProjection = {
      runId: prepared.request.runId,
      refreshMode: prepared.request.refreshMode,
      runtime: prepared.request.runtime,
      remoteBaseline: prepared.request.remoteBaseline,
      baseline: prepared.request.baseline,
      benchmark: prepared.request.benchmark,
      limits: prepared.request.limits,
      authorization: prepared.request.authorization,
    };
    if (canonicalJson(templateRequestProjection) !== canonicalJson(preparedRequestProjection)) {
      context.addIssue({
        code: "custom",
        path: ["request"],
        message: "Prepared request must equal every request-bearing template field",
      });
    }
    if (
      prepared.scopes.configuration.entries.filter(
        ({ logicalPath }) => logicalPath === CLERMONT_EXECUTOR_SCOPE_PATH,
      ).length !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["scopes", "configuration", "entries"],
        message: "Configuration scope must bind exactly one Clermont executor policy",
      });
    }
    const exactScopePaths = {
      source: [...CLERMONT_SOURCE_SCOPE_FILES],
      configuration: [...CLERMONT_CONFIGURATION_SCOPE_FILES, CLERMONT_EXECUTOR_SCOPE_PATH].sort(),
      schema: [...CLERMONT_SCHEMA_SCOPE_FILES],
    };
    for (const [scopeName, expectedPaths] of Object.entries(exactScopePaths)) {
      const actualPaths = prepared.scopes[scopeName as keyof typeof prepared.scopes].entries.map(
        ({ logicalPath }) => logicalPath,
      );
      if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
        context.addIssue({
          code: "custom",
          path: ["scopes", scopeName, "entries"],
          message: `Prepared ${scopeName} scope must contain the exact canonical path set`,
        });
      }
    }
    const expected = {
      sourceSha256: prepared.scopes.source.aggregateSha256,
      configurationSha256: prepared.scopes.configuration.aggregateSha256,
      schemaSha256: prepared.scopes.schema.aggregateSha256,
    };
    if (canonicalJson(prepared.request.signatures) !== canonicalJson(expected)) {
      context.addIssue({
        code: "custom",
        path: ["request", "signatures"],
        message: "Run signatures must bind the exact prepared scopes",
      });
    }
    if (prepared.requestSha256 !== clermontRequestDigest(prepared.request)) {
      context.addIssue({
        code: "custom",
        path: ["requestSha256"],
        message: "Prepared request digest must match the canonical request",
      });
    }
    const expectedProvenanceSha256 = sha256Text(
      canonicalJson({
        source: prepared.scopes.source,
        configuration: prepared.scopes.configuration,
        schema: prepared.scopes.schema,
        baseline: prepared.request.baseline.requiredSha256,
      }),
    );
    if (prepared.provenanceSha256 !== expectedProvenanceSha256) {
      context.addIssue({
        code: "custom",
        path: ["provenanceSha256"],
        message: "Prepared provenance digest must match the canonical scopes and baseline",
      });
    }
    if (
      prepared.request.authorization !== null &&
      prepared.request.authorization.provenanceSha256 !== prepared.provenanceSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["request", "authorization", "provenanceSha256"],
        message: "Cost authorization must bind the exact prepared provenance",
      });
    }
  });

export type ClermontPreparedRun = z.infer<typeof clermontPreparedRunSchema>;

export const clermontConsumptionRequestSchema = z
  .object({
    schemaVersion: z.literal(CLERMONT_CONSUMPTION_REQUEST_SCHEMA_VERSION),
    consumer: z.literal("lake-consolidation"),
    county: z.literal("lake"),
    jurisdiction: z.literal("clermont"),
    sourceSystem: z.literal("lake_clermont_etrakit_permits"),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    baselineSha256: sha256Schema,
    exportSha256: sha256Schema,
    metadataSha256: sha256Schema,
    signatures: clermontSignatureSetSchema,
    outputRelativePath: relativePathSchema.refine(
      (value) => value.endsWith(".csv"),
      "Consumption output must be a CSV",
    ),
    requestedYears: z.tuple([
      z.literal(2015),
      z.literal(2016),
      z.literal(2017),
      z.literal(2018),
      z.literal(2019),
      z.literal(2020),
      z.literal(2021),
      z.literal(2022),
      z.literal(2023),
      z.literal(2024),
      z.literal(2025),
      z.literal(2026),
    ]),
  })
  .strict()
  .superRefine((request, context) => {
    if (Date.parse(request.expiresAt) <= Date.parse(request.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Consumption request must expire after it is created",
      });
    }
    if (request.requestedYears.join(",") !== CLERMONT_PERMIT_YEARS.join(",")) {
      context.addIssue({
        code: "custom",
        path: ["requestedYears"],
        message: "Consumption must bind the complete 2015-2026 boundary",
      });
    }
  });

export type ClermontConsumptionRequest = z.infer<typeof clermontConsumptionRequestSchema>;

export const clermontLocalPromotionReceiptSchema = z
  .object({
    runId: runIdSchema,
    promotedAt: z.string().datetime({ offset: true }),
    pointer: clermontBaselinePointerSchema,
    consumptionRequestPath: z.literal("promotion/consumption-request.json"),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.promotedAt !== receipt.pointer.promotedAt) {
      context.addIssue({
        code: "custom",
        path: ["promotedAt"],
        message: "Local promotion receipt time must equal its pointer time",
      });
    }
  });

export type ClermontLocalPromotionReceipt = z.infer<typeof clermontLocalPromotionReceiptSchema>;
