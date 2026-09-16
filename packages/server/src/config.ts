/**
 * Server configuration, resolved once at boot from the environment with
 * development defaults that point at the locally published run.
 *
 * Nothing here throws for a missing `OPENAI_API_KEY`: the chat route degrades
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
export const DEFAULT_PUBLISH_DIR = resolve(REPO_ROOT, "pipeline/data/artifacts/publish/lake");

export interface ServerConfig {
  port: number;
  host: string;
  /** Parquet the DuckDB layer opens: a local path or an https gateway URL. */
  parquetSource: string;
  parquetSourceKind: "ipfs" | "local";
  /** Explicit read-only, loopback-only unaccepted evidence preview. Never deployment. */
  localEvidencePreview?: boolean;
  permitSource?: string;
  localEvidenceAsOfYear?: number;
  /**
   * IPNS name the published dataset lives behind, when one is configured.
   *
   * Used only when no explicit Parquet and no locally published run is present,
   * which is the deployed case. The name is stable across runs; the CID it
   * points at is not, which is exactly why the runtime resolves the name rather
   * than being handed a CID at deploy time.
   */
  ipnsName: string | null;
  /** Directory holding coverage.json / index.json / schema.json for the run. */
  runDir: string | null;
  /** `artifacts/latest.json`, written by the publish step. */
  latestPath: string;
  /** Exact run identity for an explicitly materialized/downloaded table. */
  dataRunId: string | null;
  /** Exact public root when a gateway artifact was materialized to a local path. */
  dataRootCid: string | null;
  /** Directory of built UI assets, served at `/`. */
  uiDist: string;
  openaiApiKey: string | null;
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
  if (
    env.ORACLE_LOCAL_EVIDENCE_PREVIEW !== undefined &&
    env.ORACLE_LOCAL_EVIDENCE_PREVIEW !== "1" &&
    env.ORACLE_LOCAL_EVIDENCE_PREVIEW !== "0"
  ) {
    throw new Error("ORACLE_LOCAL_EVIDENCE_PREVIEW must be exactly 1 or 0");
  }
  const localEvidencePreview = env.ORACLE_LOCAL_EVIDENCE_PREVIEW === "1";
  if (localEvidencePreview) {
    if (
      env.AWS_LAMBDA_FUNCTION_NAME ||
      env.AWS_EXECUTION_ENV ||
      env.LAMBDA_TASK_ROOT ||
      (env.HOST !== undefined && !["127.0.0.1", "localhost", "::1"].includes(env.HOST))
    ) {
      throw new Error("Local evidence preview is loopback-only and cannot run in Lambda");
    }
    if (env.ORACLE_PARQUET_URL || env.ORACLE_IPNS_NAME || env.ORACLE_DATA_ROOT_CID) {
      throw new Error(
        "Local evidence preview cannot use a public URL, IPNS name or publication CID",
      );
    }
    for (const value of [env.ORACLE_PARQUET_PATH, env.ORACLE_PERMIT_PARQUET_PATH]) {
      if (!value || !isLocalParquetPath(value)) {
        throw new Error(
          "Local evidence preview requires explicit local property and permit Parquet paths",
        );
      }
    }
    if (!env.ORACLE_DATA_RUN_ID || !/^[A-Za-z0-9._-]{1,120}$/.test(env.ORACLE_DATA_RUN_ID)) {
      throw new Error("Local evidence preview requires an explicit local run ID");
    }
    if (
      !env.ORACLE_LOCAL_EVIDENCE_AS_OF_YEAR ||
      !/^(?:17|18|19|20|21)\d{2}$/.test(env.ORACLE_LOCAL_EVIDENCE_AS_OF_YEAR)
    ) {
      throw new Error(
        "Local evidence preview requires the existing derivative's explicit as-of year",
      );
    }
  }
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

  // Precedence: an explicit override, then a run published on this machine,
  // then the IPNS pointer. A developer who has just published locally wants
  // that run; a deployed process has neither of the first two and follows the
  // pointer. There is no baked CID anywhere in the chain.
  const ipnsName = env.ORACLE_IPNS_NAME?.trim();

  const apiKey = env.OPENAI_API_KEY?.trim();

  return {
    port: Number.parseInt(env.PORT ?? "8787", 10),
    host: env.HOST ?? "0.0.0.0",
    parquetSource,
    parquetSourceKind,
    ipnsName: ipnsName && ipnsName.length > 0 ? ipnsName : null,
    runDir,
    latestPath: env.ORACLE_LATEST_PATH ?? resolve(REPO_ROOT, "artifacts/latest.json"),
    dataRunId: env.ORACLE_DATA_RUN_ID?.trim() || null,
    dataRootCid: env.ORACLE_DATA_ROOT_CID?.trim() || null,
    uiDist: env.ORACLE_UI_DIST ?? resolve(REPO_ROOT, "packages/ui/dist"),
    openaiApiKey: apiKey && apiKey.length > 0 ? apiKey : null,
    chatModelId: env.ORACLE_CHAT_MODEL ?? "gpt-5-mini",
    // Must fire before the request is killed from outside, so the caller gets
    // this agent's own message rather than a dropped connection.
    //
    // The Function URL runs in RESPONSE_STREAM invoke mode, so the transport
    // no longer caps a request at the 60 s that BUFFERED mode imposed, and the
    // function timeout is once again the real bound.
    //
    // This budget has moved three times, twice wrongly. 120 s against a 60 s
    // Lambda could never fire; 45 s was below what the work costs and aborted
    // healthy requests; 120 s against a 150 s Lambda missed that the Function
    // URL, not the Lambda, is what kills the request. 50 s is under the real
    // wall with margin. Raising it past 60 s requires RESPONSE_STREAM invoke
    // mode first — the limit is the transport, not this number.
    chatTimeoutMs: Number.parseInt(env.ORACLE_CHAT_TIMEOUT_MS ?? "120000", 10),
    ...(localEvidencePreview
      ? {
          localEvidencePreview: true,
          host: env.HOST ?? "127.0.0.1",
          permitSource: env.ORACLE_PERMIT_PARQUET_PATH,
          localEvidenceAsOfYear: Number(env.ORACLE_LOCAL_EVIDENCE_AS_OF_YEAR),
          runDir: null,
          ipnsName: null,
          dataRootCid: null,
          openaiApiKey: null,
        }
      : {}),
  };
}

/** No URL schemes, UNC paths or glob replacement scans in a private preview. */
export function isLocalParquetPath(source: string): boolean {
  return (
    source === source.trim() &&
    source.length > 0 &&
    !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(source) &&
    !/[\0*?[\]{}]/.test(source) &&
    /\.parquet$/i.test(source)
  );
}
