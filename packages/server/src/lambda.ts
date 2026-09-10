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

let bootstrap: Promise<Router> | null = null;

/**
 * Open the data store and build the router, once per container.
 *
 * @returns The router, shared across invocations.
 */
async function getRouter(): Promise<Router> {
  bootstrap ??= (async (): Promise<Router> => {
    const config = loadConfig(process.env);
    const store = new OracleDataStore({ source: config.parquetSource });
    await store.init();
    return createApp(createContext(config, store));
  })();
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
  const router = await getRouter();
  const response = await router.handle({
    method: event.requestContext?.http?.method ?? "GET",
    path: event.rawPath ?? "/",
    query: new URLSearchParams(event.rawQueryString ?? ""),
    headers: event.headers ?? {},
    body: decodeBody(event),
  });

  const binary = typeof response.body !== "string";
  return {
    statusCode: response.status,
    headers: response.headers,
    body: binary
      ? Buffer.from(response.body as Uint8Array).toString("base64")
      : (response.body as string),
    isBase64Encoded: binary,
  };
}
