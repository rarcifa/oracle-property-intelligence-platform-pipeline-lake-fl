/**
 * Server configuration, resolved once at boot from the environment with
 * development defaults that point at the locally published run.
 *
 * Nothing here throws for a missing `ANTHROPIC_API_KEY`: the chat route degrades
 * to a 503 with an explanation instead of taking the process down, because the
 * data surfaces must stay usable without a model key.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from either `src/` (tsx) or `dist/` (built). */
export const REPO_ROOT = resolve(here, "../../..");

/** Where the ingestion runtime publishes Lake County artifacts. */
export const DEFAULT_PUBLISH_DIR = resolve(
  REPO_ROOT,
  ".claude/skills/use-oracle/runtime/data/artifacts/publish/lake",
);

export interface ServerConfig {
  port: number;
  host: string;
  /** Parquet the DuckDB layer opens: a local path or an https gateway URL. */
  parquetSource: string;
  parquetSourceKind: "ipfs" | "local";
  /** Directory holding coverage.json / index.json / schema.json for the run. */
  runDir: string | null;
  /** `artifacts/latest.json`, written by the publish step. */
  latestPath: string;
  /** Directory of built UI assets, served at `/`. */
  uiDist: string;
  anthropicApiKey: string | null;
  chatModelId: string;
  /** Max wall-clock milliseconds one chat turn may consume. */
  chatTimeoutMs: number;
}

function firstExisting(...candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate the newest published run directory. Run ids are ISO basic timestamps,
 * so lexicographic order is chronological order.
 */
export function resolveRunDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ORACLE_RUN_DIR;
  if (explicit) return existsSync(explicit) ? resolve(explicit) : null;
  const runsRoot = resolve(DEFAULT_PUBLISH_DIR, "runs");
  if (!existsSync(runsRoot)) return null;
  const runs = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const newest = runs[runs.length - 1];
  return newest ? resolve(runsRoot, newest) : null;
}

/** Build the effective configuration from an environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const runDir = resolveRunDir(env);

  const explicitParquet = env.ORACLE_PARQUET_URL ?? env.ORACLE_PARQUET_PATH;
  // The resolved run directory wins over the publish root, so the Parquet the
  // server opens is always the one the served coverage snapshot describes.
  const localParquet = firstExisting(
    runDir ? resolve(runDir, "query-table.parquet") : "",
    resolve(DEFAULT_PUBLISH_DIR, "query-table.parquet"),
  );

  const parquetSource = explicitParquet ?? localParquet ?? "";
  const parquetSourceKind: "ipfs" | "local" = /^https?:\/\//.test(parquetSource) ? "ipfs" : "local";

  const apiKey = env.ANTHROPIC_API_KEY?.trim();

  return {
    port: Number.parseInt(env.PORT ?? "8787", 10),
    host: env.HOST ?? "0.0.0.0",
    parquetSource,
    parquetSourceKind,
    runDir,
    latestPath: env.ORACLE_LATEST_PATH ?? resolve(REPO_ROOT, "artifacts/latest.json"),
    uiDist: env.ORACLE_UI_DIST ?? resolve(REPO_ROOT, "packages/ui/dist"),
    anthropicApiKey: apiKey && apiKey.length > 0 ? apiKey : null,
    chatModelId: env.ORACLE_CHAT_MODEL ?? "claude-fable-5-1",
    chatTimeoutMs: Number.parseInt(env.ORACLE_CHAT_TIMEOUT_MS ?? "120000", 10),
  };
}
