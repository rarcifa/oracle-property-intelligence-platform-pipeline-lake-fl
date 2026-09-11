import { describe, expect, it } from "vitest";

import {
  assertCompleteClermontPublicationEvidence,
  clermontBaselineSha256,
} from "../scripts/lake/build-publish-set.mjs";

const years = Array.from({ length: 12 }, (_, index) => 2015 + index);
const signatures = {
  sourceSha256: "1".repeat(64),
  configurationSha256: "2".repeat(64),
  schemaSha256: "3".repeat(64),
};

function evidence() {
  return {
    schemaVersion: "elephant.clermont-permit-certified-baseline.v1",
    baselineId: "lake-clermont-baseline-20260911",
    county: "lake",
    jurisdiction: "clermont",
    sourceSystem: "lake_clermont_etrakit_permits",
    requiredHistory: { firstYear: 2015, lastYear: 2026 },
    certifiedAt: "2026-09-11T10:00:00.000Z",
    expiresAt: "2026-09-18T10:00:00.000Z",
    status: "certified",
    evidenceSha256: "4".repeat(64),
    signatures,
    partitions: years.map((year) => ({
      runId: "lake-clermont-capture-20260911",
      year,
      status: "captured_complete",
      cappedOrTruncated: false,
      counts: {
        enumerated: 11,
        completed: 10,
        provenDead: 1,
        retryablePending: 0,
        linked: 9,
        validUnlinked: 1,
        rawEvidence: 11,
        extractedEvidence: 10,
        statusEvidence: 11,
      },
      checkpoint: { terminal: true },
      signatures,
    })),
    mergedExport: {
      artifact: { sha256: "5".repeat(64) },
      metadata: { sha256: "6".repeat(64) },
      rows: 120,
    },
  };
}

function metadata() {
  return {
    schemaVersion: "elephant.clermont-permit-load-meta.v1",
    permitYears: years.map((year) => String(year).slice(-2)),
    enumeratedPermits: 132,
    deadPermits: 12,
    achievablePermits: 120,
    loadedPermits: 120,
  };
}

function options(overrides = {}) {
  const certified = evidence();
  return {
    metadata: metadata(),
    evidence: certified,
    csvRows: 120,
    csvSha256: "5".repeat(64),
    metadataSha256: "6".repeat(64),
    requiredBaselineSha256: clermontBaselineSha256(certified),
    ...overrides,
  };
}

describe("Clermont publication evidence gate", () => {
  it("accepts exactly twelve reconciled certified partitions and matching export bytes", () => {
    expect(assertCompleteClermontPublicationEvidence(options())).toEqual({
      baselineSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidenceSha256: "4".repeat(64),
    });
  });

  it("rejects a self-consistent one-year export", () => {
    const incomplete = metadata();
    incomplete.permitYears = ["26"];
    incomplete.enumeratedPermits = 11;
    incomplete.deadPermits = 1;
    incomplete.achievablePermits = 10;
    incomplete.loadedPermits = 10;
    expect(() =>
      assertCompleteClermontPublicationEvidence({
        ...options(),
        metadata: incomplete,
        csvRows: 10,
      }),
    ).toThrow(/exact permit years 2015-2026/);
  });

  it("rejects incomplete reconciliation and materialized bytes that differ from certification", () => {
    const pending = evidence();
    pending.partitions[4].status = "running";
    expect(() =>
      assertCompleteClermontPublicationEvidence({
        ...options(),
        evidence: pending,
      }),
    ).toThrow(/partition 2019 lacks complete reconciled evidence/);

    expect(() =>
      assertCompleteClermontPublicationEvidence({
        ...options(),
        csvSha256: "9".repeat(64),
      }),
    ).toThrow(/bytes do not match/);
  });

  it("rejects evidence that is not the baseline digest named by the operator request", () => {
    expect(() =>
      assertCompleteClermontPublicationEvidence({
        ...options(),
        requiredBaselineSha256: "9".repeat(64),
      }),
    ).toThrow(/exact requested baseline digest/);
  });
});
