/**
 * Shared test harness.
 *
 * Tests run against the real published Parquet when it is present, because a
 * query layer tested only against a fixture proves nothing about the 215k-row
 * table the app actually serves. When it is absent the suites skip loudly
 * rather than passing vacuously.
 */

import { existsSync } from "node:fs";
import { createApp } from "../src/app.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { createContext, type AppContext } from "../src/context.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import type { HttpResponse, Router } from "../src/http/router.js";

export const config: ServerConfig = loadConfig({
  ...process.env,
  // The test suite never reaches a model provider.
  OPENAI_API_KEY: "",
});

/** True when a published Parquet is available to test against. */
export const hasParquet =
  config.parquetSource.length > 0 &&
  (config.parquetSourceKind === "ipfs" || existsSync(config.parquetSource));

let store: OracleDataStore | null = null;

/** Open (once) the shared data store. */
export async function getStore(): Promise<OracleDataStore> {
  if (store === null) {
    store = new OracleDataStore({ source: config.parquetSource });
    await store.init();
  }
  return store;
}

/** Build an app context over the shared store. */
export async function getContext(overrides: Partial<ServerConfig> = {}): Promise<AppContext> {
  return createContext({ ...config, ...overrides }, await getStore());
}

/** Build the wired router. */
export async function getRouter(overrides: Partial<ServerConfig> = {}): Promise<Router> {
  return createApp(await getContext(overrides));
}

/** Issue a request against a router without opening a socket. */
export async function request(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  const url = new URL(path, "http://test.local");
  return router.handle({
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: { "content-type": "application/json" },
    body,
  });
}

/** Parse a JSON response body. */
export function bodyJson<T>(response: HttpResponse): T {
  return JSON.parse(
    typeof response.body === "string" ? response.body : Buffer.from(response.body).toString("utf8"),
  ) as T;
}

/** Release the shared store. */
export function closeStore(): void {
  store?.close();
  store = null;
}
