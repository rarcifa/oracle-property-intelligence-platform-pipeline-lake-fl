#!/usr/bin/env node
/**
 * Regenerate the repository's MCP environment maps from the kit's published
 * county catalog.
 *
 * `syncMcpJson` resolves the repository-root `.mcp.json` directly. This wrapper
 * remains as the Lake-specific operator command and passes that path explicitly,
 * so invocation is independent of the working directory.
 *
 * Usage: node scripts/lake/sync-mcp-json.mjs
 *
 * @module scripts/lake/sync-mcp-json
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncMcpJson } from "../catalog/sync-mcp-json.mjs";

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(RUNTIME_ROOT, "..");
const MCP_JSON_PATH = path.join(REPO_ROOT, ".mcp.json");

const result = await syncMcpJson({ mcpJsonPath: MCP_JSON_PATH });
process.stdout.write(
  `${JSON.stringify(
    {
      event: "mcp_json_synced",
      mcpJsonPath: result.mcpJsonPath,
      counties: Object.keys(result.maps.PROPERTY_QUERY_TABLE_MAP ?? {}).length,
    },
    null,
    2,
  )}\n`,
);
