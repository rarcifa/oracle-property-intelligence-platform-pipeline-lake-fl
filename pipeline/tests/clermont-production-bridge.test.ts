import { copyFile, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/batch/contracts.js";
import {
  certifyClermontRun,
  clermontCertificationEvidenceDigest,
} from "../src/batch/clermont-certifier.js";
import {
  materializeClermontConsumption,
  promoteClermontRun,
  verifyClermontRemotePromotion,
} from "../src/batch/clermont-consumption.js";
import {
  CLERMONT_PERMIT_YEARS,
  CLERMONT_REMOTE_STORAGE_LIMIT_BYTES,
  clermontPartitionHandoffSchema,
  type ClermontImmutableArtifact,
} from "../src/batch/clermont-contracts.js";
import {
  acquireClermontWorkerLease,
  completeClermontWorkerAttempt,
  completeClermontStage,
  heartbeatClermontWorker,
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
  clermontPreparedRunSchema,
  clermontPrepareTemplateSchema,
} from "../src/batch/clermont-run-contracts.js";
import { getClermontRunStatus } from "../src/batch/clermont-status.js";

const NOW = "2026-09-11T12:00:00.000Z";
const REPO_ROOT = path.resolve(process.cwd(), "..");
const RUN_ID = "lake-clermont-production-test";
const ACTIVE_GUARD = {
  leaseError: null,
  async assertActive() {},
  throwIfFailed() {},
  async guardCommit<T>(task: () => Promise<T>): Promise<T> {
    return task();
  },
};

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
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    remoteBaseline: {
      accountId: "122610508924",
      region: "us-east-2",
      bucket: "clermont-baseline-test-bucket",
      prefix: "clermont",
      maxRetainedBytes: CLERMONT_REMOTE_STORAGE_LIMIT_BYTES,
    },
    baseline: { requiredSha256: null, maxAgeHours: 24 * 7 },
    benchmark,
    limits: {
      // Keep this acquisition/certification fixture below its synthetic
      // authorization boundary; cost-gate behavior has dedicated tests.
      costCeilingUsd: 50,
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
  const licenseDirectory =
    '<html><select name="ddlSelContractor"><option value="CCC000000">EXAMPLE ROOFING</option></select></html>\n';
  const licenseDirectorySha256 = createHash("sha256").update(licenseDirectory).digest("hex");
  await writeFile(path.join(root, "license-directory.html"), licenseDirectory);
  await writeFile(
    path.join(root, "license-directory.meta.json"),
    `${JSON.stringify({
      schemaVersion: "elephant.clermont-license-directory-provenance.v1",
      jobId: `${RUN_ID}-y${year}`,
      sourceUrl: "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx",
      capturedAt: NOW,
      sha256: licenseDirectorySha256,
      entries: 1,
      validityBoundary: "contractor-registration-at-capture-not-historical-license-validity",
    })}\n`,
  );
  await writeFile(path.join(root, "raw", `${permitNumber}.html`), `<html>${year}</html>\n`);
  await writeFile(
    path.join(root, "extracted", `${permitNumber}.json`),
    `${JSON.stringify({
      schemaVersion: "elephant.normalized-permit-record.v1",
      countyKey: "lake",
      jurisdictionKey: "clermont",
      property_improvement_id: year.toString(16).padStart(32, "0"),
      property_id: null,
      permit_number: permitNumber,
      parcel_identifier: `ALT${year}`,
      improvement_type: "ROOF",
      improvement_status: year === 2026 ? "ISSUED" : "FINALED",
      improvement_action: "REROOF",
      project_description: "Roof replacement",
      description: "Roof replacement",
      application_received_date: `${year}-01-01`,
      permit_issue_date: `${year}-01-02`,
      permit_close_date: year === 2026 ? null : `${year}-01-10`,
      final_inspection_date: year === 2026 ? null : `${year}-01-10`,
      completion_date: year === 2026 ? null : `${year}-01-10`,
      expiration_date: null,
      opened_date: `${year}-01-01`,
      county_name: "Lake",
      estimated_job_value: null,
      fee: null,
      sourceRecordId: permitNumber,
      sourceUrl: `https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx?activityNo=${permitNumber}`,
      requestedParcelIdentifier: `ALT${year}`,
      requestedPropertyId: null,
      workAddress: null,
      isRoofPermit: true,
      source_system: "lake_clermont_etrakit_permits",
      contractors: [
        {
          businessName: "EXAMPLE ROOFING",
          licenseNumber: "CCC000000",
          qualifierName: null,
          phone: null,
          email: null,
        },
      ],
      inspections: [],
      relatedRecords: [],
      sourcePayload: {
        approvedDate: `${year}-01-02`,
        contractorOfRecord: "EXAMPLE ROOFING",
        contractorOfRecordLicense: "CCC000000",
        licenseDirectorySha256,
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
    expect(
      first.prepared.scopes.configuration.entries.filter(
        ({ logicalPath }) => logicalPath === "input/clermont-executor.json",
      ),
    ).toHaveLength(1);
    expect(first.prepared.scopes.source.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ logicalPath: "pipeline/data/seeds/lake.csv" }),
      ]),
    );
    const sourceWithTamperedEntry = {
      ...first.prepared.scopes.source,
      entries: first.prepared.scopes.source.entries.map((entry, index) =>
        index === 0 ? { ...entry, sha256: "f".repeat(64) } : entry,
      ),
    };
    const tamperedScopes = { ...first.prepared.scopes, source: sourceWithTamperedEntry };
    const tamperedProvenanceSha256 = createHash("sha256")
      .update(
        canonicalJson({
          ...tamperedScopes,
          baseline: first.prepared.request.baseline.requiredSha256,
        }),
      )
      .digest("hex");
    expect(() =>
      clermontPreparedRunSchema.parse({
        ...first.prepared,
        scopes: tamperedScopes,
        provenanceSha256: tamperedProvenanceSha256,
      }),
    ).toThrow(/Scope aggregate must bind/);
    expect(() =>
      clermontPreparedRunSchema.parse({
        ...first.prepared,
        scopes: {
          ...first.prepared.scopes,
          source: {
            ...first.prepared.scopes.source,
            entries: first.prepared.scopes.source.entries.slice(1),
          },
        },
      }),
    ).toThrow(/exact canonical path set/);
    expect(() =>
      clermontPreparedRunSchema.parse({
        ...first.prepared,
        scopes: {
          ...first.prepared.scopes,
          source: {
            ...first.prepared.scopes.source,
            entries: [
              ...first.prepared.scopes.source.entries,
              { logicalPath: "pipeline/zzz-unapproved", sha256: "a".repeat(64), bytes: 1 },
            ],
          },
        },
      }),
    ).toThrow(/exact canonical path set/);
    expect(() =>
      clermontPreparedRunSchema.parse({
        ...first.prepared,
        scopes: {
          ...first.prepared.scopes,
          source: {
            ...first.prepared.scopes.source,
            entries: [
              first.prepared.scopes.source.entries[0],
              ...first.prepared.scopes.source.entries,
            ],
          },
        },
      }),
    ).toThrow(/Scope paths must be unique/);
    await verifyClermontPreparedScopes({ repoRoot: REPO_ROOT, prepared: first.prepared });
    expect(() =>
      clermontPreparedRunSchema.parse({
        ...first.prepared,
        executor: { ...first.prepared.executor, delayMs: 500 },
      }),
    ).toThrow(/executor policy must equal/);
    expect(() =>
      clermontPreparedRunSchema.parse({
        ...first.prepared,
        requestSha256: "f".repeat(64),
      }),
    ).toThrow(/request digest must match/);
    expect(() =>
      clermontPreparedRunSchema.parse({
        ...first.prepared,
        provenanceSha256: "f".repeat(64),
      }),
    ).toThrow(/provenance digest must match/);
    expect(() =>
      clermontPreparedRunSchema.parse({
        ...first.prepared,
        template: {
          ...first.prepared.template,
          limits: {
            ...first.prepared.template.limits,
            maxAttempts: first.prepared.template.limits.maxAttempts + 1,
          },
        },
        request: {
          ...first.prepared.request,
          limits: {
            ...first.prepared.request.limits,
            maxAttempts: first.prepared.request.limits.maxAttempts + 1,
          },
        },
      }),
    ).toThrow(/request digest must match/);
    const mutatedExecutor = {
      ...first.prepared,
      template: {
        ...first.prepared.template,
        executor: { ...first.prepared.template.executor, delayMs: 251 },
      },
      executor: { ...first.prepared.executor, delayMs: 251 },
    };
    expect(() => clermontPreparedRunSchema.parse(mutatedExecutor)).not.toThrow();
    await expect(
      verifyClermontPreparedScopes({ repoRoot: REPO_ROOT, prepared: mutatedExecutor }),
    ).rejects.toThrow(/configuration scope has drifted/);

    const mirrorRoot = path.join(scratch, "scoped-repo-mirror");
    const copiedTargets = new Set([
      "pipeline/src/batch/clermont-status.ts",
      "pipeline/src/permits/normalization.mjs",
    ]);
    const mirrored = new Set<string>();
    for (const group of Object.values(first.prepared.scopes)) {
      for (const entry of group.entries) {
        if (entry.logicalPath.startsWith("input/") || mirrored.has(entry.logicalPath)) continue;
        mirrored.add(entry.logicalPath);
        const source = path.join(REPO_ROOT, entry.logicalPath);
        const destination = path.join(mirrorRoot, entry.logicalPath);
        await mkdir(path.dirname(destination), { recursive: true });
        if (copiedTargets.has(entry.logicalPath)) await copyFile(source, destination);
        else await symlink(source, destination);
      }
    }
    const statusPath = path.join(mirrorRoot, "pipeline/src/batch/clermont-status.ts");
    await writeFile(statusPath, "\n// scoped control-plane drift\n", { flag: "a" });
    await expect(
      verifyClermontPreparedScopes({ repoRoot: mirrorRoot, prepared: first.prepared }),
    ).rejects.toThrow(/configuration scope has drifted/);
    await copyFile(path.join(REPO_ROOT, "pipeline/src/batch/clermont-status.ts"), statusPath);
    const normalizationPath = path.join(mirrorRoot, "pipeline/src/permits/normalization.mjs");
    await writeFile(normalizationPath, "\n// scoped transitive-source drift\n", { flag: "a" });
    await expect(
      verifyClermontPreparedScopes({ repoRoot: mirrorRoot, prepared: first.prepared }),
    ).rejects.toThrow(/source scope has drifted/);

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

    const secondCoordinatorPath = path.join(scratch, "run-b", "runs", RUN_ID, "coordinator.json");
    const secondCoordinator = JSON.parse(await readFile(secondCoordinatorPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      secondCoordinatorPath,
      `${JSON.stringify({ ...secondCoordinator, provenanceSha256: "f".repeat(64) })}\n`,
    );
    await expect(loadClermontCoordinator(path.join(scratch, "run-b"), RUN_ID)).rejects.toThrow(
      /Coordinator identity or provenance drifted/,
    );
  });

  it("seals each year, prunes only verified loose evidence, certifies, promotes, and consumes", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-production-"));
    const fakeRepo = path.join(scratch, "live");
    const runStore = path.join(scratch, "run-store");
    const baselineStore = path.join(scratch, "baseline-store");
    const templatePath = await templateFile(scratch);
    const preparedRun = await prepareClermontRun({
      repoRoot: REPO_ROOT,
      templatePath,
      runStore,
      baselineStore: null,
      now: NOW,
    });
    for (const year of CLERMONT_PERMIT_YEARS) {
      const liveRoot = await writeLivePartition(fakeRepo, year);
      const partitionId = `lake-clermont-etrakit-${year}`;
      const idleWorker = await loadClermontWorker(runStore, RUN_ID, partitionId);
      const worker = await updateClermontWorker({
        storeRoot: runStore,
        runId: RUN_ID,
        partitionId,
        expectedFencingToken: idleWorker.fencingToken,
        update: (current) =>
          acquireClermontWorkerLease({
            worker: current,
            request: preparedRun.prepared.request,
            owner: "production-test",
            now: NOW,
          }),
      });
      if (year === 2015) {
        const extractedPath = path.join(liveRoot, "extracted", "15-0001.json");
        const originalExtracted = await readFile(extractedPath, "utf8");
        const tampered = JSON.parse(originalExtracted) as {
          contractors: Array<{ licenseNumber: string | null }>;
          sourcePayload: { contractorOfRecordLicense: string | null };
        };
        tampered.contractors[0]!.licenseNumber = "CCC999999";
        tampered.sourcePayload.contractorOfRecordLicense = "CCC999999";
        await writeFile(extractedPath, `${JSON.stringify(tampered)}\n`);
        await expect(
          sealClermontPartitionEvidence({
            repoRoot: fakeRepo,
            runStore,
            runId: RUN_ID,
            year,
            owner: "production-test",
            fencingToken: worker.fencingToken,
            clock: () => NOW,
            guard: ACTIVE_GUARD,
          }),
        ).rejects.toThrow(/not normalized against the pinned directory/);
        await writeFile(extractedPath, originalExtracted);
      }
      const handoff = await sealClermontPartitionEvidence({
        repoRoot: fakeRepo,
        runStore,
        runId: RUN_ID,
        year,
        owner: "production-test",
        fencingToken: worker.fencingToken,
        clock: () => NOW,
        guard: ACTIVE_GUARD,
        pruneLooseAfterSeal: year === 2015,
      });
      expect(clermontPartitionHandoffSchema.parse(handoff).status).toBe("captured_complete");
      expect(handoff.producerLease).toEqual({
        owner: "production-test",
        fencingToken: worker.fencingToken,
        heartbeatAt: NOW,
      });
      if (year === 2015) {
        await expect(stat(path.join(liveRoot, "raw"))).rejects.toThrow();
        const pruneReceipt = JSON.parse(
          await readFile(path.join(liveRoot, "loose-evidence-pruned.json"), "utf8"),
        ) as { producerLease: { owner: string; fencingToken: number }; handoffSha256: string };
        expect(pruneReceipt.producerLease).toMatchObject({
          owner: "production-test",
          fencingToken: worker.fencingToken,
        });
        expect(pruneReceipt.handoffSha256).toMatch(/^[a-f0-9]{64}$/);
      }
      const checkpointedWorker = await updateClermontWorker({
        storeRoot: runStore,
        runId: RUN_ID,
        partitionId,
        expectedFencingToken: worker.fencingToken,
        update: (current) =>
          heartbeatClermontWorker({
            worker: current,
            request: preparedRun.prepared.request,
            owner: "production-test",
            fencingToken: worker.fencingToken,
            checkpointSha256: handoff.checkpoint.checkpointSha256,
            checkpointSignatures: preparedRun.prepared.request.signatures,
            now: NOW,
          }),
      });
      await updateClermontWorker({
        storeRoot: runStore,
        runId: RUN_ID,
        partitionId,
        expectedFencingToken: checkpointedWorker.fencingToken,
        update: (current) =>
          completeClermontWorkerAttempt({
            worker: current,
            owner: "production-test",
            fencingToken: checkpointedWorker.fencingToken,
            now: NOW,
          }),
      });
    }
    await completePrerequisites(runStore);
    const workerPath = path.join(
      runStore,
      "runs",
      RUN_ID,
      "workers",
      "lake-clermont-etrakit-2015.json",
    );
    const terminalWorker = JSON.parse(await readFile(workerPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      workerPath,
      `${JSON.stringify({
        ...terminalWorker,
        signatures: {
          ...(terminalWorker.signatures as Record<string, unknown>),
          configurationSha256: "f".repeat(64),
        },
      })}\n`,
    );
    await expect(
      certifyClermontRun({ repoRoot: REPO_ROOT, runStore, runId: RUN_ID, now: NOW }),
    ).rejects.toThrow(/terminal fenced worker checkpoint/);
    await writeFile(workerPath, `${JSON.stringify(terminalWorker)}\n`);
    const handoffPath = path.join(
      runStore,
      "runs",
      RUN_ID,
      "candidate",
      "partitions",
      "2015",
      "handoff.json",
    );
    const handoff = clermontPartitionHandoffSchema.parse(
      JSON.parse(await readFile(handoffPath, "utf8")),
    );
    const licenseDirectoryPath = path.join(
      runStore,
      "runs",
      RUN_ID,
      "candidate",
      handoff.artifacts.licenseDirectory.logicalPath,
    );
    const originalLicenseDirectory = await readFile(licenseDirectoryPath, "utf8");
    const pinnedLicenseDirectorySha256 = createHash("sha256")
      .update(originalLicenseDirectory)
      .digest("hex");
    expect(handoff.licenseDirectory.sha256).toBe(pinnedLicenseDirectorySha256);
    expect(handoff.artifacts.licenseDirectory.sha256).toBe(pinnedLicenseDirectorySha256);
    await writeFile(licenseDirectoryPath, `${originalLicenseDirectory}<!-- corrupt -->\n`);
    await expect(
      certifyClermontRun({ repoRoot: REPO_ROOT, runStore, runId: RUN_ID, now: NOW }),
    ).rejects.toThrow(/Evidence artifact failed digest readback/);
    await writeFile(licenseDirectoryPath, originalLicenseDirectory);
    const extractedArchivePath = path.join(
      runStore,
      "runs",
      RUN_ID,
      "candidate",
      handoff.artifacts.extracted.logicalPath,
    );
    const originalArchive = await readFile(extractedArchivePath);
    const extractedLines = gunzipSync(originalArchive)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const corruptBody = `${canonicalJson({
      ...(JSON.parse(String(extractedLines[0]!.body)) as Record<string, unknown>),
      permit_number: "15-9999",
    })}\n`;
    extractedLines[0] = {
      ...extractedLines[0]!,
      stableId: "lake:clermont:etrakit:15-9999",
      body: corruptBody,
      sha256: createHash("sha256").update(corruptBody).digest("hex"),
    };
    const corruptedArchive = gzipSync(
      `${extractedLines.map((line) => canonicalJson(line)).join("\n")}\n`,
      { level: 9 },
    );
    await writeFile(extractedArchivePath, corruptedArchive);
    await writeFile(
      handoffPath,
      `${canonicalJson({
        ...handoff,
        artifacts: {
          ...handoff.artifacts,
          extracted: {
            ...handoff.artifacts.extracted,
            sha256: createHash("sha256").update(corruptedArchive).digest("hex"),
            bytes: corruptedArchive.length,
          },
        },
      })}\n`,
    );
    await expect(
      certifyClermontRun({ repoRoot: REPO_ROOT, runStore, runId: RUN_ID, now: NOW }),
    ).rejects.toThrow(/Status evidence does not bind raw\/extracted bytes/);
    await writeFile(extractedArchivePath, originalArchive);
    await writeFile(handoffPath, `${canonicalJson(handoff)}\n`);
    const certified = await certifyClermontRun({
      repoRoot: REPO_ROOT,
      runStore,
      runId: RUN_ID,
      now: NOW,
    });
    expect(certified.baseline.mergedExport.rows).toBe(12);
    expect(certified.baseline.partitions).toHaveLength(12);
    const recoveredCertification = await certifyClermontRun({
      repoRoot: REPO_ROOT,
      runStore,
      runId: RUN_ID,
      now: "2026-09-11T13:00:00.000Z",
    });
    expect(recoveredCertification.baseline).toEqual(certified.baseline);

    const licenseTamperedPartitions = certified.baseline.partitions.map((partition, index) =>
      index === 0
        ? {
            ...partition,
            licenseDirectory: {
              ...partition.licenseDirectory,
              entries: partition.licenseDirectory.entries + 1,
            },
          }
        : partition,
    );
    expect(
      clermontCertificationEvidenceDigest({
        requestSha256: preparedRun.prepared.requestSha256,
        provenanceSha256: preparedRun.prepared.provenanceSha256,
        handoffs: licenseTamperedPartitions,
        mergedExport: certified.baseline.mergedExport,
      }),
    ).not.toBe(certified.baseline.evidenceSha256);

    const tamperedPartitions = certified.baseline.partitions.map((partition, index) =>
      index === 0
        ? {
            ...partition,
            producerLease: { ...partition.producerLease, owner: "post-cert-tamper" },
          }
        : partition,
    );
    const tamperedBaseline = {
      ...certified.baseline,
      partitions: tamperedPartitions,
      evidenceSha256: clermontCertificationEvidenceDigest({
        requestSha256: preparedRun.prepared.requestSha256,
        provenanceSha256: preparedRun.prepared.provenanceSha256,
        handoffs: tamperedPartitions,
        mergedExport: certified.baseline.mergedExport,
      }),
    };
    await writeFile(certified.baselinePath, `${canonicalJson(tamperedBaseline)}\n`);
    await expect(
      promoteClermontRun({
        repoRoot: REPO_ROOT,
        runStore,
        baselineStore,
        runId: RUN_ID,
        now: NOW,
      }),
    ).rejects.toThrow(/does not match the completed certification/);
    await expect(stat(path.join(baselineStore, "last-good.json"))).rejects.toThrow();
    await writeFile(certified.baselinePath, `${canonicalJson(certified.baseline)}\n`);

    const promoted = await promoteClermontRun({
      repoRoot: REPO_ROOT,
      runStore,
      baselineStore,
      runId: RUN_ID,
      now: NOW,
      outputRelativePath: "output/clermont-permits.csv",
    });
    expect(promoted.consumptionRequest.baselineSha256).toBe(promoted.baselineSha256);
    expect(
      await readFile(
        path.join(
          baselineStore,
          "baselines",
          promoted.baselineSha256,
          certified.baseline.partitions[0]!.artifacts.licenseDirectory.logicalPath,
        ),
        "utf8",
      ),
    ).toBe(originalLicenseDirectory);
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

    await expect(
      verifyClermontRemotePromotion({
        repoRoot: REPO_ROOT,
        runStore,
        baselineStore,
        runId: RUN_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      consumptionRequest: { baselineSha256: promoted.baselineSha256 },
    });

    let coordinator = await loadClermontCoordinator(runStore, RUN_ID);
    coordinator = await updateClermontCoordinator({
      storeRoot: runStore,
      runId: RUN_ID,
      expectedRevision: coordinator.revision,
      update: (state) =>
        completeClermontStage(state, "baseline-promotion", promoted.baselineSha256, NOW),
    });
    coordinator = await updateClermontCoordinator({
      storeRoot: runStore,
      runId: RUN_ID,
      expectedRevision: coordinator.revision,
      update: (state) => startClermontStage(state, "publication-readiness", NOW),
    });
    await updateClermontCoordinator({
      storeRoot: runStore,
      runId: RUN_ID,
      expectedRevision: coordinator.revision,
      update: (state) =>
        completeClermontStage(state, "publication-readiness", promoted.baselineSha256, NOW),
    });
    const remoteArtifacts: ClermontImmutableArtifact[] = [
      {
        logicalPath: "baseline.json",
        sha256: promoted.baselineSha256,
        bytes: Buffer.byteLength(canonicalJson(certified.baseline)),
      },
      ...certified.baseline.partitions.flatMap(({ artifacts }) => Object.values(artifacts)),
      certified.baseline.mergedExport.artifact,
      certified.baseline.mergedExport.metadata,
    ];
    const s3ReceiptPath = path.join(
      runStore,
      "runs",
      RUN_ID,
      "promotion",
      "s3-promotion-receipt.json",
    );
    const s3Receipt = {
      accountId: preparedRun.prepared.request.remoteBaseline.accountId,
      region: preparedRun.prepared.request.remoteBaseline.region,
      bucket: preparedRun.prepared.request.remoteBaseline.bucket,
      prefix: preparedRun.prepared.request.remoteBaseline.prefix,
      baselineSha256: promoted.baselineSha256,
      pointerKey: `${preparedRun.prepared.request.remoteBaseline.prefix}/last-good.json`,
      objects: remoteArtifacts
        .map((artifact) => ({
          key: `${preparedRun.prepared.request.remoteBaseline.prefix}/baselines/${promoted.baselineSha256}/${artifact.logicalPath}`,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
          etag: null,
          action: "uploaded",
        }))
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
      pointerEtag: "pointer-etag",
      readBackAt: NOW,
    };
    await writeFile(s3ReceiptPath, `${JSON.stringify(s3Receipt)}\n`);
    await expect(
      getClermontRunStatus({ runStore, runId: RUN_ID, now: NOW }),
    ).resolves.toMatchObject({
      clermontSourceCompletenessEstablished: true,
      promotionEvidenceIssues: [],
    });
    const completedCoordinatorPath = path.join(runStore, "runs", RUN_ID, "coordinator.json");
    const completedCoordinator = JSON.parse(
      await readFile(completedCoordinatorPath, "utf8"),
    ) as Record<string, unknown>;
    const forgedEvidenceSha256 = "f".repeat(64);
    const completedStages = completedCoordinator.stages as Record<string, Record<string, unknown>>;
    await writeFile(
      certified.baselinePath,
      `${canonicalJson({
        ...certified.baseline,
        evidenceSha256: forgedEvidenceSha256,
      })}\n`,
    );
    await writeFile(
      completedCoordinatorPath,
      `${canonicalJson({
        ...completedCoordinator,
        stages: {
          ...completedStages,
          certification: {
            ...completedStages.certification,
            evidenceSha256: forgedEvidenceSha256,
          },
        },
      })}\n`,
    );
    await expect(
      getClermontRunStatus({ runStore, runId: RUN_ID, now: NOW }),
    ).resolves.toMatchObject({
      blockerCategory: "certification-pending",
      clermontSourceCompletenessEstablished: false,
      promotionEvidenceIssues: expect.arrayContaining(["certification-unbound"]),
    });
    await writeFile(certified.baselinePath, `${canonicalJson(certified.baseline)}\n`);
    await writeFile(completedCoordinatorPath, `${canonicalJson(completedCoordinator)}\n`);
    await writeFile(s3ReceiptPath, "");
    await expect(
      getClermontRunStatus({ runStore, runId: RUN_ID, now: NOW }),
    ).resolves.toMatchObject({ clermontSourceCompletenessEstablished: false });
    await writeFile(s3ReceiptPath, `${JSON.stringify(s3Receipt)}\n`);
    const localReceiptPath = path.join(
      runStore,
      "runs",
      RUN_ID,
      "promotion",
      "local-promotion-receipt.json",
    );
    const localReceipt = JSON.parse(await readFile(localReceiptPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      localReceiptPath,
      `${JSON.stringify({ ...localReceipt, runId: "another-run" })}\n`,
    );
    await expect(
      getClermontRunStatus({ runStore, runId: RUN_ID, now: NOW }),
    ).resolves.toMatchObject({ clermontSourceCompletenessEstablished: false });
    await writeFile(localReceiptPath, `${JSON.stringify(localReceipt)}\n`);
    await writeFile(
      promoted.consumptionRequestPath,
      `${JSON.stringify({
        ...promoted.consumptionRequest,
        signatures: {
          ...promoted.consumptionRequest.signatures,
          schemaSha256: "f".repeat(64),
        },
      })}\n`,
    );
    await expect(
      verifyClermontRemotePromotion({
        repoRoot: REPO_ROOT,
        runStore,
        baselineStore,
        runId: RUN_ID,
        now: NOW,
      }),
    ).rejects.toThrow(/remote-promotion signatures drifted/);
  });
});
