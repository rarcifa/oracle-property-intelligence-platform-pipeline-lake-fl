import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  materializeClermontIngestionBaseline,
  parseClermontMaterializeCliArgs,
  parseClermontPlanCliArgs,
  planClermontIngestion,
} from "../bin/clermont-ingestion.js";
import { promoteCertifiedClermontBaseline } from "../src/batch/clermont-baseline-store.js";
import {
  clermontSignatures,
  syntheticClermontBaseline,
  syntheticClermontRequest,
  writeSyntheticClermontArtifacts,
} from "./clermont-batch-fixtures.js";

describe("Clermont local-only planning command", () => {
  it("emits a bounded full-refresh cost and throughput plan without a baseline", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-plan-"));
    const requestPath = path.join(scratch, "request.json");
    await writeFile(
      requestPath,
      `${JSON.stringify(syntheticClermontRequest({ refreshMode: "full" }))}\n`,
      "utf8",
    );
    const args = parseClermontPlanCliArgs([
      "plan",
      "--request",
      requestPath,
      "--now",
      "2026-09-11T09:00:00.000Z",
    ]);
    const state = await planClermontIngestion(args);

    expect(state.state).toBe("READY");
    expect(state.estimate.expectedRecords).toBe(150);
    expect(state.estimate.expectedRequests).toBeGreaterThan(150);
    expect(state.estimate.expectedRawBytes).toBe(150 * 4096);
    expect(state.estimate.safeConcurrency).toBe(2);
  });

  it("fails incremental planning before work when the last-good store is absent", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-plan-"));
    const requestPath = path.join(scratch, "request.json");
    await writeFile(requestPath, `${JSON.stringify(syntheticClermontRequest())}\n`, "utf8");
    await expect(
      planClermontIngestion(
        parseClermontPlanCliArgs([
          "plan",
          "--request",
          requestPath,
          "--now",
          "2026-09-11T09:00:00.000Z",
        ]),
      ),
    ).rejects.toThrow(/requires --baseline-store/);
  });

  it("materializes the exact verified merged export and its reconciled metadata", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-materialize-"));
    const storeRoot = path.join(scratch, "store");
    const artifactRoot = path.join(scratch, "candidate");
    const outputPath = path.join(scratch, "output", "clermont-permits.csv");
    await writeSyntheticClermontArtifacts(artifactRoot);
    const baseline = syntheticClermontBaseline();
    await promoteCertifiedClermontBaseline({
      storeRoot,
      candidateArtifactRoot: artifactRoot,
      candidate: baseline,
      now: "2026-09-11T09:00:00.000Z",
      expectedSignatures: clermontSignatures,
      expectedPriorSha256: null,
    });
    const requestPath = path.join(scratch, "request.json");
    await writeFile(
      requestPath,
      `${JSON.stringify(syntheticClermontRequest({ baseline }))}\n`,
      "utf8",
    );
    const result = await materializeClermontIngestionBaseline(
      parseClermontMaterializeCliArgs([
        "materialize-last-good",
        "--request",
        requestPath,
        "--baseline-store",
        storeRoot,
        "--output",
        outputPath,
        "--now",
        "2026-09-11T09:00:00.000Z",
      ]),
    );
    expect(result.rows).toBe(24);
    expect(await readFile(outputPath, "utf8")).toContain("permit_number,alternate_key");
    const metadata = JSON.parse(await readFile(outputPath.replace(/\.csv$/, ".meta.json"), "utf8"));
    expect(metadata).toMatchObject({
      permitYears: ["15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26"],
      enumeratedPermits: 24,
      deadPermits: 0,
      achievablePermits: 24,
      loadedPermits: 24,
    });
    expect(result.metadataPath).toBe(outputPath.replace(/\.csv$/, ".meta.json"));
  });
});
