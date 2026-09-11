import { z } from "zod";

import {
  CLERMONT_PERMIT_YEARS,
  clermontRunRequestSchema,
  clermontSignatureSetSchema,
  clermontThroughputBenchmarkSchema,
} from "./clermont-contracts.js";

export const CLERMONT_PREPARE_TEMPLATE_SCHEMA_VERSION =
  "elephant.clermont-permit-prepare-template.v1";
export const CLERMONT_PREPARED_RUN_SCHEMA_VERSION = "elephant.clermont-permit-prepared-run.v1";
export const CLERMONT_CONSUMPTION_REQUEST_SCHEMA_VERSION =
  "elephant.clermont-permit-consumption-request.v1";

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
        concurrency: z.number().int().min(1).max(4),
        delayMs: z.number().int().min(0).max(60_000),
        partitionTimeoutMs: z
          .number()
          .int()
          .min(60_000)
          .max(24 * 60 * 60 * 1_000),
      })
      .strict(),
    authorization: z
      .object({
        estimateSha256: sha256Schema,
        approvedBy: z.string().min(1).max(200),
        approvedAt: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .nullable(),
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
  .strict();

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
    const expected = {
      sourceSha256: prepared.scopes.source.aggregateSha256,
      configurationSha256: prepared.scopes.configuration.aggregateSha256,
      schemaSha256: prepared.scopes.schema.aggregateSha256,
    };
    if (JSON.stringify(prepared.request.signatures) !== JSON.stringify(expected)) {
      context.addIssue({
        code: "custom",
        path: ["request", "signatures"],
        message: "Run signatures must bind the exact prepared scopes",
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
