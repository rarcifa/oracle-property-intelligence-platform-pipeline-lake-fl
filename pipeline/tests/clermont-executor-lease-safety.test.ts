import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Text } from "../src/batch/contracts.js";

import {
  acquireClermontWorkerLease,
  completeClermontWorkerAttempt,
  failClermontWorkerAttempt,
  heartbeatClermontWorker,
} from "../src/batch/clermont-coordinator.js";
import { promoteCertifiedClermontBaseline } from "../src/batch/clermont-baseline-store.js";
import { certifyClermontRun } from "../src/batch/clermont-certifier.js";
import {
  CLERMONT_PERMIT_YEARS,
  CLERMONT_REMOTE_STORAGE_LIMIT_BYTES,
  clermontAuthorizationScopeDigest,
  clermontBaselineDigest,
} from "../src/batch/clermont-contracts.js";
import {
  clermontLivePartitionRoot,
  createElapsedClermontClock,
  runClermontAcquisition,
  runClermontHarvesterProcess,
  sealClermontPartitionEvidence,
  startClermontLeaseSupervisor,
  type ClermontHarvesterRunOptions,
} from "../src/batch/clermont-executor.js";
import { prepareClermontRun } from "../src/batch/clermont-preparation.js";
import {
  loadClermontCoordinator,
  loadClermontWorker,
  acquireClermontRunLock,
  updateClermontWorker,
  withClermontWorkerFence,
  writeFencedClermontRunArtifact,
} from "../src/batch/clermont-run-store.js";
import {
  CLERMONT_PREPARE_TEMPLATE_SCHEMA_VERSION,
  clermontPrepareTemplateSchema,
  type ClermontPreparedRun,
} from "../src/batch/clermont-run-contracts.js";
import {
  syntheticClermontBaseline,
  writeSyntheticClermontArtifacts,
} from "./clermont-batch-fixtures.js";

const NOW = "2026-09-11T12:00:00.000Z";
const REPO_ROOT = path.resolve(process.cwd(), "..");
const ACTIVE_GUARD = {
  leaseError: null,
  async assertActive() {},
  throwIfFailed() {},
  async guardCommit<T>(task: () => Promise<T>): Promise<T> {
    return task();
  },
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function prepareHarness(options: {
  scratch: string;
  runId: string;
  refreshMode?: "full" | "incremental";
  baselineSha256?: string;
  baselineStore?: string;
  authorizationExpiresAt?: string;
  maxAttempts?: number;
}): Promise<{ runStore: string; artifactsRoot: string; prepared: ClermontPreparedRun }> {
  await mkdir(options.scratch, { recursive: true });
  const fixtureBenchmark = JSON.parse(
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
  const benchmark = { ...fixtureBenchmark };
  const limits = {
    costCeilingUsd: options.authorizationExpiresAt === undefined ? 50 : 0.0001,
    maxAutomaticHours: 48 as const,
    runnerHourlyUsd: 0.1,
    requestCostPerThousandUsd: 0.01,
    storagePerGbUsd: 0.03,
    maxAttempts: options.maxAttempts ?? 3,
    baseBackoffMs: 1_000,
    maxBackoffMs: 60_000,
    circuitBreakerFailures: 2,
    leaseDurationMs: 1_000,
    heartbeatIntervalMs: 250,
  };
  const templateBase = clermontPrepareTemplateSchema.parse({
    schemaVersion: CLERMONT_PREPARE_TEMPLATE_SCHEMA_VERSION,
    runId: options.runId,
    refreshMode: options.refreshMode ?? "full",
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
    baseline: {
      requiredSha256: options.baselineSha256 ?? null,
      maxAgeHours: 24 * 7,
    },
    benchmark,
    limits,
    executor: { concurrency: 2, delayMs: 0, partitionTimeoutMs: 60_000 },
    authorization: null,
  });
  const templatePath = path.join(options.scratch, `${options.runId}-template.json`);
  const runStore = path.join(options.scratch, "run-store");
  let template = templateBase;
  if (options.authorizationExpiresAt !== undefined) {
    await writeFile(templatePath, `${JSON.stringify(templateBase)}\n`);
    const preview = await prepareClermontRun({
      repoRoot: REPO_ROOT,
      templatePath,
      runStore: path.join(options.scratch, "preview-run-store"),
      baselineStore: options.baselineStore ?? null,
      now: NOW,
    });
    const estimate = preview.coordinator.estimate;
    template = clermontPrepareTemplateSchema.parse({
      ...templateBase,
      authorization: {
        authorizationId: `authorization-${options.runId}`,
        runId: options.runId,
        requestScopeSha256: clermontAuthorizationScopeDigest(preview.prepared.request),
        provenanceSha256: preview.prepared.provenanceSha256,
        estimateSha256: estimate.estimateSha256,
        maxExecutionHours: Math.max(48, estimate.estimatedHours),
        maxCostUsd: Math.max(5, estimate.estimatedCostUsd),
        approvedBy: "lease-safety-test",
        approvedAt: "2026-09-11T11:59:59.000Z",
        expiresAt: options.authorizationExpiresAt,
      },
    });
  }
  await writeFile(templatePath, `${JSON.stringify(template)}\n`);
  const result = await prepareClermontRun({
    repoRoot: REPO_ROOT,
    templatePath,
    runStore,
    baselineStore: options.baselineStore ?? null,
    now: NOW,
  });
  return {
    runStore,
    artifactsRoot: path.join(options.scratch, "live-artifacts"),
    prepared: result.prepared,
  };
}

function argument(options: ClermontHarvesterRunOptions, name: string): string {
  const index = options.args.indexOf(name);
  if (index < 0 || options.args[index + 1] === undefined) {
    throw new Error(`Missing harvester argument ${name}`);
  }
  return options.args[index + 1]!;
}

async function writePartitionEvidence(options: {
  artifactsRoot: string;
  runId: string;
  year: number;
  includeRecords: boolean;
}): Promise<void> {
  const permitNumber = `${String(options.year).slice(-2)}-0001`;
  const root = clermontLivePartitionRoot(
    REPO_ROOT,
    options.runId,
    options.year,
    options.artifactsRoot,
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
      jobId: `${options.runId}-y${options.year}`,
      jurisdictionKey: "clermont",
      sourceUrl: "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx",
      years: [String(options.year).slice(-2)],
      prefixesSearched: 1,
      unresolvedPrefixes: [],
      permitCount: 1,
      permits: [{ permitNumber, alternateKey: `ALT${options.year}` }],
    })}\n`,
  );
  const licenseDirectory =
    '<html><select name="ddlSelContractor"><option value="CCC000000">EXAMPLE ROOFING</option></select></html>\n';
  const licenseDirectorySha256 = sha256Text(licenseDirectory);
  await writeFile(path.join(root, "license-directory.html"), licenseDirectory);
  await writeFile(
    path.join(root, "license-directory.meta.json"),
    `${JSON.stringify({
      schemaVersion: "elephant.clermont-license-directory-provenance.v1",
      jobId: `${options.runId}-y${options.year}`,
      sourceUrl: "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx",
      capturedAt: NOW,
      sha256: licenseDirectorySha256,
      entries: 1,
      validityBoundary: "contractor-registration-at-capture-not-historical-license-validity",
    })}\n`,
  );
  if (!options.includeRecords) return;
  await writeFile(path.join(root, "raw", `${permitNumber}.html`), `<html>${options.year}</html>\n`);
  await writeFile(
    path.join(root, "extracted", `${permitNumber}.json`),
    `${JSON.stringify({
      schemaVersion: "elephant.normalized-permit-record.v1",
      countyKey: "lake",
      jurisdictionKey: "clermont",
      property_improvement_id: options.year.toString(16).padStart(32, "0"),
      permit_number: permitNumber,
      parcel_identifier: `ALT${options.year}`,
      property_id: null,
      improvement_type: "ROOF",
      improvement_status: options.year === 2026 ? "ISSUED" : "FINALED",
      improvement_action: "REROOF",
      permit_issue_date: `${options.year}-01-02`,
      application_received_date: `${options.year}-01-01`,
      final_inspection_date: options.year === 2026 ? null : `${options.year}-01-10`,
      permit_close_date: options.year === 2026 ? null : `${options.year}-01-10`,
      completion_date: options.year === 2026 ? null : `${options.year}-01-10`,
      expiration_date: null,
      opened_date: `${options.year}-01-01`,
      project_description: "Roof replacement",
      description: "Roof replacement",
      source_system: "lake_clermont_etrakit_permits",
      county_name: "Lake",
      estimated_job_value: null,
      fee: null,
      sourceRecordId: permitNumber,
      sourceUrl: `https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx?activityNo=${permitNumber}`,
      requestedParcelIdentifier: `ALT${options.year}`,
      requestedPropertyId: null,
      workAddress: null,
      isRoofPermit: true,
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
        contractorOfRecord: "EXAMPLE ROOFING",
        contractorOfRecordLicense: "CCC000000",
        licenseDirectorySha256,
      },
    })}\n`,
  );
}

function evidenceHarvester(options: {
  artifactsRoot: string;
  runId: string;
  longCommand?: "enumerate" | "harvest";
  longDelayMs?: number;
  afterLongDelay?: () => Promise<void>;
}): (run: ClermontHarvesterRunOptions) => Promise<void> {
  return async (run) => {
    const command = run.args[0];
    expect(argument(run, "--max-attempts")).toBe("4");
    const jobId = argument(run, "--job-id");
    const year = Number(jobId.slice(-4));
    await writePartitionEvidence({
      artifactsRoot: options.artifactsRoot,
      runId: options.runId,
      year,
      includeRecords: command === "harvest",
    });
    if (command === options.longCommand && year === 2015) {
      await Promise.race([
        delay(options.longDelayMs ?? 1_250),
        new Promise<never>((_resolve, reject) => {
          run.signal.addEventListener("abort", () => reject(run.signal.reason), { once: true });
        }),
      ]);
      await options.afterLongDelay?.();
    }
  };
}

describe("Clermont lease-safe executor", () => {
  it("uses the exact production artifact path without a duplicated data segment", () => {
    expect(clermontLivePartitionRoot("/repo", "lake-run", 2026)).toBe(
      path.join("/repo", "pipeline", "data", "artifacts", "permits", "lake", "lake-run-y2026"),
    );
  });

  it("uses a monotonic elapsed clock even when its injected source regresses", () => {
    const readings = [100, 105, 103, 110];
    const clock = createElapsedClermontClock(NOW, () => readings.shift() ?? 110);
    const values = [clock(), clock(), clock()].map(Date.parse);
    expect(values[1]).toBeGreaterThan(values[0]!);
    expect(values[2]).toBeGreaterThan(values[1]!);
  });

  it("keeps partial evidence fence-specific, publishes only a terminal canonical handoff, and recovers its crash", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-terminal-handoff-"));
    const runId = "lake-clermont-terminal-handoff";
    const harness = await prepareHarness({ scratch, runId });
    const partitionId = "lake-clermont-etrakit-2015";
    await writePartitionEvidence({
      artifactsRoot: harness.artifactsRoot,
      runId,
      year: 2015,
      includeRecords: false,
    });
    const idle = await loadClermontWorker(harness.runStore, runId, partitionId);
    const firstFence = await updateClermontWorker({
      storeRoot: harness.runStore,
      runId,
      partitionId,
      expectedFencingToken: idle.fencingToken,
      update: (current) =>
        acquireClermontWorkerLease({
          worker: current,
          request: harness.prepared.request,
          owner: "partial-fence-worker",
          now: NOW,
        }),
    });
    const partial = await sealClermontPartitionEvidence({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      runId,
      year: 2015,
      owner: "partial-fence-worker",
      fencingToken: firstFence.fencingToken,
      clock: () => "2026-09-11T12:00:00.100Z",
      guard: ACTIVE_GUARD,
      liveArtifactsRoot: harness.artifactsRoot,
    });
    expect(partial.status).toBe("cooling_down");
    const partitionRoot = path.join(
      harness.runStore,
      "runs",
      runId,
      "candidate",
      "partitions",
      "2015",
    );
    const canonicalPath = path.join(partitionRoot, "handoff.json");
    const firstEvidencePath = path.join(
      partitionRoot,
      `fence-${firstFence.fencingToken}`,
      "nonterminal-handoff.json",
    );
    await expect(stat(canonicalPath)).rejects.toThrow();
    const firstEvidence = await readFile(firstEvidencePath, "utf8");
    expect(JSON.parse(firstEvidence)).toMatchObject({
      status: "cooling_down",
      producerLease: { fencingToken: firstFence.fencingToken },
      checkpoint: { terminal: false },
    });

    const cooled = await updateClermontWorker({
      storeRoot: harness.runStore,
      runId,
      partitionId,
      expectedFencingToken: firstFence.fencingToken,
      update: (current) =>
        failClermontWorkerAttempt({
          worker: current,
          request: harness.prepared.request,
          owner: "partial-fence-worker",
          fencingToken: firstFence.fencingToken,
          now: "2026-09-11T12:00:00.200Z",
        }),
    });
    expect(cooled.status).toBe("cooling_down");
    await expect(
      sealClermontPartitionEvidence({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        runId,
        year: 2015,
        owner: "partial-fence-worker",
        fencingToken: firstFence.fencingToken,
        clock: () => "2026-09-11T12:00:00.300Z",
        guard: ACTIVE_GUARD,
        liveArtifactsRoot: harness.artifactsRoot,
      }),
    ).rejects.toThrow(/stale|fencing token/);
    await expect(stat(canonicalPath)).rejects.toThrow();

    await writePartitionEvidence({
      artifactsRoot: harness.artifactsRoot,
      runId,
      year: 2015,
      includeRecords: true,
    });
    const retryAt = new Date(Date.parse(cooled.nextAttemptAt!) + 1).toISOString();
    const secondFence = await updateClermontWorker({
      storeRoot: harness.runStore,
      runId,
      partitionId,
      expectedFencingToken: cooled.fencingToken,
      update: (current) =>
        acquireClermontWorkerLease({
          worker: current,
          request: harness.prepared.request,
          owner: "terminal-fence-worker",
          now: retryAt,
        }),
    });
    const terminal = await sealClermontPartitionEvidence({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      runId,
      year: 2015,
      owner: "terminal-fence-worker",
      fencingToken: secondFence.fencingToken,
      clock: () => retryAt,
      guard: ACTIVE_GUARD,
      liveArtifactsRoot: harness.artifactsRoot,
    });
    expect(terminal).toMatchObject({
      status: "captured_complete",
      producerLease: { fencingToken: secondFence.fencingToken },
      checkpoint: { terminal: true },
    });
    expect(await readFile(firstEvidencePath, "utf8")).toBe(firstEvidence);
    expect(JSON.parse(await readFile(canonicalPath, "utf8"))).toEqual(terminal);

    // Simulate process death after the canonical handoff commit but before the
    // worker completion commit. The restart must fence the abandoned lease,
    // recover from the immutable handoff, and never harvest 2015 again.
    let restartMs = Date.parse(secondFence.leaseExpiresAt!) + 1_000;
    let restarted2015Calls = 0;
    const healthyHarvester = evidenceHarvester({
      artifactsRoot: harness.artifactsRoot,
      runId,
    });
    const recovered = await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "handoff-recovery-worker",
      now: NOW,
      liveFetch: true,
      liveArtifactsRoot: harness.artifactsRoot,
      clock: () => new Date((restartMs += 5)).toISOString(),
      harvesterRunner: async (run) => {
        if (Number(argument(run, "--job-id").slice(-4)) === 2015) restarted2015Calls += 1;
        await healthyHarvester(run);
      },
    });
    expect(recovered.completedYears).toHaveLength(12);
    expect(restarted2015Calls).toBe(0);
    expect((await loadClermontWorker(harness.runStore, runId, partitionId)).status).toBe("idle");
    expect(JSON.parse(await readFile(canonicalPath, "utf8"))).toEqual(terminal);

    const certified = await certifyClermontRun({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      runId,
      now: new Date(restartMs + 60_000).toISOString(),
    });
    expect(certified.baseline.partitions).toHaveLength(12);
    expect(certified.baseline.partitions[0]).toEqual(terminal);
  });

  it("persists FAILED_EXHAUSTED before surfacing one terminal acquisition error", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-terminal-exhaustion-"));
    const runId = "lake-clermont-terminal-exhaustion";
    const harness = await prepareHarness({ scratch, runId, maxAttempts: 1 });
    const healthyHarvester = evidenceHarvester({
      artifactsRoot: harness.artifactsRoot,
      runId,
    });
    let activeMs = Date.parse(NOW) + 1_000;

    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "terminal-exhaustion-worker",
        now: NOW,
        liveFetch: true,
        liveArtifactsRoot: harness.artifactsRoot,
        clock: () => new Date((activeMs += 5)).toISOString(),
        harvesterRunner: async (run) => {
          if (Number(argument(run, "--job-id").slice(-4)) === 2015) {
            throw new Error("injected terminal acquisition failure");
          }
          await healthyHarvester(run);
        },
      }),
    ).rejects.toThrow(/acquisition exhausted.*2015/i);

    expect(
      (await loadClermontWorker(harness.runStore, runId, "lake-clermont-etrakit-2015")).status,
    ).toBe("failed_exhausted");
    const coordinator = await loadClermontCoordinator(harness.runStore, runId);
    expect(coordinator.state).toBe("FAILED_EXHAUSTED");
    expect(coordinator.stages.enumeration.status).toBe("failed_exhausted");
  });

  it("keeps heartbeats single-flight and preserves the first lease error", async () => {
    let concurrent = 0;
    let maximumConcurrent = 0;
    const leaseError = new Error("original lease heartbeat failed");
    let attempts = 0;
    const supervisor = startClermontLeaseSupervisor({
      heartbeatIntervalMs: 5,
      initialCheckpointSha256: "a".repeat(64),
      heartbeat: async () => {
        concurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        await delay(20);
        concurrent -= 1;
        attempts += 1;
        if (attempts === 2) throw leaseError;
      },
    });
    await delay(55);
    await expect(supervisor.stop()).rejects.toBe(leaseError);
    expect(supervisor.signal.reason).toBe(leaseError);
    expect(maximumConcurrent).toBe(1);
  });

  it("serializes a fresh commit heartbeat against timer heartbeats", async () => {
    let concurrentHeartbeats = 0;
    let maximumConcurrent = 0;
    let heartbeatCalls = 0;
    let commitTaskActive = false;
    let heartbeatDuringCommit = false;
    const supervisor = startClermontLeaseSupervisor({
      heartbeatIntervalMs: 5,
      initialCheckpointSha256: "a".repeat(64),
      heartbeat: async () => {
        heartbeatCalls += 1;
        concurrentHeartbeats += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrentHeartbeats);
        heartbeatDuringCommit ||= commitTaskActive;
        await delay(15);
        heartbeatDuringCommit ||= commitTaskActive;
        concurrentHeartbeats -= 1;
      },
    });
    await delay(8);
    await supervisor.guardCommit(async () => {
      commitTaskActive = true;
      await delay(30);
      commitTaskActive = false;
    });
    await supervisor.stop();
    expect(heartbeatCalls).toBeGreaterThanOrEqual(2);
    expect(maximumConcurrent).toBe(1);
    expect(heartbeatDuringCommit).toBe(false);
  });

  it("requires a successful fresh heartbeat before handoff or prune commit", async () => {
    for (const failAt of [1, 2]) {
      const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-commit-heartbeat-"));
      const runId = `lake-clermont-commit-heartbeat-${failAt}`;
      const harness = await prepareHarness({ scratch, runId });
      await writePartitionEvidence({
        artifactsRoot: harness.artifactsRoot,
        runId,
        year: 2015,
        includeRecords: true,
      });
      const partitionId = "lake-clermont-etrakit-2015";
      const idle = await loadClermontWorker(harness.runStore, runId, partitionId);
      const leased = await updateClermontWorker({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        expectedFencingToken: idle.fencingToken,
        update: (current) =>
          acquireClermontWorkerLease({
            worker: current,
            request: harness.prepared.request,
            owner: "commit-heartbeat-worker",
            now: NOW,
          }),
      });
      let elapsedMs = 0;
      const clock = () => {
        elapsedMs += 5;
        return new Date(Date.parse(NOW) + elapsedMs).toISOString();
      };
      let heartbeatCalls = 0;
      const leaseError = new Error(`commit heartbeat ${failAt} failed`);
      const supervisor = startClermontLeaseSupervisor({
        heartbeatIntervalMs: 60_000,
        initialCheckpointSha256: "a".repeat(64),
        heartbeat: async (checkpointSha256) => {
          heartbeatCalls += 1;
          if (heartbeatCalls === failAt) throw leaseError;
          await updateClermontWorker({
            storeRoot: harness.runStore,
            runId,
            partitionId,
            expectedFencingToken: leased.fencingToken,
            update: (current) =>
              heartbeatClermontWorker({
                worker: current,
                request: harness.prepared.request,
                owner: "commit-heartbeat-worker",
                fencingToken: leased.fencingToken,
                checkpointSha256,
                checkpointSignatures: harness.prepared.request.signatures,
                now: clock(),
              }),
          });
        },
      });
      await expect(
        sealClermontPartitionEvidence({
          repoRoot: REPO_ROOT,
          runStore: harness.runStore,
          runId,
          year: 2015,
          owner: "commit-heartbeat-worker",
          fencingToken: leased.fencingToken,
          clock,
          guard: supervisor,
          liveArtifactsRoot: harness.artifactsRoot,
          pruneLooseAfterSeal: true,
        }),
      ).rejects.toBe(leaseError);
      await supervisor.stop().catch(() => undefined);
      const liveRoot = clermontLivePartitionRoot(REPO_ROOT, runId, 2015, harness.artifactsRoot);
      expect(await stat(path.join(liveRoot, "raw"))).toBeTruthy();
      await expect(stat(path.join(liveRoot, "loose-evidence-pruned.json"))).rejects.toThrow();
      const handoffPath = path.join(
        harness.runStore,
        "runs",
        runId,
        "candidate/partitions/2015/handoff.json",
      );
      if (failAt === 1) await expect(stat(handoffPath)).rejects.toThrow();
      else expect(await stat(handoffPath)).toBeTruthy();
    }
  });

  it("accepts only permanent dead evidence bound to the exact enumerated permit", async () => {
    const responseBody = "<html>not found</html>";
    const responseSha256 = sha256Text(responseBody);
    const requestUrl =
      "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx?activityNo=15-0001";
    const validDead = {
      schemaVersion: "elephant.clermont-permanent-dead-evidence.v2",
      permitNumber: "15-0001",
      alternateKey: "ALT2015",
      classification: "permanent",
      errorCode: "source_record_not_found",
      message: "source returned 404",
      observedAt: NOW,
      attempts: [
        {
          attempt: 1,
          maxAttempts: 4,
          observedAt: NOW,
          requestUrl,
          requestMethod: "GET",
          httpStatus: 404,
          responseSha256,
          classification: "permanent",
          errorCode: "source_record_not_found",
        },
      ],
      sourceProof: {
        requestUrl,
        requestMethod: "GET",
        httpStatus: 404,
        responseSha256,
        responseBody,
        observedAt: NOW,
      },
      searchRow: { permitNumber: "15-0001", alternateKey: "ALT2015" },
    };
    const cases = [
      {
        name: "transient-classification",
        mutate: () => ({ ...validDead, classification: "transient" }),
        expected: /not a permanent source failure/,
      },
      {
        name: "wrong-permit",
        mutate: () => {
          const wrongUrl =
            "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx?activityNo=15-9999";
          return {
            ...validDead,
            permitNumber: "15-9999",
            attempts: [{ ...validDead.attempts[0], requestUrl: wrongUrl }],
            sourceProof: { ...validDead.sourceProof, requestUrl: wrongUrl },
            searchRow: { ...validDead.searchRow, permitNumber: "15-9999" },
          };
        },
        expected: /identity mismatch/,
      },
      {
        name: "wrong-search-row",
        mutate: () => ({
          ...validDead,
          searchRow: { ...validDead.searchRow, permitType: "OTHER" },
        }),
        expected: /enumeration row mismatch/,
      },
    ];
    for (const testCase of cases) {
      const scratch = await mkdtemp(path.join(os.tmpdir(), `clermont-dead-${testCase.name}-`));
      const runId = `lake-clermont-dead-${testCase.name}`;
      const harness = await prepareHarness({ scratch, runId });
      await writePartitionEvidence({
        artifactsRoot: harness.artifactsRoot,
        runId,
        year: 2015,
        includeRecords: false,
      });
      const partitionId = "lake-clermont-etrakit-2015";
      const idle = await loadClermontWorker(harness.runStore, runId, partitionId);
      const leased = await updateClermontWorker({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        expectedFencingToken: idle.fencingToken,
        update: (current) =>
          acquireClermontWorkerLease({
            worker: current,
            request: harness.prepared.request,
            owner: "dead-evidence-worker",
            now: NOW,
          }),
      });
      const deadRoot = clermontLivePartitionRoot(REPO_ROOT, runId, 2015, harness.artifactsRoot);
      await writeFile(
        path.join(deadRoot, "dead", "15-0001.json"),
        `${JSON.stringify(testCase.mutate())}\n`,
      );
      await expect(
        sealClermontPartitionEvidence({
          repoRoot: REPO_ROOT,
          runStore: harness.runStore,
          runId,
          year: 2015,
          owner: "dead-evidence-worker",
          fencingToken: leased.fencingToken,
          clock: () => "2026-09-11T12:00:00.100Z",
          guard: ACTIVE_GUARD,
          liveArtifactsRoot: harness.artifactsRoot,
        }),
      ).rejects.toThrow(testCase.expected);
      await expect(
        stat(path.join(harness.runStore, "runs", runId, "candidate/partitions/2015/handoff.json")),
      ).rejects.toThrow();
    }
  });

  it("completes 12 partitions even when total runtime exceeds one lease duration", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-lease-gap-"));
    const runId = "lake-clermont-lease-gap";
    const harness = await prepareHarness({ scratch, runId });
    let elapsedMs = 0;
    const result = await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "lease-gap-worker",
      now: NOW,
      liveFetch: true,
      liveArtifactsRoot: harness.artifactsRoot,
      clock: () => {
        elapsedMs += 100;
        return new Date(Date.parse(NOW) + elapsedMs).toISOString();
      },
      harvesterRunner: evidenceHarvester({ artifactsRoot: harness.artifactsRoot, runId }),
    });
    expect(result.completedYears).toHaveLength(12);
    const first = JSON.parse(
      await readFile(
        path.join(harness.runStore, "runs", runId, "candidate/partitions/2015/handoff.json"),
        "utf8",
      ),
    ) as { createdAt: string };
    const last = JSON.parse(
      await readFile(
        path.join(harness.runStore, "runs", runId, "candidate/partitions/2026/handoff.json"),
        "utf8",
      ),
    ) as { createdAt: string };
    expect(Date.parse(last.createdAt) - Date.parse(first.createdAt)).toBeGreaterThan(1_000);
    const coordinator = await loadClermontCoordinator(harness.runStore, runId);
    expect(coordinator.stages.enumeration.status).toBe("complete");
    expect(coordinator.stages.acquisition.status).toBe("complete");
    expect(coordinator.stages.reconciliation.status).toBe("complete");
    const lifecycleTimes = [
      coordinator.stages.enumeration.updatedAt,
      coordinator.stages.acquisition.updatedAt,
      coordinator.stages.reconciliation.updatedAt,
    ].map(Date.parse);
    expect(lifecycleTimes.every((value) => value > Date.parse(NOW))).toBe(true);
    expect(lifecycleTimes).toEqual([...lifecycleTimes].sort((left, right) => left - right));
  });

  it("renews one lease throughout a child longer than the original lease", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-long-child-"));
    const runId = "lake-clermont-long-child";
    const harness = await prepareHarness({ scratch, runId });
    let heartbeatDuringChild: string | null = null;
    const result = await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "long-child-worker",
      now: NOW,
      liveFetch: true,
      liveArtifactsRoot: harness.artifactsRoot,
      harvesterRunner: evidenceHarvester({
        artifactsRoot: harness.artifactsRoot,
        runId,
        longCommand: "enumerate",
        longDelayMs: 1_250,
        afterLongDelay: async () => {
          heartbeatDuringChild = (
            await loadClermontWorker(harness.runStore, runId, "lake-clermont-etrakit-2015")
          ).heartbeatAt;
        },
      }),
    });
    expect(result.completedYears).toHaveLength(12);
    expect(Date.parse(heartbeatDuringChild!)).toBeGreaterThan(Date.parse(NOW));
  });

  it("renews one lease throughout sealing longer than the original lease", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-long-seal-"));
    const runId = "lake-clermont-long-seal";
    const harness = await prepareHarness({ scratch, runId });
    let delayed = false;
    let heartbeatDuringSeal: string | null = null;
    const result = await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "long-seal-worker",
      now: NOW,
      liveFetch: true,
      liveArtifactsRoot: harness.artifactsRoot,
      harvesterRunner: evidenceHarvester({ artifactsRoot: harness.artifactsRoot, runId }),
      partitionSealer: async (sealOptions) => {
        if (!delayed) {
          delayed = true;
          await delay(1_250);
          heartbeatDuringSeal = (
            await loadClermontWorker(harness.runStore, runId, "lake-clermont-etrakit-2015")
          ).heartbeatAt;
        }
        return sealClermontPartitionEvidence(sealOptions);
      },
    });
    expect(result.completedYears).toHaveLength(12);
    expect(Date.parse(heartbeatDuringSeal!)).toBeGreaterThan(Date.parse(NOW));
  });

  it("aborts on takeover and lets the stale owner neither hand off, prune, fail, nor complete", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-takeover-"));
    const runId = "lake-clermont-takeover";
    const harness = await prepareHarness({ scratch, runId });
    let takeoverAt = "";
    const takeoverRunner = async (run: ClermontHarvesterRunOptions): Promise<void> => {
      const jobId = argument(run, "--job-id");
      const year = Number(jobId.slice(-4));
      await writePartitionEvidence({
        artifactsRoot: harness.artifactsRoot,
        runId,
        year,
        includeRecords: true,
      });
      const partitionId = `lake-clermont-etrakit-${year}`;
      const first = await loadClermontWorker(harness.runStore, runId, partitionId);
      takeoverAt = new Date(Date.parse(first.leaseExpiresAt!) + 1).toISOString();
      await updateClermontWorker({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        expectedFencingToken: first.fencingToken,
        update: (current) =>
          acquireClermontWorkerLease({
            worker: current,
            request: harness.prepared.request,
            owner: "takeover-worker",
            now: takeoverAt,
          }),
      });
      await new Promise<never>((_resolve, reject) => {
        run.signal.addEventListener("abort", () => reject(run.signal.reason), { once: true });
      });
    };
    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "stale-worker",
        now: NOW,
        liveFetch: true,
        liveArtifactsRoot: harness.artifactsRoot,
        harvesterRunner: takeoverRunner,
      }),
    ).rejects.toThrow(/fencing token failed/);

    const handoffPath = path.join(
      harness.runStore,
      "runs",
      runId,
      "candidate/partitions/2015/handoff.json",
    );
    await expect(stat(handoffPath)).rejects.toThrow();
    await expect(
      sealClermontPartitionEvidence({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        runId,
        year: 2015,
        owner: "stale-worker",
        fencingToken: 1,
        clock: () => takeoverAt,
        guard: ACTIVE_GUARD,
        liveArtifactsRoot: harness.artifactsRoot,
        pruneLooseAfterSeal: true,
      }),
    ).rejects.toThrow(/stale|fencing token/);
    const liveRoot = clermontLivePartitionRoot(REPO_ROOT, runId, 2015, harness.artifactsRoot);
    expect(await stat(path.join(liveRoot, "raw"))).toBeTruthy();

    for (const terminal of ["fail", "complete"] as const) {
      await expect(
        updateClermontWorker({
          storeRoot: harness.runStore,
          runId,
          partitionId: "lake-clermont-etrakit-2015",
          expectedFencingToken: 1,
          update: (current) =>
            terminal === "fail"
              ? failClermontWorkerAttempt({
                  worker: current,
                  request: harness.prepared.request,
                  owner: "stale-worker",
                  fencingToken: 1,
                  now: takeoverAt,
                })
              : completeClermontWorkerAttempt({
                  worker: current,
                  owner: "stale-worker",
                  fencingToken: 1,
                  now: takeoverAt,
                }),
        }),
      ).rejects.toThrow(/fencing token failed/);
    }
  });

  it("escalates a timed-out child from SIGTERM to SIGKILL", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-sigkill-"));
    const scriptPath = path.join(scratch, "ignore-term.mjs");
    const logPath = path.join(scratch, "harvester.log");
    await writeFile(
      scriptPath,
      [
        'process.on("SIGTERM", () => process.stdout.write("term-observed\\n"));',
        "setInterval(() => undefined, 1_000);",
      ].join("\n"),
    );
    const controller = new AbortController();
    const started = Date.now();
    await expect(
      runClermontHarvesterProcess({
        scriptPath,
        args: [],
        logPath,
        timeoutMs: 100,
        terminationGraceMs: 100,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await readFile(logPath, "utf8")).toContain("term-observed");
  });

  it("treats stale and future audit timestamps as audit data, not lease time", async () => {
    for (const [index, auditNow] of [
      "2000-01-01T00:00:00.000Z",
      "2099-01-01T00:00:00.000Z",
    ].entries()) {
      const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-audit-clock-"));
      const runId = `lake-clermont-audit-clock-${index}`;
      const harness = await prepareHarness({ scratch, runId });
      let elapsedMs = 1_000;
      const result = await runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "audit-clock-worker",
        now: auditNow,
        liveFetch: true,
        liveArtifactsRoot: harness.artifactsRoot,
        clock: () => {
          elapsedMs += 5;
          return new Date(Date.parse(NOW) + elapsedMs).toISOString();
        },
        harvesterRunner: evidenceHarvester({ artifactsRoot: harness.artifactsRoot, runId }),
      });
      expect(result.completedYears).toHaveLength(12);
    }
  });

  it("rejects an active clock behind a persisted heartbeat before the harvester", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-clock-behind-"));
    const runId = "lake-clermont-clock-behind";
    const harness = await prepareHarness({ scratch, runId });
    const idle = await loadClermontWorker(harness.runStore, runId, "lake-clermont-etrakit-2015");
    await updateClermontWorker({
      storeRoot: harness.runStore,
      runId,
      partitionId: idle.partitionId,
      expectedFencingToken: idle.fencingToken,
      update: (current) =>
        acquireClermontWorkerLease({
          worker: current,
          request: harness.prepared.request,
          owner: "future-heartbeat-worker",
          now: "2026-09-11T12:00:10.000Z",
        }),
    });
    let harvesterCalls = 0;
    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "clock-behind-worker",
        now: "2099-01-01T00:00:00.000Z",
        liveFetch: true,
        clock: () => "2026-09-11T12:00:01.000Z",
        harvesterRunner: async () => {
          harvesterCalls += 1;
        },
      }),
    ).rejects.toThrow(/earlier than a persisted worker heartbeat/);
    expect(harvesterCalls).toBe(0);
  });

  it("rechecks manual cost authorization at execution and consumes it once for recovery", async () => {
    const expiredScratch = await mkdtemp(path.join(os.tmpdir(), "clermont-expired-cost-"));
    const expiredRunId = "lake-clermont-expired-cost";
    const expired = await prepareHarness({
      scratch: expiredScratch,
      runId: expiredRunId,
      authorizationExpiresAt: "2026-09-11T12:00:10.000Z",
    });
    let harvesterCalls = 0;
    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: expired.runStore,
        baselineStore: null,
        runId: expiredRunId,
        owner: "expired-cost-worker",
        now: NOW,
        liveFetch: true,
        clock: () => "2026-09-11T12:00:11.000Z",
        harvesterRunner: async () => {
          harvesterCalls += 1;
        },
      }),
    ).rejects.toThrow(/authorization is missing, expired, or mismatched/);
    expect(harvesterCalls).toBe(0);

    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-consumed-cost-"));
    const runId = "lake-clermont-consumed-cost";
    const harness = await prepareHarness({
      scratch,
      runId,
      authorizationExpiresAt: "2026-09-11T12:00:10.000Z",
    });
    let firstElapsed = 1_000;
    await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "authorized-cost-worker",
      now: NOW,
      liveFetch: true,
      liveArtifactsRoot: harness.artifactsRoot,
      clock: () => {
        firstElapsed += 5;
        return new Date(Date.parse(NOW) + firstElapsed).toISOString();
      },
      harvesterRunner: evidenceHarvester({ artifactsRoot: harness.artifactsRoot, runId }),
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(
            harness.runStore,
            "runs",
            runId,
            "authorization/execution-cost-consumption.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ runId });
    let recoveredHarvesterCalls = 0;
    const recovered = await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "authorized-recovery-worker",
      now: "2000-01-01T00:00:00.000Z",
      liveFetch: true,
      clock: () => "2026-09-11T12:00:11.000Z",
      harvesterRunner: async () => {
        recoveredHarvesterCalls += 1;
      },
    });
    expect(recovered.completedYears).toHaveLength(12);
    expect(recoveredHarvesterCalls).toBe(0);
  });

  it("anchors post-crash authorization recovery to ledger consumption and cannot revive an expired budget", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-ledger-budget-crash-"));
    const runId = "lake-clermont-ledger-budget-crash";
    const harness = await prepareHarness({
      scratch,
      runId,
      authorizationExpiresAt: "2026-09-11T12:00:10.000Z",
    });
    const authorization = harness.prepared.request.authorization!;
    const coordinator = await loadClermontCoordinator(harness.runStore, runId);
    const consumedAt = "2026-09-11T12:00:01.000Z";
    const ledgerReceipt = {
      schemaVersion: "elephant.clermont-execution-cost-authorization.v2",
      authorizationId: authorization.authorizationId,
      runId,
      requestSha256: harness.prepared.requestSha256,
      provenanceSha256: harness.prepared.provenanceSha256,
      estimateSha256: coordinator.estimate.estimateSha256,
      approvalSha256: sha256Text(canonicalJson(authorization)),
      consumedAt,
    };
    const ledgerDirectory = path.join(harness.runStore, "authorization-ledger");
    await mkdir(ledgerDirectory, { recursive: true });
    await writeFile(
      path.join(ledgerDirectory, `${authorization.authorizationId}.json`),
      `${canonicalJson(ledgerReceipt)}\n`,
    );

    let harvesterCalls = 0;
    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "post-crash-expired-budget-worker",
        now: NOW,
        liveFetch: true,
        clock: () => "2026-09-13T12:00:02.000Z",
        harvesterRunner: async () => {
          harvesterCalls += 1;
        },
      }),
    ).rejects.toThrow(/exceeded its approved total budget/);
    expect(harvesterCalls).toBe(0);
    const authorizationDirectory = path.join(harness.runStore, "runs", runId, "authorization");
    expect(
      JSON.parse(
        await readFile(
          path.join(authorizationDirectory, "execution-cost-consumption.json"),
          "utf8",
        ),
      ),
    ).toEqual(ledgerReceipt);
    const budget = JSON.parse(
      await readFile(path.join(authorizationDirectory, "execution-budget.json"), "utf8"),
    ) as { startedAt: string; deadlineAt: string; maximumExecutionHours: number };
    expect(budget.startedAt).toBe(consumedAt);
    expect(Date.parse(budget.deadlineAt) - Date.parse(budget.startedAt)).toBeCloseTo(
      budget.maximumExecutionHours * 60 * 60 * 1_000,
      0,
    );
  });

  it("recovers the ledger-only crash window after approval expiry without resetting its budget", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-ledger-only-recovery-"));
    const runId = "lake-clermont-ledger-only-recovery";
    const harness = await prepareHarness({
      scratch,
      runId,
      authorizationExpiresAt: "2026-09-11T12:00:10.000Z",
    });
    const authorization = harness.prepared.request.authorization!;
    const coordinator = await loadClermontCoordinator(harness.runStore, runId);
    const consumedAt = "2026-09-11T12:00:01.000Z";
    const ledgerReceipt = {
      schemaVersion: "elephant.clermont-execution-cost-authorization.v2",
      authorizationId: authorization.authorizationId,
      runId,
      requestSha256: harness.prepared.requestSha256,
      provenanceSha256: harness.prepared.provenanceSha256,
      estimateSha256: coordinator.estimate.estimateSha256,
      approvalSha256: sha256Text(canonicalJson(authorization)),
      consumedAt,
    };
    const ledgerDirectory = path.join(harness.runStore, "authorization-ledger");
    await mkdir(ledgerDirectory, { recursive: true });
    await writeFile(
      path.join(ledgerDirectory, `${authorization.authorizationId}.json`),
      `${canonicalJson(ledgerReceipt)}\n`,
    );

    let harvesterCalls = 0;
    const result = await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "ledger-only-recovery-worker",
      now: NOW,
      liveFetch: true,
      clock: () => "2026-09-11T12:00:11.000Z",
      harvesterRunner: async (run) => {
        expect(argument(run, "--max-attempts")).toBe("4");
        harvesterCalls += 1;
        throw new Error("intentional post-gate stop");
      },
    });
    expect(harvesterCalls).toBe(12);
    expect(result.pendingYears).toHaveLength(12);
    const authorizationDirectory = path.join(harness.runStore, "runs", runId, "authorization");
    expect(
      JSON.parse(
        await readFile(
          path.join(authorizationDirectory, "execution-cost-consumption.json"),
          "utf8",
        ),
      ),
    ).toEqual(ledgerReceipt);
    expect(
      JSON.parse(
        await readFile(path.join(authorizationDirectory, "execution-budget.json"), "utf8"),
      ),
    ).toMatchObject({ startedAt: consumedAt });
  });

  it("rejects prepared authorization tampering before consumption or harvesting", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-tampered-approval-"));
    const runId = "lake-clermont-tampered-approval";
    const harness = await prepareHarness({
      scratch,
      runId,
      authorizationExpiresAt: "2026-09-11T13:00:00.000Z",
    });
    const preparedPath = path.join(harness.runStore, "runs", runId, "prepared.json");
    const prepared = JSON.parse(await readFile(preparedPath, "utf8")) as ClermontPreparedRun;
    await writeFile(
      preparedPath,
      `${JSON.stringify({
        ...prepared,
        template: { ...prepared.template, authorization: null },
      })}\n`,
    );

    let harvesterCalls = 0;
    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "tampered-approval-worker",
        now: NOW,
        liveFetch: true,
        clock: () => "2026-09-11T12:00:01.000Z",
        harvesterRunner: async () => {
          harvesterCalls += 1;
        },
      }),
    ).rejects.toThrow(/Prepared request must equal every request-bearing template field/);
    expect(harvesterCalls).toBe(0);
    await expect(
      stat(
        path.join(
          harness.runStore,
          "runs",
          runId,
          "authorization",
          "execution-cost-consumption.json",
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects a store-wide authorization nonce consumed by another run", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-replayed-approval-"));
    const runId = "lake-clermont-replayed-approval";
    const harness = await prepareHarness({
      scratch,
      runId,
      authorizationExpiresAt: "2026-09-11T13:00:00.000Z",
    });
    const authorization = harness.prepared.request.authorization!;
    const ledgerDirectory = path.join(harness.runStore, "authorization-ledger");
    await mkdir(ledgerDirectory, { recursive: true });
    await writeFile(
      path.join(ledgerDirectory, `${authorization.authorizationId}.json`),
      `${JSON.stringify({
        schemaVersion: "elephant.clermont-execution-cost-authorization.v2",
        authorizationId: authorization.authorizationId,
        runId: "lake-clermont-another-run",
        requestSha256: "a".repeat(64),
        provenanceSha256: "b".repeat(64),
        estimateSha256: authorization.estimateSha256,
        approvalSha256: "c".repeat(64),
        consumedAt: "2026-09-11T11:59:59.000Z",
      })}\n`,
    );

    let harvesterCalls = 0;
    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "replayed-approval-worker",
        now: NOW,
        liveFetch: true,
        clock: () => "2026-09-11T12:00:01.000Z",
        harvesterRunner: async () => {
          harvesterCalls += 1;
        },
      }),
    ).rejects.toThrow(/nonce was already consumed by another run/);
    expect(harvesterCalls).toBe(0);
  });

  it("aborts at the durable total execution deadline before starting another partition", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-execution-budget-"));
    const runId = "lake-clermont-execution-budget";
    const harness = await prepareHarness({ scratch, runId });
    let activeTime = "2026-09-11T12:00:01.000Z";
    let harvesterCalls = 0;

    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "budget-worker",
        now: NOW,
        liveFetch: true,
        liveArtifactsRoot: harness.artifactsRoot,
        clock: () => activeTime,
        harvesterRunner: async () => {
          harvesterCalls += 1;
          activeTime = "2026-09-13T12:00:02.000Z";
        },
      }),
    ).rejects.toThrow(/exceeded its approved total budget/);
    expect(harvesterCalls).toBe(1);
    const budget = JSON.parse(
      await readFile(
        path.join(harness.runStore, "runs", runId, "authorization", "execution-budget.json"),
        "utf8",
      ),
    ) as { startedAt: string; deadlineAt: string };
    expect(budget.startedAt).toBe("2026-09-11T12:00:01.000Z");
    expect(budget.deadlineAt).toBe("2026-09-13T12:00:01.000Z");
  });

  it("rejects a resumed clock earlier than a budget persisted before the first worker", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-budget-clock-regression-"));
    const runId = "lake-clermont-budget-clock-regression";
    const harness = await prepareHarness({ scratch, runId });
    const coordinator = await loadClermontCoordinator(harness.runStore, runId);
    const request = harness.prepared.request;
    const nonRunnerEstimatedCost = Math.max(
      0,
      coordinator.estimate.estimatedCostUsd -
        coordinator.estimate.estimatedHours * request.limits.runnerHourlyUsd,
    );
    const costBoundedHours =
      request.limits.runnerHourlyUsd === 0
        ? request.limits.maxAutomaticHours
        : (request.limits.costCeilingUsd - nonRunnerEstimatedCost) / request.limits.runnerHourlyUsd;
    const maximumExecutionHours = Math.min(request.limits.maxAutomaticHours, costBoundedHours);
    const budgetDirectory = path.join(harness.runStore, "runs", runId, "authorization");
    await mkdir(budgetDirectory, { recursive: true });
    await writeFile(
      path.join(budgetDirectory, "execution-budget.json"),
      `${JSON.stringify({
        schemaVersion: "elephant.clermont-execution-budget.v1",
        runId,
        requestSha256: harness.prepared.requestSha256,
        provenanceSha256: harness.prepared.provenanceSha256,
        estimateSha256: coordinator.estimate.estimateSha256,
        startedAt: NOW,
        deadlineAt: new Date(
          Date.parse(NOW) + maximumExecutionHours * 60 * 60 * 1_000,
        ).toISOString(),
        maximumExecutionHours,
        maximumCostUsd: request.limits.costCeilingUsd,
      })}\n`,
    );
    let harvesterCalls = 0;
    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "regressed-budget-clock-worker",
        now: NOW,
        liveFetch: true,
        clock: () => "2026-09-11T11:59:59.000Z",
        harvesterRunner: async () => {
          harvesterCalls += 1;
        },
      }),
    ).rejects.toThrow(/predates the durable execution budget/);
    expect(harvesterCalls).toBe(0);
  });

  it("uses active execution time for baseline freshness", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-stale-baseline-"));
    const seed = await prepareHarness({ scratch, runId: "lake-clermont-baseline-seed" });
    const baselineStore = path.join(scratch, "baseline-store");
    const artifactRoot = path.join(scratch, "baseline-candidate");
    await writeSyntheticClermontArtifacts(artifactRoot);
    const baseline = syntheticClermontBaseline({
      signatures: seed.prepared.request.signatures,
      certifiedAt: "2026-09-11T11:00:00.000Z",
      expiresAt: "2026-09-11T13:00:00.000Z",
    });
    const pointer = await promoteCertifiedClermontBaseline({
      storeRoot: baselineStore,
      candidateArtifactRoot: artifactRoot,
      candidate: baseline,
      now: NOW,
      expectedSignatures: baseline.signatures,
      expectedPriorSha256: null,
    });
    expect(pointer.baselineSha256).toBe(clermontBaselineDigest(baseline));
    const incremental = await prepareHarness({
      scratch: path.join(scratch, "incremental"),
      runId: "lake-clermont-stale-incremental",
      refreshMode: "incremental",
      baselineSha256: pointer.baselineSha256,
      baselineStore,
    });
    let harvesterCalls = 0;
    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: incremental.runStore,
        baselineStore,
        runId: "lake-clermont-stale-incremental",
        owner: "stale-baseline-worker",
        now: "2000-01-01T00:00:00.000Z",
        liveFetch: true,
        clock: () => "2026-09-11T14:00:00.000Z",
        harvesterRunner: async () => {
          harvesterCalls += 1;
        },
      }),
    ).rejects.toThrow(/stale|maximum age|expired/);
    expect(harvesterCalls).toBe(0);
  });

  it("enforces prepared signatures and legal worker transitions at the store boundary", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-store-invariants-"));
    const runId = "lake-clermont-store-invariants";
    const harness = await prepareHarness({ scratch, runId });
    const partitionId = "lake-clermont-etrakit-2015";
    const idle = await loadClermontWorker(harness.runStore, runId, partitionId);
    await expect(
      updateClermontWorker({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        expectedFencingToken: idle.fencingToken,
        update: (current) => ({ ...current, attempts: current.attempts + 1 }),
      }),
    ).rejects.toThrow(/attempts can advance only/);
    const leased = await updateClermontWorker({
      storeRoot: harness.runStore,
      runId,
      partitionId,
      expectedFencingToken: idle.fencingToken,
      update: (current) =>
        acquireClermontWorkerLease({
          worker: current,
          request: harness.prepared.request,
          owner: "invariant-worker",
          now: NOW,
        }),
    });
    expect(() =>
      acquireClermontWorkerLease({
        worker: leased,
        request: harness.prepared.request,
        owner: "backdated-acquisition-worker",
        now: "2026-09-11T11:59:59.000Z",
      }),
    ).toThrow(/cannot predate its prior heartbeat/);
    await expect(
      updateClermontWorker({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        expectedFencingToken: leased.fencingToken,
        update: (current) => ({
          ...current,
          leaseOwner: "forged-takeover-worker",
          fencingToken: current.fencingToken + 1,
          attempts: current.attempts + 1,
          heartbeatAt: "2026-09-11T12:00:00.100Z",
          leaseExpiresAt: "2026-09-11T12:00:02.100Z",
        }),
      }),
    ).rejects.toThrow(/cannot predate its heartbeat, expiry, or cooldown/);
    await expect(
      updateClermontWorker({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        expectedFencingToken: leased.fencingToken,
        update: (current) => ({ ...current, fencingToken: current.fencingToken + 2 }),
      }),
    ).rejects.toThrow(/advance exactly once/);
    await expect(
      updateClermontWorker({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        expectedFencingToken: leased.fencingToken,
        update: (current) => ({
          ...current,
          leaseOwner: "forged-same-token-owner",
          heartbeatAt: "2026-09-11T12:00:00.100Z",
          leaseExpiresAt: "2026-09-11T12:01:00.100Z",
        }),
      }),
    ).rejects.toThrow(/same-token worker renewal/);
    await expect(
      updateClermontWorker({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        expectedFencingToken: leased.fencingToken,
        update: (current) => ({
          ...current,
          heartbeatAt: "2026-09-11T11:59:59.000Z",
        }),
      }),
    ).rejects.toThrow(/cannot move backwards/);

    const workerPath = path.join(harness.runStore, "runs", runId, "workers", `${partitionId}.json`);
    await writeFile(
      workerPath,
      `${JSON.stringify({
        ...leased,
        signatures: { ...leased.signatures, schemaSha256: "f".repeat(64) },
      })}\n`,
    );
    await expect(
      updateClermontWorker({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        expectedFencingToken: leased.fencingToken,
        update: (current) => current,
      }),
    ).rejects.toThrow(/signatures drifted/);
    await expect(
      withClermontWorkerFence({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        owner: "invariant-worker",
        fencingToken: leased.fencingToken,
        clock: () => "2026-09-11T12:00:00.100Z",
        task: async () => undefined,
      }),
    ).rejects.toThrow(/signatures drifted/);
    await expect(
      writeFencedClermontRunArtifact({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        owner: "invariant-worker",
        fencingToken: leased.fencingToken,
        clock: () => "2026-09-11T12:00:00.100Z",
        relativePath: "candidate/signature-drift.json",
        value: () => ({ invalid: true }),
      }),
    ).rejects.toThrow(/signatures drifted/);
  });

  it("waits through ordinary contention and never reaps a live same-host holder by age", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-lock-safety-"));
    const runId = "lake-clermont-lock-safety";
    const harness = await prepareHarness({ scratch, runId });
    const partitionId = "lake-clermont-etrakit-2015";
    const idle = await loadClermontWorker(harness.runStore, runId, partitionId);
    const leased = await updateClermontWorker({
      storeRoot: harness.runStore,
      runId,
      partitionId,
      expectedFencingToken: idle.fencingToken,
      update: (current) =>
        acquireClermontWorkerLease({
          worker: current,
          request: harness.prepared.request,
          owner: "lock-worker",
          now: NOW,
        }),
    });
    const held = withClermontWorkerFence({
      storeRoot: harness.runStore,
      runId,
      partitionId,
      owner: "lock-worker",
      fencingToken: leased.fencingToken,
      clock: () => "2026-09-11T12:00:00.100Z",
      task: async () => delay(150),
    });
    await delay(20);
    const heartbeat = updateClermontWorker({
      storeRoot: harness.runStore,
      runId,
      partitionId,
      expectedFencingToken: leased.fencingToken,
      update: (current) =>
        heartbeatClermontWorker({
          worker: current,
          request: harness.prepared.request,
          owner: "lock-worker",
          fencingToken: leased.fencingToken,
          checkpointSha256: "a".repeat(64),
          checkpointSignatures: harness.prepared.request.signatures,
          now: "2026-09-11T12:00:00.200Z",
        }),
    });
    await expect(Promise.all([held, heartbeat])).resolves.toBeTruthy();

    const runDirectory = path.join(harness.runStore, "runs", runId);
    const old = await acquireClermontRunLock(runDirectory);
    const stale = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(path.join(runDirectory, "coordinator.lock"), stale, stale);
    await expect(
      acquireClermontRunLock(runDirectory, { acquireTimeoutMs: 50, staleMs: 1 }),
    ).rejects.toThrow(/Timed out/);
    const owner = JSON.parse(
      await readFile(path.join(runDirectory, "coordinator.lock", "owner.json"), "utf8"),
    ) as { token: string; pid: number; hostname: string };
    expect(owner).toMatchObject({ token: old.token, pid: process.pid, hostname: os.hostname() });
    await old.release();
  });

  it("asserts ownership before a paused fenced task writes after takeover", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-paused-lock-owner-"));
    const runId = "lake-clermont-paused-lock-owner";
    const harness = await prepareHarness({ scratch, runId });
    const partitionId = "lake-clermont-etrakit-2015";
    const idle = await loadClermontWorker(harness.runStore, runId, partitionId);
    const leased = await updateClermontWorker({
      storeRoot: harness.runStore,
      runId,
      partitionId,
      expectedFencingToken: idle.fencingToken,
      update: (current) =>
        acquireClermontWorkerLease({
          worker: current,
          request: harness.prepared.request,
          owner: "paused-lock-worker",
          now: NOW,
        }),
    });
    let announcePaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      announcePaused = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const target = path.join(scratch, "must-not-be-written.json");
    const held = withClermontWorkerFence({
      storeRoot: harness.runStore,
      runId,
      partitionId,
      owner: "paused-lock-worker",
      fencingToken: leased.fencingToken,
      clock: () => "2026-09-11T12:00:00.100Z",
      task: async (_worker, _fencedAt, assertRunLockOwned) => {
        announcePaused();
        await resumed;
        await assertRunLockOwned();
        await writeFile(target, "forbidden\n");
      },
    });
    await paused;
    const runDirectory = path.join(harness.runStore, "runs", runId);
    const lockPath = path.join(runDirectory, "coordinator.lock");
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
    const replacementToken = "forced-remote-takeover";
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${canonicalJson({
        token: replacementToken,
        pid: 999_999,
        hostname: "different-host",
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );
    resume();
    await expect(held).rejects.toThrow(/lock ownership was lost/);
    await expect(stat(target)).rejects.toThrow();
    const replacement = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as {
      token: string;
    };
    expect(replacement.token).toBe(replacementToken);
    await rm(lockPath, { recursive: true, force: true });
  });

  it("does not commit durable worker state after ownership changes following its read", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-prewrite-lock-fence-"));
    const runId = "lake-clermont-prewrite-lock-fence";
    const harness = await prepareHarness({ scratch, runId });
    const partitionId = "lake-clermont-etrakit-2015";
    const before = await loadClermontWorker(harness.runStore, runId, partitionId);
    const runDirectory = path.join(harness.runStore, "runs", runId);
    const lockPath = path.join(runDirectory, "coordinator.lock");
    const replacementToken = "replacement-before-worker-commit";

    await expect(
      updateClermontWorker({
        storeRoot: harness.runStore,
        runId,
        partitionId,
        expectedFencingToken: before.fencingToken,
        update: (current) => {
          rmSync(lockPath, { recursive: true, force: true });
          mkdirSync(lockPath);
          writeFileSync(
            path.join(lockPath, "owner.json"),
            `${canonicalJson({
              token: replacementToken,
              pid: 999_999,
              hostname: "different-host",
              acquiredAt: new Date().toISOString(),
            })}\n`,
          );
          return acquireClermontWorkerLease({
            worker: current,
            request: harness.prepared.request,
            owner: "must-not-commit-worker",
            now: NOW,
          });
        },
      }),
    ).rejects.toThrow(/lock ownership was lost/);
    expect(await loadClermontWorker(harness.runStore, runId, partitionId)).toEqual(before);
    expect(
      (JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { token: string })
        .token,
    ).toBe(replacementToken);
    await rm(lockPath, { recursive: true, force: true });
  });

  it("renews owned run-lock liveness without weakening the ownership token", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-lock-renewal-"));
    const runDirectory = path.join(scratch, "runs", "lake-clermont-lock-renewal");
    const lock = await acquireClermontRunLock(runDirectory);
    const lockPath = path.join(runDirectory, "coordinator.lock");
    const stale = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(lockPath, stale, stale);
    await lock.assertOwned();
    const renewed = await stat(lockPath);
    expect(renewed.mtimeMs).toBeGreaterThan(stale.getTime());
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as {
      token: string;
    };
    expect(owner.token).toBe(lock.token);
    await lock.release();
  });

  it("reaps a stale same-host lock only when its recorded process is dead", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-dead-lock-owner-"));
    const runDirectory = path.join(scratch, "runs", "lake-clermont-dead-lock-owner");
    const lockPath = path.join(runDirectory, "coordinator.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${canonicalJson({
        token: "dead-lock-owner",
        pid: 999_999,
        hostname: os.hostname(),
        acquiredAt: NOW,
      })}\n`,
    );
    const stale = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(lockPath, stale, stale);

    const replacement = await acquireClermontRunLock(runDirectory, {
      acquireTimeoutMs: 250,
      staleMs: 1,
    });
    expect(replacement.token).not.toBe("dead-lock-owner");
    await replacement.release();
  });

  it("recovers a crashed stale reaper directory before acquiring the run lock", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-stale-reaper-"));
    const runDirectory = path.join(scratch, "runs", "lake-clermont-stale-reaper");
    const reaperPath = path.join(runDirectory, "coordinator.lock.reaper");
    await mkdir(reaperPath, { recursive: true });
    await writeFile(
      path.join(reaperPath, "owner.json"),
      `${JSON.stringify({ token: "crashed-reaper", pid: 999_999, acquiredAt: NOW })}\n`,
    );
    const stale = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(reaperPath, stale, stale);
    const lock = await acquireClermontRunLock(runDirectory);
    expect(await stat(path.join(runDirectory, "coordinator.lock", "owner.json"))).toBeTruthy();
    await lock.release();
    await expect(stat(reaperPath)).rejects.toThrow();
  });

  it("rejects wrong or corrupt terminal handoffs before recovery completion", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-recovery-validation-"));
    const runId = "lake-clermont-recovery-validation";
    const harness = await prepareHarness({ scratch, runId });
    await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "recovery-source-worker",
      now: NOW,
      liveFetch: true,
      liveArtifactsRoot: harness.artifactsRoot,
      harvesterRunner: evidenceHarvester({ artifactsRoot: harness.artifactsRoot, runId }),
    });
    const handoffPath = path.join(
      harness.runStore,
      "runs",
      runId,
      "candidate/partitions/2015/handoff.json",
    );
    const originalText = await readFile(handoffPath, "utf8");
    const original = JSON.parse(originalText) as {
      runId: string;
      artifacts: { raw: { logicalPath: string } };
    };
    await writeFile(
      handoffPath,
      `${JSON.stringify({ ...original, runId: "wrong-recovery-run" })}\n`,
    );
    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "recovery-validator",
        now: NOW,
        liveFetch: true,
        clock: () => "2026-09-12T12:10:00.000Z",
        harvesterRunner: async () => undefined,
      }),
    ).rejects.toThrow(/identity or signatures disagree/);
    await writeFile(handoffPath, originalText);
    await writeFile(
      path.join(harness.runStore, "runs", runId, "candidate", original.artifacts.raw.logicalPath),
      "corrupt",
      { flag: "a" },
    );
    await expect(
      runClermontAcquisition({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        baselineStore: null,
        runId,
        owner: "recovery-validator",
        now: NOW,
        liveFetch: true,
        clock: () => "2026-09-12T12:10:00.000Z",
        harvesterRunner: async () => undefined,
      }),
    ).rejects.toThrow(/failed digest readback/);
  });

  it("cancels archive construction before a handoff when the supervisor fails", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-archive-abort-"));
    const runId = "lake-clermont-archive-abort";
    const harness = await prepareHarness({ scratch, runId });
    await writePartitionEvidence({
      artifactsRoot: harness.artifactsRoot,
      runId,
      year: 2015,
      includeRecords: true,
    });
    const idle = await loadClermontWorker(harness.runStore, runId, "lake-clermont-etrakit-2015");
    const leased = await updateClermontWorker({
      storeRoot: harness.runStore,
      runId,
      partitionId: idle.partitionId,
      expectedFencingToken: idle.fencingToken,
      update: (current) =>
        acquireClermontWorkerLease({
          worker: current,
          request: harness.prepared.request,
          owner: "archive-abort-worker",
          now: NOW,
        }),
    });
    const leaseError = new Error("lease failed during archive construction");
    let checks = 0;
    const guard = {
      leaseError: null as Error | null,
      async assertActive() {
        checks += 1;
        if (checks >= 3) {
          this.leaseError = leaseError;
          throw leaseError;
        }
      },
      throwIfFailed() {
        if (this.leaseError !== null) throw this.leaseError;
      },
      async guardCommit<T>(task: () => Promise<T>): Promise<T> {
        await this.assertActive();
        return task();
      },
    };
    await expect(
      sealClermontPartitionEvidence({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        runId,
        year: 2015,
        owner: "archive-abort-worker",
        fencingToken: leased.fencingToken,
        clock: () => "2026-09-11T12:00:00.100Z",
        guard,
        liveArtifactsRoot: harness.artifactsRoot,
      }),
    ).rejects.toBe(leaseError);
    await expect(
      stat(path.join(harness.runStore, "runs", runId, "candidate/partitions/2015/handoff.json")),
    ).rejects.toThrow();
  });

  it("does not let a stale owner delete quarantined loose evidence", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-stale-prune-delete-"));
    const runId = "lake-clermont-stale-prune-delete";
    const harness = await prepareHarness({ scratch, runId });
    await writePartitionEvidence({
      artifactsRoot: harness.artifactsRoot,
      runId,
      year: 2015,
      includeRecords: true,
    });
    const partitionId = "lake-clermont-etrakit-2015";
    const idle = await loadClermontWorker(harness.runStore, runId, partitionId);
    const leased = await updateClermontWorker({
      storeRoot: harness.runStore,
      runId,
      partitionId,
      expectedFencingToken: idle.fencingToken,
      update: (current) =>
        acquireClermontWorkerLease({
          worker: current,
          request: harness.prepared.request,
          owner: "stale-prune-worker",
          now: NOW,
        }),
    });
    let elapsedMs = 0;
    const clock = () => {
      elapsedMs += 5;
      return new Date(Date.parse(NOW) + elapsedMs).toISOString();
    };
    const supervisor = startClermontLeaseSupervisor({
      heartbeatIntervalMs: 60_000,
      initialCheckpointSha256: "a".repeat(64),
      heartbeat: async (checkpointSha256) => {
        await updateClermontWorker({
          storeRoot: harness.runStore,
          runId,
          partitionId,
          expectedFencingToken: leased.fencingToken,
          update: (current) =>
            heartbeatClermontWorker({
              worker: current,
              request: harness.prepared.request,
              owner: "stale-prune-worker",
              fencingToken: leased.fencingToken,
              checkpointSha256,
              checkpointSignatures: harness.prepared.request.signatures,
              now: clock(),
            }),
        });
      },
    });
    await expect(
      sealClermontPartitionEvidence({
        repoRoot: REPO_ROOT,
        runStore: harness.runStore,
        runId,
        year: 2015,
        owner: "stale-prune-worker",
        fencingToken: leased.fencingToken,
        clock,
        guard: supervisor,
        liveArtifactsRoot: harness.artifactsRoot,
        pruneLooseAfterSeal: true,
        afterPruneQuarantined: async () => {
          const current = await loadClermontWorker(harness.runStore, runId, partitionId);
          const takeoverAt = new Date(Date.parse(current.leaseExpiresAt!) + 1).toISOString();
          await updateClermontWorker({
            storeRoot: harness.runStore,
            runId,
            partitionId,
            expectedFencingToken: current.fencingToken,
            update: (worker) =>
              acquireClermontWorkerLease({
                worker,
                request: harness.prepared.request,
                owner: "replacement-prune-worker",
                now: takeoverAt,
              }),
          });
        },
      }),
    ).rejects.toThrow(/fencing token failed/);
    await supervisor.stop().catch(() => undefined);
    const liveRoot = clermontLivePartitionRoot(REPO_ROOT, runId, 2015, harness.artifactsRoot);
    expect(await stat(path.join(liveRoot, ".pruned", "fence-1", "raw"))).toBeTruthy();
    expect(
      JSON.parse(await readFile(path.join(liveRoot, "loose-evidence-pruned.json"), "utf8")),
    ).toMatchObject({ status: "quarantined" });
  });

  it("resumes an idempotent prune journal after a crash", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-prune-recovery-"));
    const runId = "lake-clermont-prune-recovery";
    const harness = await prepareHarness({ scratch, runId });
    let crashed = false;
    let elapsedMs = 1_000;
    const first = await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "prune-crash-worker",
      now: NOW,
      liveFetch: true,
      pruneLooseAfterSeal: true,
      liveArtifactsRoot: harness.artifactsRoot,
      clock: () => {
        elapsedMs += 5;
        return new Date(Date.parse(NOW) + elapsedMs).toISOString();
      },
      harvesterRunner: evidenceHarvester({ artifactsRoot: harness.artifactsRoot, runId }),
      partitionSealer: async (sealOptions) =>
        sealClermontPartitionEvidence({
          ...sealOptions,
          ...(sealOptions.year === 2015 && !crashed
            ? {
                afterPruneQuarantined: async () => {
                  crashed = true;
                  throw new Error("injected prune crash");
                },
              }
            : {}),
        }),
    });
    expect(first.pendingYears).toContain(2015);
    const liveRoot = clermontLivePartitionRoot(REPO_ROOT, runId, 2015, harness.artifactsRoot);
    expect(
      JSON.parse(await readFile(path.join(liveRoot, "loose-evidence-pruned.json"), "utf8")),
    ).toMatchObject({ status: "quarantined", year: 2015 });
    expect(await stat(path.join(liveRoot, ".pruned", "fence-1", "raw"))).toBeTruthy();

    let recoveryMs = 60_000;
    const recovered = await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "prune-recovery-worker",
      now: "2099-01-01T00:00:00.000Z",
      liveFetch: true,
      liveArtifactsRoot: harness.artifactsRoot,
      clock: () => {
        recoveryMs += 5;
        return new Date(Date.parse(NOW) + recoveryMs).toISOString();
      },
      harvesterRunner: async () => undefined,
    });
    expect(recovered.completedYears).toHaveLength(12);
    expect(
      JSON.parse(await readFile(path.join(liveRoot, "loose-evidence-pruned.json"), "utf8")),
    ).toMatchObject({
      status: "deleted",
      recoveredBy: { owner: "prune-recovery-worker", fencingToken: 2 },
    });
    await expect(stat(path.join(liveRoot, ".pruned"))).rejects.toThrow();

    let idempotentMs = 120_000;
    const idempotent = await runClermontAcquisition({
      repoRoot: REPO_ROOT,
      runStore: harness.runStore,
      baselineStore: null,
      runId,
      owner: "prune-idempotent-worker",
      now: "2000-01-01T00:00:00.000Z",
      liveFetch: true,
      liveArtifactsRoot: harness.artifactsRoot,
      clock: () => {
        idempotentMs += 5;
        return new Date(Date.parse(NOW) + idempotentMs).toISOString();
      },
      harvesterRunner: async () => undefined,
    });
    expect(idempotent.completedYears).toHaveLength(12);
  });
});
