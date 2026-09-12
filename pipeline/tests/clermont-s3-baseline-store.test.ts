import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, type STSClient } from "@aws-sdk/client-sts";
import { afterEach, describe, expect, it } from "vitest";

import { promoteCertifiedClermontBaseline } from "../src/batch/clermont-baseline-store.js";
import {
  CLERMONT_BASELINE_POINTER_SCHEMA_VERSION,
  CLERMONT_REMOTE_STORAGE_LIMIT_BYTES,
} from "../src/batch/clermont-contracts.js";
import {
  syncPromoteClermontBaselineToS3,
  type ClermontS3PromotionReceipt,
} from "../src/batch/clermont-s3-baseline-store.js";
import { canonicalJson } from "../src/batch/contracts.js";
import {
  clermontSignatures,
  syntheticClermontBaseline,
  writeSyntheticClermontArtifacts,
} from "./clermont-batch-fixtures.js";

const NOW = "2026-09-11T09:00:00.000Z";
const ACCOUNT_ID = "122610508924";
const BUCKET = "clermont-baseline-test-bucket";
const PREFIX = "clermont";

interface StoredObject {
  body: Buffer;
  metadata: Record<string, string>;
  etag: string;
  listedSize?: number;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body === undefined || body === null) throw new Error("Test S3 PUT body is missing");
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function missingObject(): Error {
  return Object.assign(new Error("Not found"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function failedPrecondition(): Error {
  return Object.assign(new Error("Precondition failed"), {
    name: "PreconditionFailed",
    $metadata: { httpStatusCode: 412 },
  });
}

class MemoryS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly versions: Array<{ key: string; size: number; versionId: string }> = [];
  putCount = 0;
  failNextBaselinePut = false;
  private revision = 0;
  private pointerBarrier:
    | { reads: number; promise: Promise<void>; release: () => void }
    | undefined;

  enableConcurrentMissingPointerReads(): void {
    let release = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pointerBarrier = { reads: 0, promise, release };
  }

  seed(
    key: string,
    body: string,
    metadata: Record<string, string> = {},
    listedSize?: number,
  ): void {
    const stored = {
      body: Buffer.from(body),
      metadata,
      etag: `seed-${++this.revision}`,
      listedSize,
    };
    this.objects.set(key, stored);
    this.versions.push({
      key,
      size: listedSize ?? stored.body.length,
      versionId: `version-${this.revision}`,
    });
  }

  seedHistoricalVersion(key: string, size: number): void {
    this.versions.push({ key, size, versionId: `version-${++this.revision}` });
  }

  async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof HeadObjectCommand) {
      if (command.input.ExpectedBucketOwner !== ACCOUNT_ID) {
        throw new Error("Expected bucket owner was not bound");
      }
      const stored = this.objects.get(command.input.Key!);
      if (stored === undefined) throw missingObject();
      return {
        ContentLength: stored.body.length,
        Metadata: stored.metadata,
        ETag: `"${stored.etag}"`,
      };
    }
    if (command instanceof GetObjectCommand) {
      if (command.input.ExpectedBucketOwner !== ACCOUNT_ID) {
        throw new Error("Expected bucket owner was not bound");
      }
      const stored = this.objects.get(command.input.Key!);
      if (stored === undefined) {
        if (command.input.Key === `${PREFIX}/last-good.json` && this.pointerBarrier !== undefined) {
          this.pointerBarrier.reads += 1;
          if (this.pointerBarrier.reads === 2) this.pointerBarrier.release();
          await this.pointerBarrier.promise;
        }
        throw missingObject();
      }
      return {
        Body: Readable.from([stored.body]),
        ContentLength: stored.body.length,
        Metadata: stored.metadata,
        ETag: `"${stored.etag}"`,
      };
    }
    if (command instanceof ListObjectsV2Command) {
      if (command.input.ExpectedBucketOwner !== ACCOUNT_ID) {
        throw new Error("Expected bucket owner was not bound");
      }
      const prefix = command.input.Prefix ?? "";
      return {
        IsTruncated: false,
        Contents: [...this.objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([Key, object]) => ({ Key, Size: object.listedSize ?? object.body.length })),
      };
    }
    if (command instanceof ListObjectVersionsCommand) {
      if (command.input.ExpectedBucketOwner !== ACCOUNT_ID) {
        throw new Error("Expected bucket owner was not bound");
      }
      const prefix = command.input.Prefix ?? "";
      return {
        IsTruncated: false,
        Versions: this.versions
          .filter(({ key }) => key.startsWith(prefix))
          .map(({ key, size, versionId }) => ({ Key: key, Size: size, VersionId: versionId })),
      };
    }
    if (command instanceof PutObjectCommand) {
      if (command.input.ExpectedBucketOwner !== ACCOUNT_ID) {
        throw new Error("Expected bucket owner was not bound");
      }
      const key = command.input.Key!;
      if (this.failNextBaselinePut && key.includes("/baselines/")) {
        this.failNextBaselinePut = false;
        throw new Error("Injected interrupted baseline upload");
      }
      const body = await bodyToBuffer(command.input.Body);
      const current = this.objects.get(key);
      if (command.input.IfNoneMatch === "*" && current !== undefined) {
        throw failedPrecondition();
      }
      if (
        command.input.IfMatch !== undefined &&
        command.input.IfMatch.replace(/^"|"$/g, "") !== current?.etag
      ) {
        throw failedPrecondition();
      }
      if (
        command.input.ChecksumSHA256 !== undefined &&
        command.input.ChecksumSHA256 !== createHash("sha256").update(body).digest("base64")
      ) {
        throw new Error("S3 checksum mismatch");
      }
      const stored = {
        body,
        metadata: command.input.Metadata ?? {},
        etag: `put-${++this.revision}`,
      };
      this.objects.set(key, stored);
      this.versions.push({
        key,
        size: stored.body.length,
        versionId: `version-${this.revision}`,
      });
      this.putCount += 1;
      return { ETag: `"${stored.etag}"` };
    }
    throw new Error("Unexpected S3 command");
  }
}

class MemorySts {
  calls = 0;

  constructor(private readonly accountId: string) {}

  async send(command: unknown): Promise<Record<string, unknown>> {
    if (!(command instanceof GetCallerIdentityCommand)) throw new Error("Unexpected STS command");
    this.calls += 1;
    return { Account: this.accountId };
  }
}

const scratchRoots: string[] = [];

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function localBaselineHarness(
  baseline = syntheticClermontBaseline(),
): Promise<{
  baselineSha256: string;
  baselineStore: string;
  baselineRelativePath: string;
}> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "clermont-s3-baseline-"));
  scratchRoots.push(scratch);
  const candidateRoot = path.join(scratch, "candidate");
  const baselineStore = path.join(scratch, "baseline-store");
  await writeSyntheticClermontArtifacts(candidateRoot);
  const pointer = await promoteCertifiedClermontBaseline({
    storeRoot: baselineStore,
    candidateArtifactRoot: candidateRoot,
    candidate: baseline,
    now: NOW,
    expectedSignatures: clermontSignatures,
    expectedPriorSha256: null,
  });
  return {
    baselineSha256: pointer.baselineSha256,
    baselineStore,
    baselineRelativePath: pointer.baselineRelativePath,
  };
}

async function sync(options: {
  memory: MemoryS3;
  sts: MemorySts;
  baselineStore: string;
  baselineSha256: string;
  expectedPriorSha256?: string | null;
  recoverOnly?: boolean;
  clock?: () => Date;
  maxRetainedBytes?: number;
}): Promise<ClermontS3PromotionReceipt> {
  return syncPromoteClermontBaselineToS3({
    client: options.memory as unknown as S3Client,
    stsClient: options.sts as unknown as STSClient,
    accountId: ACCOUNT_ID,
    region: "us-east-2",
    bucket: BUCKET,
    prefix: PREFIX,
    maxRetainedBytes: options.maxRetainedBytes ?? CLERMONT_REMOTE_STORAGE_LIMIT_BYTES,
    localBaselineStore: options.baselineStore,
    baselineSha256: options.baselineSha256,
    expectedPriorSha256: options.expectedPriorSha256 ?? null,
    now: NOW,
    recoverOnly: options.recoverOnly,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

describe("Clermont S3 baseline promotion", () => {
  it("rejects the wrong AWS account before any S3 request or mutation", async () => {
    const local = await localBaselineHarness();
    const memory = new MemoryS3();
    const sts = new MemorySts("000000000000");

    await expect(sync({ memory, sts, ...local })).rejects.toThrow(/AWS account/);
    expect(sts.calls).toBe(1);
    expect(memory.objects.size).toBe(0);
    expect(memory.putCount).toBe(0);
  });

  it("rejects a stale remote predecessor before uploading immutable objects", async () => {
    const local = await localBaselineHarness();
    const memory = new MemoryS3();
    const sts = new MemorySts(ACCOUNT_ID);
    const staleSha256 = "f".repeat(64);
    memory.seed(
      `${PREFIX}/last-good.json`,
      `${canonicalJson({
        schemaVersion: CLERMONT_BASELINE_POINTER_SCHEMA_VERSION,
        baselineSha256: staleSha256,
        baselineRelativePath: `baselines/${staleSha256}/baseline.json`,
        promotedAt: "2026-09-11T08:00:00.000Z",
      })}\n`,
    );

    await expect(sync({ memory, sts, ...local })).rejects.toThrow(/pointer changed/);
    expect(memory.putCount).toBe(0);
    expect(memory.objects.size).toBe(1);
  });

  it("uploads the exact certified set, verifies it, and recovers an applied pointer", async () => {
    const local = await localBaselineHarness();
    const memory = new MemoryS3();
    const sts = new MemorySts(ACCOUNT_ID);

    const first = await sync({ memory, sts, ...local });
    const putsAfterFirst = memory.putCount;
    expect(first.objects.every(({ action }) => action === "uploaded")).toBe(true);
    expect(memory.objects.has(`${PREFIX}/last-good.json`)).toBe(true);
    expect(putsAfterFirst).toBe(first.objects.length + 2);

    const recovered = await sync({
      memory,
      sts,
      ...local,
      recoverOnly: true,
    });
    expect(recovered.objects.every(({ action }) => action === "reconciled")).toBe(true);
    expect(recovered.pointerEtag).toBe(first.pointerEtag);
    expect(memory.putCount).toBe(putsAfterFirst);

    memory.objects.delete(recovered.objects[0]!.key);
    await expect(sync({ memory, sts, ...local, recoverOnly: true })).rejects.toThrow(
      /object is missing/,
    );
    expect(memory.putCount).toBe(putsAfterFirst);
  });

  it("rejects local extra or drifted files before contacting AWS", async () => {
    const local = await localBaselineHarness();
    const memory = new MemoryS3();
    const sts = new MemorySts(ACCOUNT_ID);
    await writeFile(
      path.join(local.baselineStore, "baselines", local.baselineSha256, "unexpected.txt"),
      "unexpected\n",
    );

    await expect(sync({ memory, sts, ...local })).rejects.toThrow(/missing or extra files/);
    expect(sts.calls).toBe(0);
    expect(memory.putCount).toBe(0);
  });

  it("rejects a promotion that would exceed the retained-storage ceiling before upload", async () => {
    const local = await localBaselineHarness();
    const memory = new MemoryS3();
    const sts = new MemorySts(ACCOUNT_ID);
    memory.seed(
      `${PREFIX}/baselines/prior/evidence.ndjson.gz`,
      "prior",
      {},
      CLERMONT_REMOTE_STORAGE_LIMIT_BYTES,
    );

    await expect(sync({ memory, sts, ...local })).rejects.toThrow(/approved retention limit/);
    expect(memory.putCount).toBe(0);
    expect(memory.objects.size).toBe(1);
  });

  it("serializes distinct candidates that race from the same predecessor", async () => {
    const firstLocal = await localBaselineHarness();
    const secondLocal = await localBaselineHarness(
      syntheticClermontBaseline({
        certifiedAt: "2026-09-11T08:59:00.000Z",
        expiresAt: "2026-09-18T08:59:00.000Z",
      }),
    );
    expect(firstLocal.baselineSha256).not.toBe(secondLocal.baselineSha256);
    const memory = new MemoryS3();
    memory.enableConcurrentMissingPointerReads();
    const sts = new MemorySts(ACCOUNT_ID);

    const results = await Promise.allSettled([
      sync({ memory, sts, ...firstLocal }),
      sync({ memory, sts, ...secondLocal }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? firstLocal : secondLocal;
    const loser = winner === firstLocal ? secondLocal : firstLocal;
    expect(
      [...memory.objects.keys()].some((key) =>
        key.startsWith(`${PREFIX}/baselines/${winner.baselineSha256}/`),
      ),
    ).toBe(true);
    expect(
      [...memory.objects.keys()].some((key) =>
        key.startsWith(`${PREFIX}/baselines/${loser.baselineSha256}/`),
      ),
    ).toBe(false);
  });

  it("recovers the same reserved candidate after an interrupted upload", async () => {
    const local = await localBaselineHarness();
    const memory = new MemoryS3();
    const sts = new MemorySts(ACCOUNT_ID);
    const clock = () => new Date("2026-09-11T10:00:00.000Z");
    memory.failNextBaselinePut = true;

    await expect(sync({ memory, sts, ...local, clock })).rejects.toThrow(/interrupted/);
    const recovered = await sync({ memory, sts, ...local, clock });

    expect(recovered.baselineSha256).toBe(local.baselineSha256);
    expect(memory.objects.has(`${PREFIX}/last-good.json`)).toBe(true);
  });

  it("allows an expired failed reservation to be fenced by a new candidate", async () => {
    const firstLocal = await localBaselineHarness();
    const secondLocal = await localBaselineHarness(
      syntheticClermontBaseline({
        certifiedAt: "2026-09-11T08:59:00.000Z",
        expiresAt: "2026-09-18T08:59:00.000Z",
      }),
    );
    const memory = new MemoryS3();
    const sts = new MemorySts(ACCOUNT_ID);
    let now = new Date("2026-09-11T10:00:00.000Z");
    const clock = () => now;
    memory.failNextBaselinePut = true;

    await expect(sync({ memory, sts, ...firstLocal, clock })).rejects.toThrow(/interrupted/);
    now = new Date("2026-09-11T11:00:00.000Z");
    await expect(sync({ memory, sts, ...secondLocal, clock })).rejects.toThrow(/reserved/);

    now = new Date("2026-09-11T17:00:01.000Z");
    const promoted = await sync({ memory, sts, ...secondLocal, clock });
    expect(promoted.baselineSha256).toBe(secondLocal.baselineSha256);
    expect(
      [...memory.objects.keys()].some((key) =>
        key.startsWith(`${PREFIX}/baselines/${firstLocal.baselineSha256}/`),
      ),
    ).toBe(false);
  });

  it("counts retained noncurrent control-plane versions against the storage ceiling", async () => {
    const local = await localBaselineHarness();
    const memory = new MemoryS3();
    const sts = new MemorySts(ACCOUNT_ID);
    memory.seedHistoricalVersion(
      `${PREFIX}/promotion-intents/retired.json`,
      CLERMONT_REMOTE_STORAGE_LIMIT_BYTES,
    );

    await expect(sync({ memory, sts, ...local })).rejects.toThrow(/approved retention limit/);
    expect(memory.putCount).toBe(0);
    expect(memory.objects.size).toBe(0);
  });
});
