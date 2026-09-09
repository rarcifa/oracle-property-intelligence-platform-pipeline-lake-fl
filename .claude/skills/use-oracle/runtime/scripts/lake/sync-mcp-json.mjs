#!/usr/bin/env node
/**
 * Regenerate the repository's MCP environment maps from the kit's published
 * county catalog.
 *
 * The kit's own `catalog:sync-mcp-json` defaults to `<repo>/.claude/mcp.json`.
 * This repository keeps its MCP configuration at `.mcp.json` in the root, which
 * is where Claude Code reads it from, so the kit script fails with
 * "repo-root mcp.json not found". The same layout assumption is why
 * `tests/catalog/mcp-json-parity.test.mjs` fails here.
 *
 * `syncMcpJson` accepts an explicit `mcpJsonPath`, so this passes the real one
 * rather than editing a vendored kit script. The kit stays byte-identical to
 * upstream and `.claude/KIT_VERSION` keeps matching.
 *
 * Usage: node scripts/lake/sync-mcp-json.mjs
 *
 * @module scripts/lake/sync-mcp-json
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncMcpJson } from "../catalog/sync-mcp-json.mjs";

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(RUNTIME_ROOT, "..", "..", "..", "..");
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
