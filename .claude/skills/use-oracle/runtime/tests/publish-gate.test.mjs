/**
 * The approval gate that governs publication.
 *
 * `county-open-data-publish` and `durable-workflow-builder` pattern 10 specify
 * the state machine: an unapproved attempt dry-runs and LEAVES pending true,
 * approve() is a human action, pending clears ONLY after a successful approved
 * publication, and an unapproved attempt proves a given content watermark once
 * rather than rebuilding it on a loop. Each of those clauses is a test here,
 * because a gate that is not exercised is a gate nobody knows is closed.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  approvePublish,
  evaluatePublishGate,
  PUBLISH_GATE_SCHEMA_VERSION,
  readCountyGate,
  recordDryRun,
  recordPublication,
  requestPublish,
  revokePublishApproval,
  validatePublishGate,
} from "../src/core/publish-gate.mjs";

const temporaryDirectories = [];
const WATERMARK = "bafybeibshsx6h6xtbqb65at6oycndtpp3ufdou5i5unahulvtn46n4fr4m";
const NEXT_WATERMARK = "bafybeif5vpiyp2v5foc7k3swsgoujzlvo7exaspntdsrmc4tp5vkuok67q";

/** @returns {Promise<string>} path to a gate file in a fresh scratch directory */
async function scratchGatePath() {
  const directory = await mkdtemp(path.join(tmpdir(), "oracle-publish-gate-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "artifacts", "publish-gate.json");
}

const approval = { approvedBy: "Ricardo Arcifa", note: "Lake County 2026 roll to public IPFS" };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("the gate's default posture", () => {
  it("is closed for a county nobody has approved", async () => {
    const gatePath = await scratchGatePath();
    const state = await readCountyGate(gatePath, "lake");
    expect(state).toMatchObject({ pending: false, approved: false, approvedBy: null });
    expect(evaluatePublishGate(state, WATERMARK).action).toBe("dry-run");
  });
});

describe("an unapproved publish attempt", () => {
  it("dry-runs and leaves the county pending", async () => {
    const gatePath = await scratchGatePath();
    await requestPublish(gatePath, "lake");
    const requested = await readCountyGate(gatePath, "lake");
    expect(requested.pending).toBe(true);
    expect(evaluatePublishGate(requested, WATERMARK).action).toBe("dry-run");

    const afterDryRun = await recordDryRun(gatePath, "lake", WATERMARK);
    // The clause that matters: a dry run does NOT clear pending.
    expect(afterDryRun.pending).toBe(true);
    expect(afterDryRun.lastPublishedWatermark).toBeNull();
  });

  it("proves a given content watermark once, then stops rebuilding it", async () => {
    const gatePath = await scratchGatePath();
    await requestPublish(gatePath, "lake");
    await recordDryRun(gatePath, "lake", WATERMARK);
    const state = await readCountyGate(gatePath, "lake");
    expect(evaluatePublishGate(state, WATERMARK).action).toBe("skip");
    // New content is new evidence, so it is worth proving once too.
    expect(evaluatePublishGate(state, NEXT_WATERMARK).action).toBe("dry-run");
  });

  it("cannot record a publication, because it cannot have uploaded one", async () => {
    const gatePath = await scratchGatePath();
    await requestPublish(gatePath, "lake");
    await expect(
      recordPublication(gatePath, "lake", { watermark: WATERMARK, runId: "20260910T153418Z" }),
    ).rejects.toThrow(/the gate is not approved/);
  });
});

describe("approval", () => {
  it("opens the gate and names who opened it and why", async () => {
    const gatePath = await scratchGatePath();
    const state = await approvePublish(gatePath, "lake", approval);
    expect(state).toMatchObject({
      approved: true,
      approvedBy: "Ricardo Arcifa",
      approvalNote: "Lake County 2026 roll to public IPFS",
    });
    expect(evaluatePublishGate(state, WATERMARK)).toMatchObject({ action: "publish" });
  });

  it("refuses an anonymous or unexplained approval", async () => {
    const gatePath = await scratchGatePath();
    await expect(approvePublish(gatePath, "lake", { approvedBy: "", note: "x" })).rejects.toThrow(
      /name the human/,
    );
    await expect(approvePublish(gatePath, "lake", { approvedBy: "x", note: "" })).rejects.toThrow(
      /record what was approved/,
    );
  });

  it("re-arms the dry-run throttle so the next run acts on the approval", async () => {
    const gatePath = await scratchGatePath();
    await requestPublish(gatePath, "lake");
    await recordDryRun(gatePath, "lake", WATERMARK);
    const approved = await approvePublish(gatePath, "lake", approval);
    expect(approved.lastDryRunWatermark).toBeNull();
    expect(evaluatePublishGate(approved, WATERMARK).action).toBe("publish");
  });
});

describe("an approved publication", () => {
  it("is the only thing that clears pending", async () => {
    const gatePath = await scratchGatePath();
    await requestPublish(gatePath, "lake");
    await approvePublish(gatePath, "lake", approval);
    expect((await readCountyGate(gatePath, "lake")).pending).toBe(true);

    const released = await recordPublication(gatePath, "lake", {
      watermark: WATERMARK,
      runId: "20260910T153418Z",
    });
    expect(released.pending).toBe(false);
    expect(released.lastPublishedWatermark).toBe(WATERMARK);
    expect(released.lastPublishedRunId).toBe("20260910T153418Z");
  });

  it("is not repeated for content that is already released", async () => {
    const gatePath = await scratchGatePath();
    await approvePublish(gatePath, "lake", approval);
    await recordPublication(gatePath, "lake", { watermark: WATERMARK, runId: "20260910T153418Z" });
    const state = await readCountyGate(gatePath, "lake");
    // Same bytes, same CID: re-uploading proves nothing and costs a CAR upload.
    expect(evaluatePublishGate(state, WATERMARK).action).toBe("published");
    // Newly ingested content is a new publication.
    expect(evaluatePublishGate(state, NEXT_WATERMARK).action).toBe("publish");
  });
});

describe("revocation", () => {
  it("closes the gate again", async () => {
    const gatePath = await scratchGatePath();
    await approvePublish(gatePath, "lake", approval);
    const revoked = await revokePublishApproval(gatePath, "lake");
    expect(revoked.approved).toBe(false);
    expect(evaluatePublishGate(revoked, NEXT_WATERMARK).action).toBe("dry-run");
  });
});

describe("the gate document", () => {
  it("is validated, versioned, and keeps other counties untouched", async () => {
    const gatePath = await scratchGatePath();
    await approvePublish(gatePath, "lake", approval);
    await requestPublish(gatePath, "duval");
    const document = JSON.parse(await readFile(gatePath, "utf8"));
    expect(document.schemaVersion).toBe(PUBLISH_GATE_SCHEMA_VERSION);
    expect(Object.keys(document.counties).sort()).toEqual(["duval", "lake"]);
    expect(document.counties.lake.approved).toBe(true);
    expect(document.counties.duval.approved).toBe(false);
    expect(() => validatePublishGate(document)).not.toThrow();
  });

  it("refuses a document it cannot trust", () => {
    expect(() => validatePublishGate({ schemaVersion: "elephant.publish-gate.v2", counties: {} })).toThrow(
      /schemaVersion/,
    );
    expect(() =>
      validatePublishGate({ schemaVersion: PUBLISH_GATE_SCHEMA_VERSION, counties: {}, extra: true }),
    ).toThrow(/Invalid publish gate/);
  });
});
