import { Logger } from "@aws-lambda-powertools/logger";
import { MetricUnit, Metrics } from "@aws-lambda-powertools/metrics";

export const BATCH_WORKER_METRIC_NAMESPACE = "OracleLake";
export const BATCH_PROJECT_NAME = "county-enrichment";
export const BATCH_COST_METRIC_NAME = "CostPredicted";
export const BATCH_WORKER_METRIC_NAMES = Object.freeze({
  processed: "StageProcessed",
  failed: "StageFailed",
  duration: "ProcessingDuration",
});

export const BATCH_WORKERS = Object.freeze({
  sunbiz: "county-enrichment-sunbiz",
  bbb: "county-enrichment-bbb",
  reconciliation: "county-enrichment-reconciliation",
  permit: "county-enrichment-permit",
});

export type BatchWorkerOperation = keyof typeof BATCH_WORKERS;

/** Emit the conservative pre-processing estimate required by the batch cost gate. */
export function emitBatchCostPrediction(
  estimatedUsd: number,
  projectName = process.env.ORACLE_PROJECT_NAME ?? BATCH_PROJECT_NAME,
): void {
  if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) {
    throw new Error("Predicted batch cost must be a non-negative finite USD value");
  }
  const metrics = new Metrics({
    namespace: BATCH_WORKER_METRIC_NAMESPACE,
    serviceName: projectName,
  });
  metrics.addDimension("service", projectName);
  metrics.addMetric(BATCH_COST_METRIC_NAME, MetricUnit.NoUnit, estimatedUsd);
  metrics.publishStoredMetrics();
}

/**
 * One low-cardinality observer per AWS Batch worker invocation.
 *
 * Powertools writes Embedded Metric Format records to stdout, which the
 * existing awslogs driver sends to CloudWatch without granting workers raw
 * CloudWatch API permissions. The service/environment/operation dimensions
 * are the same exact dimensions declared by the CDK dashboard.
 */
export function createBatchWorkerObserver(
  operation: BatchWorkerOperation,
  environment = process.env.ORACLE_METRIC_ENVIRONMENT ?? "production",
): {
  info: (event: string, details?: Record<string, unknown>) => void;
  run: <T>(work: () => Promise<T>) => Promise<T>;
} {
  const configuredOperation = process.env.ORACLE_METRIC_OPERATION;
  if (configuredOperation !== undefined && configuredOperation !== operation) {
    throw new Error(
      `ORACLE_METRIC_OPERATION ${configuredOperation} does not match worker operation ${operation}`,
    );
  }
  const serviceName = BATCH_WORKERS[operation];
  const logger = new Logger({ serviceName });
  const metrics = new Metrics({
    namespace: BATCH_WORKER_METRIC_NAMESPACE,
    serviceName,
  });
  metrics.addDimension("environment", environment);
  metrics.addDimension("operation", operation);

  const info = (event: string, details: Record<string, unknown> = {}): void => {
    logger.info(event, { operation, ...details });
  };

  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    info("worker_started");
    try {
      const result = await work();
      metrics.addMetric(BATCH_WORKER_METRIC_NAMES.processed, MetricUnit.Count, 1);
      info("worker_succeeded");
      return result;
    } catch (error) {
      metrics.addMetric(BATCH_WORKER_METRIC_NAMES.failed, MetricUnit.Count, 1);
      logger.error("worker_failed", {
        operation,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: String(error).slice(0, 512),
      });
      throw error;
    } finally {
      metrics.addMetric(
        BATCH_WORKER_METRIC_NAMES.duration,
        MetricUnit.Milliseconds,
        Math.max(0, performance.now() - started),
      );
      metrics.publishStoredMetrics();
    }
  };

  return { info, run };
}
