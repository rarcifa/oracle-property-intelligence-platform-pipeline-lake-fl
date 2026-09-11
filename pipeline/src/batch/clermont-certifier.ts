import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { canonicalJson, sha256Text } from "./contracts.js";
import {
  CLERMONT_BASELINE_SCHEMA_VERSION,
  CLERMONT_MERGED_EXPORT_METADATA_SCHEMA_VERSION,
  CLERMONT_PERMIT_YEARS,
  clermontCertifiedBaselineSchema,
  clermontMergedExportMetadataSchema,
  clermontPartitionHandoffSchema,
  clermontRecordEvidenceSchema,
  type ClermontCertifiedBaseline,
  type ClermontImmutableArtifact,
  type ClermontPartitionHandoff,
} from "./clermont-contracts.js";
import {
  assertPartitionCanComplete,
  completeClermontStage,
  reconcileClermontPartitionRecords,
  startClermontStage,
} from "./clermont-coordinator.js";
import { countEvidenceLines, readEvidenceLines } from "./clermont-executor.js";
import { verifyClermontPreparedScopes } from "./clermont-preparation.js";
import {
  clermontRunDirectory,
  loadClermontCoordinator,
  loadClermontPreparedRun,
  writeClermontRunArtifact,
  updateClermontCoordinator,
} from "./clermont-run-store.js";

interface ClermontPermitProjectionModule {
  CLERMONT_PERMIT_LOAD_COLUMNS: readonly string[];
  clermontPermitLoadRow: (
    record: Record<string, unknown>,
    options: { nowMs: number },
  ) => Record<string, unknown>;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function artifact(root: string, filePath: string): Promise<ClermontImmutableArtifact> {
  const fileStat = await stat(filePath);
  return {
    logicalPath: path.relative(root, filePath).split(path.sep).join("/"),
    sha256: await sha256File(filePath),
    bytes: fileStat.size,
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function loadHandoffs(options: {
  candidateRoot: string;
  runId: string;
}): Promise<ClermontPartitionHandoff[]> {
  const handoffs: ClermontPartitionHandoff[] = [];
  for (const year of CLERMONT_PERMIT_YEARS) {
    let handoff: ClermontPartitionHandoff;
    try {
      handoff = clermontPartitionHandoffSchema.parse(
        JSON.parse(
          await readFile(
            path.join(options.candidateRoot, "partitions", String(year), "handoff.json"),
            "utf8",
          ),
        ),
      );
    } catch (error) {
      throw new Error(
        `Year ${year} has no valid typed handoff: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (handoff.runId !== options.runId) throw new Error(`Year ${year} belongs to another run`);
    assertPartitionCanComplete({
      counts: handoff.counts,
      cappedOrTruncated: handoff.cappedOrTruncated,
    });
    if (handoff.status !== "captured_complete" || !handoff.checkpoint.terminal) {
      throw new Error(`Year ${year} is not terminal and cannot be certified`);
    }
    const evidence = (await readEvidenceLines(options.candidateRoot, handoff.artifacts.status)).map(
      (value) => clermontRecordEvidenceSchema.parse(value),
    );
    const reconciled = reconcileClermontPartitionRecords(evidence);
    if (
      canonicalJson(reconciled.counts) !== canonicalJson(handoff.counts) ||
      reconciled.stableIdsSha256 !== handoff.stableIdsSha256 ||
      canonicalJson(reconciled.openPermitStableIds) !== canonicalJson(handoff.openPermitStableIds)
    ) {
      throw new Error(`Year ${year} status evidence does not reconcile to its handoff`);
    }
    const rawCount = await countEvidenceLines(options.candidateRoot, handoff.artifacts.raw);
    const extractedCount = await countEvidenceLines(
      options.candidateRoot,
      handoff.artifacts.extracted,
    );
    if (rawCount !== handoff.counts.rawEvidence || extractedCount !== handoff.counts.completed) {
      throw new Error(`Year ${year} raw/extracted evidence counts do not reconcile`);
    }
    handoffs.push(handoff);
  }
  return handoffs;
}

export async function certifyClermontRun(options: {
  repoRoot: string;
  runStore: string;
  runId: string;
  now: string;
}): Promise<{
  baseline: ClermontCertifiedBaseline;
  candidateRoot: string;
  baselinePath: string;
}> {
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) throw new Error("now must be ISO-8601");
  const prepared = await loadClermontPreparedRun(options.runStore, options.runId);
  await verifyClermontPreparedScopes({ repoRoot: options.repoRoot, prepared });
  let coordinator = await loadClermontCoordinator(options.runStore, options.runId);
  if (coordinator.stages.certification.status !== "running") {
    coordinator = await updateClermontCoordinator({
      storeRoot: options.runStore,
      runId: options.runId,
      expectedRevision: coordinator.revision,
      update: (state) => startClermontStage(state, "certification", options.now),
    });
  }
  const candidateRoot = path.join(
    clermontRunDirectory(options.runStore, options.runId),
    "candidate",
  );
  const handoffs = await loadHandoffs({ candidateRoot, runId: options.runId });
  if (
    handoffs.some(
      (handoff) => canonicalJson(handoff.signatures) !== canonicalJson(prepared.request.signatures),
    )
  ) {
    throw new Error("Partition signatures do not match the prepared provenance");
  }

  const projectionUrl = new URL("../counties/lake/clermont-permits.mjs", import.meta.url).href;
  const projection = (await import(projectionUrl)) as ClermontPermitProjectionModule;
  const columns = [...projection.CLERMONT_PERMIT_LOAD_COLUMNS];
  if (columns.length === 0 || new Set(columns).size !== columns.length) {
    throw new Error("Clermont load projection has an invalid column contract");
  }
  const projected: Array<{ permitNumber: string; row: Record<string, unknown> }> = [];
  for (const handoff of handoffs) {
    const entries = await readEvidenceLines(candidateRoot, handoff.artifacts.extracted);
    for (const value of entries) {
      if (typeof value !== "object" || value === null)
        throw new Error("Invalid extracted bundle row");
      const wrapper = value as Record<string, unknown>;
      if (typeof wrapper.body !== "string" || typeof wrapper.sha256 !== "string") {
        throw new Error("Extracted evidence wrapper is incomplete");
      }
      if (sha256Text(wrapper.body) !== wrapper.sha256) {
        throw new Error("Extracted evidence wrapper digest mismatch");
      }
      const record = JSON.parse(wrapper.body) as Record<string, unknown>;
      const row = projection.clermontPermitLoadRow(record, { nowMs });
      const permitNumber = String(row.permit_number ?? "");
      if (permitNumber === "") throw new Error("Projected Clermont row has no permit number");
      projected.push({ permitNumber, row });
    }
  }
  projected.sort((left, right) => left.permitNumber.localeCompare(right.permitNumber));
  if (new Set(projected.map(({ permitNumber }) => permitNumber)).size !== projected.length) {
    throw new Error("Merged Clermont export contains duplicate permit numbers");
  }
  const exportRoot = path.join(candidateRoot, "exports");
  await mkdir(exportRoot, { recursive: true });
  const exportPath = path.join(exportRoot, "clermont-permits.csv");
  const exportText = `${[
    columns.join(","),
    ...projected.map(({ row }) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n")}\n`;
  await writeFile(exportPath, exportText, { encoding: "utf8", flag: "wx" }).catch(
    async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(exportPath, "utf8")) !== exportText) {
        throw new Error("Existing certified export differs from deterministic rebuild");
      }
    },
  );
  const enumeratedPermits = handoffs.reduce((sum, handoff) => sum + handoff.counts.enumerated, 0);
  const deadPermits = handoffs.reduce((sum, handoff) => sum + handoff.counts.provenDead, 0);
  const metadata = clermontMergedExportMetadataSchema.parse({
    schemaVersion: CLERMONT_MERGED_EXPORT_METADATA_SCHEMA_VERSION,
    jobId: options.runId,
    exportedAt: options.now,
    sourceUrl: "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx",
    permitYears: CLERMONT_PERMIT_YEARS.map((year) => String(year).slice(-2)),
    enumeratedPermits,
    deadPermits,
    achievablePermits: enumeratedPermits - deadPermits,
    loadedPermits: projected.length,
  });
  const metadataPath = path.join(exportRoot, "clermont-permits.meta.json");
  const metadataText = `${canonicalJson(metadata)}\n`;
  await writeFile(metadataPath, metadataText, { encoding: "utf8", flag: "wx" }).catch(
    async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(metadataPath, "utf8")) !== metadataText) {
        throw new Error("Existing merged-export metadata differs from deterministic rebuild");
      }
    },
  );
  const mergedExport = {
    artifact: await artifact(candidateRoot, exportPath),
    metadata: await artifact(candidateRoot, metadataPath),
    rows: projected.length,
  };
  const evidenceSha256 = sha256Text(
    canonicalJson({
      requestSha256: prepared.requestSha256,
      provenanceSha256: prepared.provenanceSha256,
      handoffs,
      mergedExport,
    }),
  );
  const expiresAt = new Date(
    nowMs + prepared.request.baseline.maxAgeHours * 60 * 60 * 1_000,
  ).toISOString();
  const requestedBaselineId = `${options.runId}-certified`;
  const baselineId =
    requestedBaselineId.length <= 120
      ? requestedBaselineId
      : `lake-clermont-${sha256Text(options.runId).slice(0, 64)}-certified`;
  const baseline = clermontCertifiedBaselineSchema.parse({
    schemaVersion: CLERMONT_BASELINE_SCHEMA_VERSION,
    baselineId,
    county: "lake",
    jurisdiction: "clermont",
    sourceSystem: "lake_clermont_etrakit_permits",
    requiredHistory: { firstYear: 2015, lastYear: 2026 },
    certifiedAt: options.now,
    expiresAt,
    status: "certified",
    evidenceSha256,
    signatures: prepared.request.signatures,
    partitions: handoffs,
    mergedExport,
  });
  const baselinePath = await writeClermontRunArtifact({
    storeRoot: options.runStore,
    runId: options.runId,
    relativePath: "candidate/baseline.json",
    value: baseline,
  });
  coordinator = await loadClermontCoordinator(options.runStore, options.runId);
  if (coordinator.stages.certification.status === "running") {
    await updateClermontCoordinator({
      storeRoot: options.runStore,
      runId: options.runId,
      expectedRevision: coordinator.revision,
      update: (state) => completeClermontStage(state, "certification", evidenceSha256, options.now),
    });
  }
  return { baseline, candidateRoot, baselinePath };
}
