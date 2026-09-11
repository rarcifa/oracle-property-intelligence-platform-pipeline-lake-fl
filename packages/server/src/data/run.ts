/**
 * Run metadata: the published coverage snapshot and the `latest.json` pointer.
 *
 * Both are read from disk at request time (not cached at boot) so a re-publish
 * shows up without a restart, and both are optional: a missing `latest.json`
 * means the run has not been published to IPFS yet and the app says so rather
 * than inventing a CID.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LatestRunPointer } from "@oracle-lake/shared";
import type { ServerConfig } from "../config.js";

export interface CoverageSnapshot {
  schemaVersion: string;
  county: string;
  countyName: string;
  stateCode: string;
  countyFips: string;
  runId: string;
  exportedAt: string;
  denominator: { basis: string; source: string; assessedParcelCount: number };
  tables: Record<string, { rows: number; source: string }>;
  signals: Record<string, number>;
  limitations: string[];
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Read the published coverage snapshot for the configured run. */
export async function readCoverage(config: ServerConfig): Promise<CoverageSnapshot | null> {
  if (config.runDir === null) return null;
  return readJson<CoverageSnapshot>(resolve(config.runDir, "coverage.json"));
}

/** Read the published-run pointer, when the run has been published. */
export async function readLatest(config: ServerConfig): Promise<LatestRunPointer | null> {
  return readJson<LatestRunPointer>(config.latestPath);
}

/** Read the published schema descriptor for the run, when present. */
export async function readPublishedSchema(
  config: ServerConfig,
): Promise<{ columnCount: number; columns: { name: string; type: string }[] } | null> {
  if (config.runDir === null) return null;
  return readJson(resolve(config.runDir, "schema.json"));
}

/** Identity of the run currently being served. */
export interface RunIdentity {
  runId: string | null;
  rootCid: string | null;
}

/** Best-effort run identity, preferring the published pointer. */
export async function readRunIdentity(config: ServerConfig): Promise<RunIdentity> {
  if (config.dataRunId !== null) {
    return { runId: config.dataRunId, rootCid: config.dataRootCid };
  }
  // A local Parquet and its sibling coverage snapshot are one candidate. A
  // previously published `latest.json` may describe different bytes and must
  // never donate its run id or root CID to the local table.
  if (config.parquetSourceKind === "local") {
    const coverage = await readCoverage(config);
    if (coverage) return { runId: coverage.runId, rootCid: null };
  }
  const latest = await readLatest(config);
  if (latest) return { runId: latest.runId, rootCid: latest.rootCid };
  const coverage = await readCoverage(config);
  return { runId: coverage?.runId ?? null, rootCid: null };
}

/** One artifact's cross-gateway verification result. */
export interface ArtifactVerification {
  name: string;
  cid: string;
  verified: boolean;
  matchedGateways: string[];
  minimumIndependentGateways: number;
  results: {
    gateway: string;
    ok: boolean;
    status: number | null;
    bytes: number | null;
    sha256: string | null;
    error: string | null;
  }[];
}

/** `artifacts/verification-<runId>.json`. */
export interface VerificationReport {
  runId: string;
  rootCid: string;
  verifications: ArtifactVerification[];
}

/** `artifacts/run-history.json`. */
export interface RunHistory {
  schemaVersion: string;
  runs: Record<string, unknown>[];
}

/** Directory holding the published-run evidence files. */
export function artifactsDir(config: ServerConfig): string {
  return dirname(config.latestPath);
}

/**
 * Read the cross-gateway verification report for a run.
 *
 * This is the evidence that the published CIDs actually resolve to the same
 * bytes from independent gateways, which is what makes "immutably published"
 * checkable rather than claimed.
 */
export async function readVerification(
  config: ServerConfig,
  runId: string | null,
): Promise<VerificationReport | null> {
  if (runId === null) return null;
  return readJson<VerificationReport>(resolve(artifactsDir(config), `verification-${runId}.json`));
}

/** Read the publish history, when present. */
export async function readRunHistory(config: ServerConfig): Promise<RunHistory | null> {
  return readJson<RunHistory>(resolve(artifactsDir(config), "run-history.json"));
}
