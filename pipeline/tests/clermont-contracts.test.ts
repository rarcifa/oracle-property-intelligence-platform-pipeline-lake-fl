import { describe, expect, it } from "vitest";

import {
  CLERMONT_PARTITION_HANDOFF_SCHEMA_VERSION,
  clermontPartitionHandoffSchema,
  clermontRunRequestSchema,
} from "../src/batch/clermont-contracts.js";
import {
  assertPartitionCanComplete,
  reconcileClermontPartitionRecords,
} from "../src/batch/clermont-coordinator.js";
import {
  clermontSignatures,
  syntheticClermontBaseline,
  syntheticClermontRequest,
} from "./clermont-batch-fixtures.js";

const digest = (value: string) => value.repeat(64);

function evidence(options: {
  id: string;
  disposition: "completed" | "proven-dead" | "retryable-pending";
  linkage?: "linked" | "valid-unlinked" | null;
  contractor?: boolean;
  license?: boolean;
  open?: boolean;
}) {
  const completed = options.disposition === "completed";
  return {
    stableId: `lake:clermont:etrakit:${options.id}`,
    disposition: options.disposition,
    linkage: completed ? (options.linkage ?? "linked") : null,
    contractorPresent: completed && (options.contractor ?? false),
    licensePresent: completed && (options.license ?? false),
    open: completed && (options.open ?? false),
    rawSha256: options.disposition === "retryable-pending" ? null : digest("a"),
    extractedSha256: completed ? digest("b") : null,
    statusSha256: digest("c"),
  };
}

describe("Clermont immutable ingestion contracts", () => {
  it("requires the complete ordered 2015-2026 source boundary", () => {
    const request = syntheticClermontRequest();
    expect(request.requestedYears).toEqual([
      2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
    ]);
    expect(() =>
      clermontRunRequestSchema.parse({
        ...request,
        requestedYears: request.requestedYears.slice(1),
      }),
    ).toThrow(/2015 through 2026|at least 12|expected array to have/);
  });

  it("reconciles stable IDs, valid unmatched records, and evidence independently", () => {
    const reconciled = reconcileClermontPartitionRecords([
      evidence({
        id: "26-0001",
        disposition: "completed",
        linkage: "linked",
        contractor: true,
        license: true,
        open: true,
      }),
      evidence({
        id: "26-0002",
        disposition: "completed",
        linkage: "valid-unlinked",
      }),
      evidence({ id: "26-0003", disposition: "proven-dead" }),
      evidence({ id: "26-0004", disposition: "retryable-pending" }),
    ]);

    expect(reconciled.counts).toEqual({
      enumerated: 4,
      completed: 2,
      provenDead: 1,
      retryablePending: 1,
      linked: 1,
      validUnlinked: 1,
      withContractor: 1,
      withLicense: 1,
      open: 1,
      rawEvidence: 3,
      extractedEvidence: 2,
      statusEvidence: 4,
    });
    expect(reconciled.openPermitStableIds).toEqual(["lake:clermont:etrakit:26-0001"]);
    expect(reconciled.stableIdsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      reconcileClermontPartitionRecords([
        evidence({ id: "26-0001", disposition: "completed" }),
        evidence({ id: "26-0001", disposition: "completed" }),
      ]),
    ).toThrow(/duplicate stable permit IDs/);
  });

  it("cannot mark capped, truncated, or retryable work complete", () => {
    const baseline = syntheticClermontBaseline();
    const partition = baseline.partitions[0]!;
    expect(() =>
      clermontPartitionHandoffSchema.parse({
        ...partition,
        schemaVersion: CLERMONT_PARTITION_HANDOFF_SCHEMA_VERSION,
        cappedOrTruncated: true,
      }),
    ).toThrow(/capped or truncated partition cannot be complete/);

    expect(() =>
      assertPartitionCanComplete({
        counts: { ...partition.counts, retryablePending: 1 },
        cappedOrTruncated: false,
      }),
    ).toThrow(/remain pending/);
  });

  it("rejects incompatible checkpoint signatures", () => {
    const partition = syntheticClermontBaseline().partitions[0]!;
    expect(() =>
      clermontPartitionHandoffSchema.parse({
        ...partition,
        checkpoint: {
          ...partition.checkpoint,
          signatures: {
            ...clermontSignatures,
            schemaSha256: digest("d"),
          },
        },
      }),
    ).toThrow(/Checkpoint signatures must match/);
  });

  it("binds the point-in-time license directory to the exact partition artifact", () => {
    const partition = syntheticClermontBaseline().partitions[0]!;
    expect(partition.licenseDirectory.validityBoundary).toBe(
      "contractor-registration-at-capture-not-historical-license-validity",
    );
    expect(partition.licenseDirectory.sha256).toBe(partition.artifacts.licenseDirectory.sha256);
    expect(() =>
      clermontPartitionHandoffSchema.parse({
        ...partition,
        licenseDirectory: {
          ...partition.licenseDirectory,
          sha256: digest("d"),
        },
      }),
    ).toThrow(/provenance must bind the exact immutable artifact digest/);
    expect(() =>
      clermontPartitionHandoffSchema.parse({
        ...partition,
        licenseDirectory: {
          ...partition.licenseDirectory,
          capturedAt: "2026-09-11T08:11:00.000Z",
        },
      }),
    ).toThrow(/capture cannot postdate/);
  });
});
