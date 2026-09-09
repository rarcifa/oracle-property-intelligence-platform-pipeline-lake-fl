/**
 * Minimal typed fetch helpers for the same-origin REST API.
 *
 * The server's error envelope is `{ error, detail? }` with a non-2xx status, so
 * every failure is turned into a `DataSourceError` carrying the server's own
 * words. Views render that text verbatim instead of inventing a message.
 */

import { DataSourceError } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read the server's `{ error, detail }` envelope out of a failed response. */
async function toError(response: Response): Promise<DataSourceError> {
  let message = `Request failed with HTTP ${response.status}`;
  let detail: string | null = null;
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      if (typeof body.error === "string" && body.error.length > 0) message = body.error;
      if (typeof body.detail === "string" && body.detail.length > 0) detail = body.detail;
    }
  } catch {
    // Body was not JSON; the status-derived message stands.
  }
  return new DataSourceError(message, response.status, detail);
}

/** GET a JSON document, or throw a `DataSourceError`. */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: signal ?? null,
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

/** POST a JSON body and read a JSON document, or throw a `DataSourceError`. */
export async function postJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

/** Turn an unknown thrown value into readable text for an error panel. */
export function errorText(error: unknown): { message: string; detail: string | null } {
  if (error instanceof DataSourceError) return { message: error.message, detail: error.detail };
  if (error instanceof Error) return { message: error.message, detail: null };
  return { message: String(error), detail: null };
}
