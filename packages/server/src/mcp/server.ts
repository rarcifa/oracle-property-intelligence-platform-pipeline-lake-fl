/**
 * Stateless Model Context Protocol server: JSON-RPC 2.0 over a single HTTP POST
 * endpoint at `/mcp`.
 *
 * Stateless means no session id, no SSE stream, and no server-held cursor: every
 * request is self-contained, so the endpoint scales to zero and works behind any
 * plain HTTP host. `initialize`, `tools/list` and `tools/call` are implemented
 * per the specification, notifications get no response, and batches are handled.
 */

import { QUERY_TABLE_COLUMN_COUNT } from "@oracle-lake/shared";
import { callTool, MCP_TOOLS } from "./tools.js";
import type { AppContext } from "../context.js";

/** Protocol revisions this server speaks, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SERVER_INFO = Object.freeze({
  name: "oracle-lake-fl",
  title: "Oracle Property Intelligence — Lake County, FL",
  version: "0.1.0",
});

/** JSON-RPC error codes used here. */
export const JSON_RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function isRequestShape(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string";
}

/** Negotiate a protocol version with the client. */
export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === "string") {
    const supported = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested);
    if (supported) return supported;
  }
  return DEFAULT_PROTOCOL_VERSION;
}

/**
 * Handle one JSON-RPC message.
 *
 * Returns `null` for a notification (a message with no `id`), which the HTTP
 * layer answers with 202 Accepted and an empty body.
 */
export async function handleRpcMessage(
  context: AppContext,
  message: unknown,
): Promise<JsonRpcResponse | null> {
  if (!isRequestShape(message)) {
    return err(null, JSON_RPC.INVALID_REQUEST, "Invalid JSON-RPC 2.0 request");
  }

  const id = message.id ?? null;
  const isNotification = message.id === undefined || message.id === null;
  const params = (message.params ?? {}) as Record<string, unknown>;

  switch (message.method) {
    case "initialize": {
      if (isNotification) return null;
      return ok(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: `Query the published Lake County, Florida property query table (one row per parcel). Call getPropertyQuerySchema first to learn the ${QUERY_TABLE_COLUMN_COUNT} columns, then queryProperties for arbitrary read-only SQL against the view \`properties\`, or the purpose-built tools for aged roofs, open roofing permits and radius search. bbb_rating is a real column that is always null because its source answers HTTP 403. contractor_name is published only for parcels in Clermont, one of the county's fifteen permitting jurisdictions, and is null elsewhere: read the row's enrichment_status to tell a gated null (contractor_gated_403) from an established absence (contractor_absent_on_permit), and never report a contractor count as countywide coverage.`,
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/progress":
      return null;

    case "ping":
      return isNotification ? null : ok(id, {});

    case "tools/list": {
      if (isNotification) return null;
      return ok(id, { tools: MCP_TOOLS });
    }

    case "tools/call": {
      if (isNotification) return null;
      const name = params.name;
      if (typeof name !== "string") {
        return err(id, JSON_RPC.INVALID_PARAMS, "tools/call requires a string `name`");
      }
      if (!MCP_TOOLS.some((tool) => tool.name === name)) {
        return err(id, JSON_RPC.METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      }
      try {
        const result = await callTool(context, name, params.arguments);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result.payload, null, 2) }],
          structuredContent: result.payload,
          isError: result.isError === true,
        });
      } catch (error) {
        return err(
          id,
          JSON_RPC.INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    case "resources/list":
      return isNotification ? null : ok(id, { resources: [] });

    case "prompts/list":
      return isNotification ? null : ok(id, { prompts: [] });

    default:
      if (isNotification) return null;
      return err(id, JSON_RPC.METHOD_NOT_FOUND, `Unknown method: ${message.method}`);
  }
}

/** Handle a single message or a JSON-RPC batch. */
export async function handleRpcPayload(
  context: AppContext,
  payload: unknown,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return err(null, JSON_RPC.INVALID_REQUEST, "Empty JSON-RPC batch");
    }
    const responses = await Promise.all(
      payload.map((message) => handleRpcMessage(context, message)),
    );
    const present = responses.filter((response): response is JsonRpcResponse => response !== null);
    return present.length > 0 ? present : null;
  }
  return handleRpcMessage(context, payload);
}
