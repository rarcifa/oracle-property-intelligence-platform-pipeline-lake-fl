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
import { OracleDataStore } from "./data/duckdb.js";
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
  const secretId = process.env.ORACLE_ANTHROPIC_SECRET_ID;
  if (process.env.ANTHROPIC_API_KEY || !secretId) return;
  try {
    const client = new SecretsManagerClient({});
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (result.SecretString) process.env.ANTHROPIC_API_KEY = result.SecretString.trim();
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
    const store = new OracleDataStore({ source: config.parquetSource });
    await store.init();
    return createApp(createContext(config, store));
  })().catch((error: unknown) => {
    bootstrap = null;
    throw error;
  });
  return bootstrap;
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
export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
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
