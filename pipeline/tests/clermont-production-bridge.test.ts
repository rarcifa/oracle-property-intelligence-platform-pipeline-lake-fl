import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { certifyClermontRun } from "../src/batch/clermont-certifier.js";
import {
  materializeClermontConsumption,
  promoteClermontRun,
} from "../src/batch/clermont-consumption.js";
import {
  CLERMONT_PERMIT_YEARS,
  clermontPartitionHandoffSchema,
} from "../src/batch/clermont-contracts.js";
import {
  completeClermontStage,
  startClermontStage,
  type ClermontStageName,
} from "../src/batch/clermont-coordinator.js";
import { sealClermontPartitionEvidence } from "../src/batch/clermont-executor.js";
import {
  prepareClermontRun,
  verifyClermontPreparedScopes,
} from "../src/batch/clermont-preparation.js";
import {
  loadClermontCoordinator,
  loadClermontWorker,
  updateClermontCoordinator,
  updateClermontWorker,
} from "../src/batch/clermont-run-store.js";
import {
  CLERMONT_PREPARE_TEMPLATE_SCHEMA_VERSION,
  clermontPrepareTemplateSchema,
} from "../src/batch/clermont-run-contracts.js";

const NOW = "2026-09-11T12:00:00.000Z";
const REPO_ROOT = path.resolve(process.cwd(), "..");
const RUN_ID = "lake-clermont-production-test";

async function templateFile(scratch: string): Promise<string> {
  const benchmark = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "fixtures",
        "permits",
        "lake",
        "clermont",
        "synthetic-ingestion-plan.json",
      ),
      "utf8",
    ),
  );
  const template = clermontPrepareTemplateSchema.parse({
    schemaVersion: CLERMONT_PREPARE_TEMPLATE_SCHEMA_VERSION,
    runId: RUN_ID,
    refreshMode: "full",
    baseline: { requiredSha256: null, maxAgeHours: 24 * 7 },
    benchmark,
    limits: {
      costCeilingUsd: 5,
      maxAutomaticHours: 48,
      runnerHourlyUsd: 0.1,
      requestCostPerThousandUsd: 0.01,
      storagePerGbUsd: 0.03,
      maxAttempts: 3,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      circuitBreakerFailures: 2,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
    },
    executor: { concurrency: 2, delayMs: 250, partitionTimeoutMs: 60 * 60 * 1_000 },
    authorization: null,
  });
  const filePath = path.join(scratch, "template.json");
  await writeFile(filePath, `${JSON.stringify(template)}\n`);
  return filePath;
}

async function writeLivePartition(fakeRepo: string, year: number): Promise<string> {
  const permitNumber = `${String(year).slice(-2)}-0001`;
  const root = path.join(
    fakeRepo,
    "pipeline",
    "data",
    "artifacts",
    "permits",
    "lake",
    `${RUN_ID}-y${year}`,
  );
  await Promise.all(
    ["permit-lists", "raw", "extracted", "dead", "status"].map((name) =>
      mkdir(path.join(root, name), { recursive: true }),
    ),
  );
  await writeFile(
    path.join(root, "permit-lists", "clermont-permit-index.json"),
    `${JSON.stringify({
      schemaVersion: "elephant.clermont-permit-index.v1",
      jobId: `${RUN_ID}-y${year}`,
      jurisdictionKey: "clermont",
      sourceUrl: "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx",
      years: [String(year).slice(-2)],
      enumeratedAt: NOW,
      wallSeconds: 1,
      prefixesSearched: 1,
      unresolvedPrefixes: [],
      permitCount: 1,
      distinctAlternateKeys: 1,
      permits: [{ permitNumber, alternateKey: `ALT${year}` }],
    })}\n`,
  );
  await writeFile(path.join(root, "raw", `${permitNumber}.html`), `<html>${year}</html>\n`);
  await writeFile(
    path.join(root, "extracted", `${permitNumber}.json`),
    `${JSON.stringify({
      permit_number: permitNumber,
      parcel_identifier: `ALT${year}`,
      property_id: year % 2 === 0 ? `PID${year}` : null,
      improvement_type: "ROOF",
      improvement_status: year === 2026 ? "ISSUED" : "FINALED",
      project_description: "Roof replacement",
      description: "Roof replacement",
      application_received_date: `${year}-01-01`,
      permit_issue_date: `${year}-01-02`,
      permit_close_date: year === 2026 ? null : `${year}-01-10`,
      final_inspection_date: year === 2026 ? null : `${year}-01-10`,
      sourceUrl: `https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx?activityNo=${permitNumber}`,
      isRoofPermit: true,
      source_system: "lake_clermont_etrakit_permits",
      contractors: [{ businessName: "EXAMPLE ROOFING", licenseNumber: "CCC000000" }],
      sourcePayload: {
        approvedDate: `${year}-01-02`,
        contractorOfRecord: "EXAMPLE ROOFING",
        contractorOfRecordLicense: "CCC000000",
      },
    })}\n`,
  );
  return root;
}

async function completePrerequisites(runStore: string): Promise<void> {
  const stages: ClermontStageName[] = ["enumeration", "acquisition", "reconciliation"];
  for (const [index, stage] of stages.entries()) {
    let coordinator = await loadClermontCoordinator(runStore, RUN_ID);
    coordinator = await updateClermontCoordinator({
      storeRoot: runStore,
      runId: RUN_ID,
      expectedRevision: coordinator.revision,
      update: (state) => startClermontStage(state, stage, NOW),
    });
    await updateClermontCoordinator({
      storeRoot: runStore,
      runId: RUN_ID,
      expectedRevision: coordinator.revision,
      update: (state) =>
        completeClermontStage(state, stage, `${String(index + 6).repeat(64)}`, NOW),
    });
  }
}

describe("Clermont production acquisition/certification bridge", () => {
  it("prepares a deterministic scope-bound run and fences persistent state", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-production-"));
    const templatePath = await templateFile(scratch);
    const first = await prepareClermontRun({
      repoRoot: REPO_ROOT,
      templatePath,
      runStore: path.join(scratch, "run-a"),
      baselineStore: null,
      now: NOW,
    });
    const second = await prepareClermontRun({
      repoRoot: REPO_ROOT,
      templatePath,
      runStore: path.join(scratch, "run-b"),
      baselineStore: null,
      now: NOW,
    });
    expect(first.prepared).toEqual(second.prepared);
    expect(first.prepared.request.signatures).toEqual({
      sourceSha256: first.prepared.scopes.source.aggregateSha256,
      configurationSha256: first.prepared.scopes.configuration.aggregateSha256,
      schemaSha256: first.prepared.scopes.schema.aggregateSha256,
    });
    await verifyClermontPreparedScopes({ repoRoot: REPO_ROOT, prepared: first.prepared });

    const worker = await loadClermontWorker(
      path.join(scratch, "run-a"),
      RUN_ID,
      "lake-clermont-etrakit-2015",
    );
    await expect(
      updateClermontWorker({
        storeRoot: path.join(scratch, "run-a"),
        runId: RUN_ID,
        partitionId: worker.partitionId,
        expectedFencingToken: worker.fencingToken + 1,
        update: (current) => current,
      }),
    ).rejects.toThrow(/fencing token failed/);
  });

  it("seals each year, prunes only verified loose evidence, certifies, promotes, and consumes", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-production-"));
    const fakeRepo = path.join(scratch, "live");
    const runStore = path.join(scratch, "run-store");
    const baselineStore = path.join(scratch, "baseline-store");
    const templatePath = await templateFile(scratch);
    await prepareClermontRun({
      repoRoot: REPO_ROOT,
      templatePath,
      runStore,
      baselineStore: null,
      now: NOW,
    });
    for (const year of CLERMONT_PERMIT_YEARS) {
      const liveRoot = await writeLivePartition(fakeRepo, year);
      const handoff = await sealClermontPartitionEvidence({
        repoRoot: fakeRepo,
        runStore,
        runId: RUN_ID,
        year,
        now: NOW,
        pruneLooseAfterSeal: year === 2015,
      });
      expect(clermontPartitionHandoffSchema.parse(handoff).status).toBe("captured_complete");
      if (year === 2015) {
        await expect(stat(path.join(liveRoot, "raw"))).rejects.toThrow();
        expect(await readFile(path.join(liveRoot, "loose-evidence-pruned.json"), "utf8")).toContain(
          handoff.artifacts.raw.sha256,
        );
      }
    }
    await completePrerequisites(runStore);
    const certified = await certifyClermontRun({
      repoRoot: REPO_ROOT,
      runStore,
      runId: RUN_ID,
      now: NOW,
    });
    expect(certified.baseline.mergedExport.rows).toBe(12);
    expect(certified.baseline.partitions).toHaveLength(12);

    const promoted = await promoteClermontRun({
      repoRoot: REPO_ROOT,
      runStore,
      baselineStore,
      runId: RUN_ID,
      now: NOW,
      outputRelativePath: "output/clermont-permits.csv",
    });
    expect(promoted.consumptionRequest.baselineSha256).toBe(promoted.baselineSha256);
    const materialized = await materializeClermontConsumption({
      consumptionRequestPath: promoted.consumptionRequestPath,
      baselineStore,
      outputRoot: scratch,
      now: NOW,
    });
    expect(materialized.rows).toBe(12);
    expect(await readFile(path.join(scratch, "output", "clermont-permits.csv"), "utf8")).toContain(
      "26-0001",
    );
  });
});
