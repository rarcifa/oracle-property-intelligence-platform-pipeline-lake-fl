/**
 * AWS Lambda entry point for the hosted runtime.
 *
 * The same router that `index.ts` serves over `node:http` is served here over a
 * Lambda Function URL. Only the transport differs; no route, guard or data path
 * is duplicated, so the hosted runtime cannot drift from the local one.
 *
 * The store is opened once per container and reused across invocations. That
 * matters more than usual here: `OracleDataStore` materialises the whole
 * published table into memory and then locks DuckDB down, so re-opening it per
 * request would both be slow and repeat a fetch of the Parquet by CID.
 *
 * @module lambda
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Logger } from "@aws-lambda-powertools/logger";
import { MetricUnit, Metrics } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { RuntimeDataset } from "./data/source.js";
import { triggerPagerDutyAlert } from "./observability/pagerduty.js";
import type { Router } from "./http/router.js";

/** A Lambda Function URL request, in its v2.0 payload shape. */
interface FunctionUrlEvent {
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
}

interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

/**
 * Powertools Logger, Tracer and Metrics, per the engineering guidelines.
 *
 * This deployment previously had none of the three, which the guidelines rank
 * HIGH, and the gap was not recorded as a deviation either — so a failure in
 * production was invisible unless someone read raw CloudWatch text. The
 * business metrics below are the ones this service is actually judged on:
 * requests served, requests failed, and cold starts, which are expensive here
 * because a cold start materialises the whole published table.
 */
const logger = new Logger({ serviceName: "oracle-lake-runtime" });
const tracer = new Tracer({ serviceName: "oracle-lake-runtime" });
const metrics = new Metrics({ namespace: "OracleLake", serviceName: "runtime" });

let bootstrap: Promise<Router> | null = null;
let dataset: RuntimeDataset | null = null;
let coldStart = true;

/**
 * Open the data store and build the router, once per container.
 *
 * @returns The router, shared across invocations.
 */
/**
 * Resolve the model key from Secrets Manager, once, at cold start.
 *
 * It used to be a CloudFormation dynamic reference, which resolves at deploy
 * time and writes the plaintext into the function's own configuration — readable
 * by anyone in the account holding `lambda:GetFunctionConfiguration`. Fetching it
 * here keeps it out of the configuration entirely; the only thing deployed is
 * the secret's name and an IAM grant to read it.
 *
 * Absence is not an error: without a key the agent returns its documented 503
 * and every other surface is unaffected.
 */
async function resolveModelKey(): Promise<void> {
  const secretId = process.env.ORACLE_OPENAI_SECRET_ID;
  if (process.env.OPENAI_API_KEY || !secretId) return;
  try {
    const client = new SecretsManagerClient({});
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (result.SecretString) process.env.OPENAI_API_KEY = result.SecretString.trim();
  } catch (error) {
    logger.error("model_key_unavailable", { secretId, error: String(error) });
  }
}

async function getRouter(): Promise<Router> {
  // Never cache a failure — see the note in `OracleDataStore.init`. A cold start
  // that loses a race with a rate-limiting gateway must not brick this container
  // for the rest of its life.
  bootstrap ??= (async (): Promise<Router> => {
    await resolveModelKey();
    const config = loadConfig(process.env);
    // The dataset is named by an IPNS pointer, not by a CID in this function's
    // environment, so a scheduled publish reaches the runtime without a deploy.
    // The pointer's last verified value opens the store immediately and the
    // live name is checked behind the first requests, so no caller ever waits
    // on a public gateway and a gateway outage is not a runtime outage.
    const opened = await RuntimeDataset.open(config);
    dataset = opened.dataset;
    const pointer = opened.dataset.pointer;
    logger.info("dataset_opened", {
      resolveMs: opened.resolveMs,
      openMs: opened.openMs,
      pointerOrigin: pointer?.origin ?? "configured",
      rootCid: pointer?.rootCid ?? null,
      runId: pointer?.runId ?? null,
      refreshPending: opened.stale,
    });
    metrics.addMetric("DatasetOpenMs", MetricUnit.Milliseconds, opened.openMs);
    metrics.addMetric("PointerResolveMs", MetricUnit.Milliseconds, opened.resolveMs);
    return createApp(createContext(config, opened.dataset));
  })().catch((error: unknown) => {
    bootstrap = null;
    throw error;
  });
  return bootstrap;
}

/**
 * Bring the published pointer up to date without making a caller wait for it.
 *
 * Started after a response is built, never awaited. Lambda freezes a container
 * between invocations, so this may only finish on a later one — which is fine,
 * because the run it is checking for moves at most daily. Everything is caught:
 * a failed refresh must leave the container serving what it was already
 * serving, not take it down.
 */
function refreshPointerInBackground(): void {
  const current = dataset;
  if (current === null) return;
  void current
    .refresh()
    .then((outcome) => {
      if (outcome.status === "upgraded") {
        logger.info("dataset_upgraded", {
          from: outcome.from,
          to: outcome.pointer.rootCid,
          runId: outcome.pointer.runId,
        });
        metrics.addMetric("DatasetUpgraded", MetricUnit.Count, 1);
      } else if (outcome.status === "failed") {
        // Not paged: the process is still serving a verified published run, so
        // this is degraded freshness, not a failure a human must act on now.
        // The alarm on this metric is what pages, once it persists.
        logger.warn("pointer_refresh_failed", { error: outcome.error.message });
        metrics.addMetric("PointerRefreshFailed", MetricUnit.Count, 1);
      }
    })
    .catch((error: unknown) => {
      logger.warn("pointer_refresh_failed", { error: String(error) });
    });
}

/**
 * Decode a Function URL body into the parsed value the router expects.
 *
 * @param event - The incoming event.
 * @returns Parsed JSON, raw text, or undefined when there is no body.
 */
function decodeBody(event: FunctionUrlEvent): unknown {
  if (event.body === undefined || event.body.length === 0) return undefined;
  const text =
    event.isBase64Encoded === true
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Lambda handler.
 *
 * @param event - Function URL event.
 * @returns The HTTP response, base64-encoded when the body is binary.
 */
export async function bufferedHandler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";
  const segment = tracer.getSegment();
  const started = Date.now();

  if (coldStart) {
    metrics.addMetric("ColdStart", MetricUnit.Count, 1);
    coldStart = false;
  }

  try {
    const router = await getRouter();
    const response = await router.handle({
      method,
      path,
      query: new URLSearchParams(event.rawQueryString ?? ""),
      headers: event.headers ?? {},
      body: decodeBody(event),
    });

    metrics.addMetric("RequestsServed", MetricUnit.Count, 1);
    metrics.addMetric("RequestDuration", MetricUnit.Milliseconds, Date.now() - started);
    // After the response is built, so it costs the caller nothing.
    refreshPointerInBackground();
    if (response.status >= 500) metrics.addMetric("RequestsFailed", MetricUnit.Count, 1);
    logger.info("request", { method, path, status: response.status, ms: Date.now() - started });

    const binary = typeof response.body !== "string";
    return {
      statusCode: response.status,
      headers: response.headers,
      body: binary
        ? Buffer.from(response.body as Uint8Array).toString("base64")
        : (response.body as string),
      isBase64Encoded: binary,
    };
  } catch (error) {
    // A throw here used to escape as a raw platform error. It is the one path
    // where the caller learns nothing and the operator learns nothing either.
    metrics.addMetric("RequestsFailed", MetricUnit.Count, 1);
    tracer.addErrorAsMetadata(error as Error);
    logger.error("request_failed", { method, path, error: String(error) });
    // Terminal for this request, and for every request this container will
    // serve until a bootstrap succeeds: it could not open the published
    // dataset at all. The guidelines forbid leaving that to a log line, so
    // on-call is paged from the point where it becomes terminal. One dedup key
    // per function, so a container retrying every few seconds keeps updating a
    // single incident rather than opening hundreds.
    const paged = await triggerPagerDutyAlert({
      summary: `Lake County runtime cannot open the published dataset: ${String(error)}`,
      source: process.env.AWS_LAMBDA_FUNCTION_NAME ?? "oracle-lake-runtime",
      severity: "critical",
      dedupKey: `oracle-lake-runtime/dataset-unavailable/${process.env.AWS_LAMBDA_FUNCTION_NAME ?? "local"}`,
      customDetails: { method, path, error: String(error) },
    });
    // Whether anybody was actually told is itself evidence, so it is logged
    // rather than assumed.
    logger.error("dataset_unavailable", { paging: paged.status });
    metrics.addMetric("DatasetUnavailable", MetricUnit.Count, 1);
    return {
      statusCode: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        error: "runtime_unavailable",
        detail:
          "The runtime could not open the published dataset for this request. It retries on the next call rather than staying down.",
      }),
      isBase64Encoded: false,
    };
  } finally {
    metrics.publishStoredMetrics();
    segment?.close();
  }
}

/**
 * The Lambda streaming globals, injected by the Node runtime.
 *
 * Declared rather than imported: they exist only inside the managed runtime,
 * which is also why every path below tolerates their absence.
 */
declare const awslambda:
  | {
      streamifyResponse: (
        fn: (event: FunctionUrlEvent, responseStream: NodeJS.WritableStream) => Promise<void>,
      ) => unknown;
      HttpResponseStream: {
        from: (
          stream: NodeJS.WritableStream,
          metadata: { statusCode: number; headers: Record<string, string> },
        ) => NodeJS.WritableStream;
      };
    }
  | undefined;

/**
 * The deployed entry point.
 *
 * The Function URL runs in RESPONSE_STREAM invoke mode, because BUFFERED mode
 * caps a request at 60 s however long this function may run — and the agent
 * loop legitimately takes longer than that. Nothing here streams token by
 * token yet: the full response is written in one chunk. The reason to be in
 * streaming mode is the transport limit, which rises from 60 s to 15 minutes,
 * not incremental delivery. Token streaming can be layered on later without
 * another invoke-mode change.
 *
 * Falls back to the buffered handler when the streaming globals are absent, so
 * the module still loads under test and outside the managed runtime.
 */
export const handler =
  typeof awslambda === "undefined"
    ? bufferedHandler
    : awslambda.streamifyResponse(async (event, responseStream) => {
        const result = await bufferedHandler(event);
        const stream = awslambda!.HttpResponseStream.from(responseStream, {
          statusCode: result.statusCode,
          headers: result.headers,
        });
        stream.write(result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body);
        stream.end();
      });
