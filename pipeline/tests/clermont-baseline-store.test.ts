import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadLastGoodClermontBaseline,
  promoteCertifiedClermontBaseline,
  requireClermontBaselineForPublication,
} from "../src/batch/clermont-baseline-store.js";
import { sha256Text } from "../src/batch/contracts.js";
import { clermontBaselineDigest } from "../src/batch/clermont-contracts.js";
import {
  clermontSignatures,
  syntheticClermontBaseline,
  writeSyntheticClermontArtifacts,
} from "./clermont-batch-fixtures.js";

const NOW = "2026-09-11T09:00:00.000Z";

describe("Clermont certified last-good baseline store", () => {
  it("fails before publication when no certified baseline exists", async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), "clermont-missing-"));
    await expect(
      requireClermontBaselineForPublication({
        storeRoot,
        now: NOW,
        maxAgeHours: 24 * 7,
        expectedSignatures: clermontSignatures,
        expectedSha256: "a".repeat(64),
      }),
    ).rejects.toThrow(/No certified Clermont last-good baseline exists/);
  });

  it("preserves last-good when a replacement acquisition is incomplete", async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), "clermont-preserve-"));
    const artifactRoot = path.join(storeRoot, "candidate");
    await writeSyntheticClermontArtifacts(artifactRoot);
    const original = syntheticClermontBaseline();
    const originalPointer = await promoteCertifiedClermontBaseline({
      storeRoot,
      candidateArtifactRoot: artifactRoot,
      candidate: original,
      now: NOW,
      expectedSignatures: clermontSignatures,
      expectedPriorSha256: null,
    });
    const pointerBefore = await readFile(path.join(storeRoot, "last-good.json"), "utf8");

    const incomplete = structuredClone(original);
    incomplete.baselineId = "lake-clermont-baseline-incomplete-20260911";
    incomplete.certifiedAt = "2026-09-11T08:45:00.000Z";
    incomplete.partitions[0]!.cappedOrTruncated = true;

    await expect(
      promoteCertifiedClermontBaseline({
        storeRoot,
        candidateArtifactRoot: artifactRoot,
        candidate: incomplete,
        now: NOW,
        expectedSignatures: clermontSignatures,
        expectedPriorSha256: originalPointer.baselineSha256,
      }),
    ).rejects.toThrow(/capped or truncated partition cannot be complete/);

    expect(await readFile(path.join(storeRoot, "last-good.json"), "utf8")).toBe(pointerBefore);
    const loaded = await loadLastGoodClermontBaseline({
      storeRoot,
      now: NOW,
      maxAgeHours: 24 * 7,
      expectedSignatures: clermontSignatures,
      expectedSha256: originalPointer.baselineSha256,
    });
    expect(clermontBaselineDigest(loaded.baseline)).toBe(clermontBaselineDigest(original));
  });

  it("preserves last-good when merged-export metadata is invalid", async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), "clermont-meta-preserve-"));
    const artifactRoot = path.join(storeRoot, "candidate");
    await writeSyntheticClermontArtifacts(artifactRoot);
    const original = syntheticClermontBaseline();
    const originalPointer = await promoteCertifiedClermontBaseline({
      storeRoot,
      candidateArtifactRoot: artifactRoot,
      candidate: original,
      now: NOW,
      expectedSignatures: clermontSignatures,
      expectedPriorSha256: null,
    });
    const pointerBefore = await readFile(path.join(storeRoot, "last-good.json"), "utf8");

    const invalidMetadata = "{}\n";
    await writeFile(
      path.join(artifactRoot, original.mergedExport.metadata.logicalPath),
      invalidMetadata,
    );
    const replacement = structuredClone(original);
    replacement.baselineId = "lake-clermont-baseline-invalid-meta-20260911";
    replacement.certifiedAt = "2026-09-11T08:45:00.000Z";
    replacement.mergedExport.metadata.sha256 = sha256Text(invalidMetadata);
    replacement.mergedExport.metadata.bytes = Buffer.byteLength(invalidMetadata);

    await expect(
      promoteCertifiedClermontBaseline({
        storeRoot,
        candidateArtifactRoot: artifactRoot,
        candidate: replacement,
        now: NOW,
        expectedSignatures: clermontSignatures,
        expectedPriorSha256: originalPointer.baselineSha256,
      }),
    ).rejects.toThrow(/merged-export metadata is invalid/);
    expect(await readFile(path.join(storeRoot, "last-good.json"), "utf8")).toBe(pointerBefore);
  });

  it("uses compare-and-swap fencing when promoting a newer certified baseline", async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), "clermont-fenced-"));
    const artifactRoot = path.join(storeRoot, "candidate");
    await writeSyntheticClermontArtifacts(artifactRoot);
    const original = syntheticClermontBaseline();
    const originalPointer = await promoteCertifiedClermontBaseline({
      storeRoot,
      candidateArtifactRoot: artifactRoot,
      candidate: original,
      now: NOW,
      expectedSignatures: clermontSignatures,
      expectedPriorSha256: null,
    });
    const newer = syntheticClermontBaseline({
      certifiedAt: "2026-09-11T08:50:00.000Z",
      expiresAt: "2026-09-18T08:50:00.000Z",
      openYears: [2019, 2026],
    });
    newer.baselineId = "lake-clermont-baseline-20260911-r2";

    await expect(
      promoteCertifiedClermontBaseline({
        storeRoot,
        candidateArtifactRoot: artifactRoot,
        candidate: newer,
        now: NOW,
        expectedSignatures: clermontSignatures,
        expectedPriorSha256: "f".repeat(64),
      }),
    ).rejects.toThrow(/unfenced promotion/);

    const nextPointer = await promoteCertifiedClermontBaseline({
      storeRoot,
      candidateArtifactRoot: artifactRoot,
      candidate: newer,
      now: NOW,
      expectedSignatures: clermontSignatures,
      expectedPriorSha256: originalPointer.baselineSha256,
    });
    expect(nextPointer.baselineSha256).not.toBe(originalPointer.baselineSha256);
    expect(
      (
        await requireClermontBaselineForPublication({
          storeRoot,
          now: NOW,
          maxAgeHours: 24 * 7,
          expectedSignatures: clermontSignatures,
          expectedSha256: nextPointer.baselineSha256,
        })
      ).baselineId,
    ).toBe("lake-clermont-baseline-20260911-r2");
  });

  it("serializes competing promotions and recovers an already-applied exact candidate", async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), "clermont-concurrent-fenced-"));
    const artifactRoot = path.join(storeRoot, "candidate");
    await writeSyntheticClermontArtifacts(artifactRoot);
    const original = syntheticClermontBaseline();
    const originalPointer = await promoteCertifiedClermontBaseline({
      storeRoot,
      candidateArtifactRoot: artifactRoot,
      candidate: original,
      now: NOW,
      expectedSignatures: clermontSignatures,
      expectedPriorSha256: null,
    });
    const candidates = [
      syntheticClermontBaseline({
        certifiedAt: "2026-09-11T08:50:00.000Z",
        expiresAt: "2026-09-18T08:50:00.000Z",
        openYears: [2018, 2026],
      }),
      syntheticClermontBaseline({
        certifiedAt: "2026-09-11T08:51:00.000Z",
        expiresAt: "2026-09-18T08:51:00.000Z",
        openYears: [2019, 2026],
      }),
    ];
    candidates[0]!.baselineId = "lake-clermont-baseline-concurrent-a";
    candidates[1]!.baselineId = "lake-clermont-baseline-concurrent-b";

    const results = await Promise.allSettled(
      candidates.map((candidate) =>
        promoteCertifiedClermontBaseline({
          storeRoot,
          candidateArtifactRoot: artifactRoot,
          candidate,
          now: NOW,
          expectedSignatures: clermontSignatures,
          expectedPriorSha256: originalPointer.baselineSha256,
        }),
      ),
    );
    const successes = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof promoteCertifiedClermontBaseline>>
      > => result.status === "fulfilled",
    );
    const failures = results.filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(String((failures[0] as PromiseRejectedResult).reason)).toMatch(/unfenced promotion/);

    const winner = successes[0]!.value;
    const winningCandidate = candidates.find(
      (candidate) => clermontBaselineDigest(candidate) === winner.baselineSha256,
    )!;
    const recovered = await promoteCertifiedClermontBaseline({
      storeRoot,
      candidateArtifactRoot: artifactRoot,
      candidate: winningCandidate,
      now: "2026-09-11T09:05:00.000Z",
      expectedSignatures: clermontSignatures,
      expectedPriorSha256: originalPointer.baselineSha256,
    });
    expect(recovered).toEqual(winner);
  });

  it("rejects stale and incompatible last-good artifacts", async () => {
    const staleStore = await mkdtemp(path.join(os.tmpdir(), "clermont-stale-"));
    const artifactRoot = path.join(staleStore, "candidate");
    await writeSyntheticClermontArtifacts(artifactRoot);
    const stale = syntheticClermontBaseline({
      certifiedAt: "2026-08-01T08:00:00.000Z",
      expiresAt: "2026-09-20T08:00:00.000Z",
    });
    await expect(
      promoteCertifiedClermontBaseline({
        storeRoot: staleStore,
        candidateArtifactRoot: artifactRoot,
        candidate: stale,
        now: NOW,
        expectedSignatures: clermontSignatures,
        expectedPriorSha256: null,
      }),
    ).rejects.toThrow(/older than the configured freshness boundary/);
  });
});
