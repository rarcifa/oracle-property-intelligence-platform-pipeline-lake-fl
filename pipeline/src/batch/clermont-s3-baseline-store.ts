import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";

import { canonicalJson, sha256Text } from "./contracts.js";
import {
  clermontBaselinePointerSchema,
  clermontCertifiedBaselineSchema,
  type ClermontBaselinePointer,
  type ClermontImmutableArtifact,
} from "./clermont-contracts.js";

export const clermontS3PromotionReceiptSchema = z
  .object({
    accountId: z.string().regex(/^[0-9]{12}$/),
    region: z.string().min(1),
    bucket: z.string().min(3),
    prefix: z.string().min(1),
    baselineSha256: z.string().regex(/^[a-f0-9]{64}$/),
    pointerKey: z.string().min(1),
    objects: z.array(
      z
        .object({
          key: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().nonnegative(),
          etag: z.string().nullable(),
          action: z.enum(["reconciled", "uploaded"]),
        })
        .strict(),
    ),
    pointerEtag: z.string().min(1),
    readBackAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((receipt, context) => {
    const keys = receipt.objects.map(({ key }) => key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["objects"],
        message: "S3 object keys must be unique",
      });
    }
    if (canonicalJson(keys) !== canonicalJson([...keys].sort())) {
      context.addIssue({
        code: "custom",
        path: ["objects"],
        message: "S3 object keys must be sorted",
      });
    }
  });

export type ClermontS3PromotionReceipt = z.infer<typeof clermontS3PromotionReceiptSchema>;
type S3ObjectReceipt = ClermontS3PromotionReceipt["objects"][number];

const CLERMONT_PROMOTION_INTENT_SCHEMA_VERSION =
  "elephant.clermont-s3-promotion-intent.v2" as const;
const PROMOTION_INTENT_LEASE_MS = 6 * 60 * 60 * 1_000;

const clermontPromotionIntentSchema = z
  .object({
    schemaVersion: z.literal(CLERMONT_PROMOTION_INTENT_SCHEMA_VERSION),
    accountId: z.string().regex(/^[0-9]{12}$/),
    bucket: z.string().min(3),
    prefix: z.string().min(1),
    expectedPriorSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    baselineSha256: z.string().regex(/^[a-f0-9]{64}$/),
    maxRetainedBytes: z.number().int().positive(),
    artifactSetSha256: z.string().regex(/^[a-f0-9]{64}$/),
    acquiredAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((intent, context) => {
    if (Date.parse(intent.expiresAt) <= Date.parse(intent.acquiredAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Promotion intent must expire after it is acquired",
      });
    }
  });

type ClermontPromotionIntent = z.infer<typeof clermontPromotionIntentSchema>;

interface PromotionIntentFence {
  key: string;
  intent: ClermontPromotionIntent;
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  if (normalized === "" || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("S3 baseline prefix must be a non-empty confined key prefix");
  }
  return normalized;
}

function stripEtag(etag: string | undefined): string | null {
  return etag === undefined ? null : etag.replace(/^"|"$/g, "");
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === "NotFound" || value.$metadata?.httpStatusCode === 404;
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

async function bodyBytesAndDigest(
  body: GetObjectCommandOutput["Body"],
  collect = false,
): Promise<{ bytes: number; sha256: string; chunks: Buffer[] }> {
  if (body === undefined) throw new Error("S3 readback returned no body");
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    hash.update(buffer);
    if (collect) chunks.push(buffer);
    bytes += buffer.length;
  }
  return { bytes, sha256: hash.digest("hex"), chunks };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile()) files.push(filePath);
    }
  }
  await visit(root);
  return files.sort();
}

async function headOrNull(
  client: S3Client,
  bucket: string,
  key: string,
  expectedBucketOwner: string,
) {
  try {
    return await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        ExpectedBucketOwner: expectedBucketOwner,
      }),
    );
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function reconcileImmutableObject(options: {
  client: S3Client;
  bucket: string;
  key: string;
  expectedBucketOwner: string;
  filePath: string;
  expected: ClermontImmutableArtifact;
  allowUpload?: boolean;
}): Promise<S3ObjectReceipt> {
  const fileStat = await stat(options.filePath);
  const sha256 = await sha256File(options.filePath);
  if (fileStat.size !== options.expected.bytes || sha256 !== options.expected.sha256) {
    throw new Error(`Local immutable artifact drifted from certification: ${options.key}`);
  }
  const existing = await headOrNull(
    options.client,
    options.bucket,
    options.key,
    options.expectedBucketOwner,
  );
  let action: S3ObjectReceipt["action"] = "reconciled";
  if (existing !== null) {
    if (existing.ContentLength !== fileStat.size || existing.Metadata?.sha256 !== sha256) {
      throw new Error(`Immutable S3 object conflicts with local evidence: ${options.key}`);
    }
  } else {
    if (options.allowUpload === false) {
      throw new Error(`Published Clermont baseline object is missing: ${options.key}`);
    }
    try {
      await options.client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: options.key,
          ExpectedBucketOwner: options.expectedBucketOwner,
          Body: createReadStream(options.filePath),
          ContentLength: fileStat.size,
          ContentType: options.filePath.endsWith(".json")
            ? "application/json"
            : options.filePath.endsWith(".csv")
              ? "text/csv"
              : "application/gzip",
          Metadata: { sha256: options.expected.sha256 },
          ChecksumAlgorithm: "SHA256",
          ChecksumSHA256: Buffer.from(options.expected.sha256, "hex").toString("base64"),
          IfNoneMatch: "*",
        }),
      );
      action = "uploaded";
    } catch (error) {
      const raced = await headOrNull(
        options.client,
        options.bucket,
        options.key,
        options.expectedBucketOwner,
      );
      if (
        raced === null ||
        raced.ContentLength !== fileStat.size ||
        raced.Metadata?.sha256 !== sha256
      ) {
        throw error;
      }
    }
  }
  const readback = await options.client.send(
    new GetObjectCommand({
      Bucket: options.bucket,
      Key: options.key,
      ExpectedBucketOwner: options.expectedBucketOwner,
    }),
  );
  const verified = await bodyBytesAndDigest(readback.Body);
  if (verified.bytes !== fileStat.size || verified.sha256 !== sha256) {
    throw new Error(`Immutable S3 readback failed: ${options.key}`);
  }
  return {
    key: options.key,
    sha256,
    bytes: fileStat.size,
    etag: stripEtag(readback.ETag),
    action,
  };
}

function exactBaselineArtifacts(
  baseline: ReturnType<typeof clermontCertifiedBaselineSchema.parse>,
  baselineSha256: string,
): ClermontImmutableArtifact[] {
  const entries: ClermontImmutableArtifact[] = [
    {
      logicalPath: "baseline.json",
      sha256: baselineSha256,
      bytes: Buffer.byteLength(canonicalJson(baseline)),
    },
    ...baseline.partitions.flatMap(({ artifacts }) => Object.values(artifacts)),
    baseline.mergedExport.artifact,
    baseline.mergedExport.metadata,
  ];
  const unique = new Map<string, ClermontImmutableArtifact>();
  for (const entry of entries) {
    const prior = unique.get(entry.logicalPath);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(entry)) {
      throw new Error(`Certified baseline reuses an artifact path with conflicting bytes`);
    }
    unique.set(entry.logicalPath, entry);
  }
  return [...unique.values()].sort((left, right) =>
    left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0,
  );
}

async function readRemotePointer(options: {
  client: S3Client;
  bucket: string;
  key: string;
  expectedBucketOwner: string;
}): Promise<{ pointer: ClermontBaselinePointer; etag: string } | null> {
  try {
    const result = await options.client.send(
      new GetObjectCommand({
        Bucket: options.bucket,
        Key: options.key,
        ExpectedBucketOwner: options.expectedBucketOwner,
      }),
    );
    const body = await bodyBytesAndDigest(result.Body, true);
    const pointer = clermontBaselinePointerSchema.parse(
      JSON.parse(Buffer.concat(body.chunks).toString("utf8")),
    );
    const etag = result.ETag;
    if (etag === undefined) throw new Error("Remote last-good pointer has no ETag fence");
    return { pointer, etag };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function listCurrentObjectBytes(options: {
  client: S3Client;
  bucket: string;
  prefix: string;
  expectedBucketOwner: string;
}): Promise<Map<string, number>> {
  const objects = new Map<string, number>();
  let continuationToken: string | undefined;
  do {
    const result = await options.client.send(
      new ListObjectsV2Command({
        Bucket: options.bucket,
        Prefix: options.prefix,
        ContinuationToken: continuationToken,
        ExpectedBucketOwner: options.expectedBucketOwner,
      }),
    );
    for (const object of result.Contents ?? []) {
      if (object.Key === undefined || object.Size === undefined || object.Size < 0) {
        throw new Error("S3 retained-baseline listing returned an invalid object");
      }
      if (objects.has(object.Key)) {
        throw new Error(`S3 retained-baseline listing duplicated ${object.Key}`);
      }
      objects.set(object.Key, object.Size);
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    if (result.IsTruncated && continuationToken === undefined) {
      throw new Error("S3 retained-baseline listing truncated without a continuation token");
    }
  } while (continuationToken !== undefined);
  return objects;
}

async function listRetainedVersionBytes(options: {
  client: S3Client;
  bucket: string;
  prefix: string;
  expectedBucketOwner: string;
}): Promise<number> {
  const versions = new Set<string>();
  let retainedBytes = 0;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const result = await options.client.send(
      new ListObjectVersionsCommand({
        Bucket: options.bucket,
        Prefix: options.prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
        ExpectedBucketOwner: options.expectedBucketOwner,
      }),
    );
    for (const version of result.Versions ?? []) {
      if (
        version.Key === undefined ||
        version.VersionId === undefined ||
        version.Size === undefined ||
        version.Size < 0
      ) {
        throw new Error("S3 retained-version listing returned an invalid object version");
      }
      const identity = `${version.Key}\0${version.VersionId}`;
      if (versions.has(identity)) {
        throw new Error(`S3 retained-version listing duplicated ${version.Key}`);
      }
      versions.add(identity);
      retainedBytes += version.Size;
    }
    keyMarker = result.IsTruncated ? result.NextKeyMarker : undefined;
    versionIdMarker = result.IsTruncated ? result.NextVersionIdMarker : undefined;
    if (result.IsTruncated && keyMarker === undefined) {
      throw new Error("S3 retained-version listing truncated without a key marker");
    }
  } while (keyMarker !== undefined);
  return retainedBytes;
}

async function assertRetainedStorageLimit(options: {
  client: S3Client;
  bucket: string;
  prefix: string;
  expectedBucketOwner: string;
  baselineSha256: string;
  expectedArtifacts: ClermontImmutableArtifact[];
  maxRetainedBytes: number;
  additionalControlPlaneBytes: number;
}): Promise<void> {
  const currentObjects = await listCurrentObjectBytes({
    client: options.client,
    bucket: options.bucket,
    prefix: `${options.prefix}/`,
    expectedBucketOwner: options.expectedBucketOwner,
  });
  const retainedBytes = await listRetainedVersionBytes({
    client: options.client,
    bucket: options.bucket,
    prefix: `${options.prefix}/`,
    expectedBucketOwner: options.expectedBucketOwner,
  });
  const newBytes = options.expectedArtifacts.reduce((sum, artifact) => {
    const key = `${options.prefix}/baselines/${options.baselineSha256}/${artifact.logicalPath}`;
    return sum + (currentObjects.has(key) ? 0 : artifact.bytes);
  }, 0);
  if (retainedBytes + newBytes + options.additionalControlPlaneBytes > options.maxRetainedBytes) {
    throw new Error("Remote Clermont baseline storage would exceed the approved retention limit");
  }
}

function promotionIntentFor(
  options: {
    bucket: string;
    prefix: string;
    expectedBucketOwner: string;
    expectedPriorSha256: string | null;
    baselineSha256: string;
    expectedArtifacts: ClermontImmutableArtifact[];
    maxRetainedBytes: number;
  },
  now: Date,
): ClermontPromotionIntent {
  return clermontPromotionIntentSchema.parse({
    schemaVersion: CLERMONT_PROMOTION_INTENT_SCHEMA_VERSION,
    accountId: options.expectedBucketOwner,
    bucket: options.bucket,
    prefix: options.prefix,
    expectedPriorSha256: options.expectedPriorSha256,
    baselineSha256: options.baselineSha256,
    maxRetainedBytes: options.maxRetainedBytes,
    artifactSetSha256: sha256Text(canonicalJson(options.expectedArtifacts)),
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PROMOTION_INTENT_LEASE_MS).toISOString(),
  });
}

function samePromotionReservation(
  left: ClermontPromotionIntent,
  right: ClermontPromotionIntent,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.bucket === right.bucket &&
    left.prefix === right.prefix &&
    left.expectedPriorSha256 === right.expectedPriorSha256 &&
    left.baselineSha256 === right.baselineSha256 &&
    left.maxRetainedBytes === right.maxRetainedBytes &&
    left.artifactSetSha256 === right.artifactSetSha256
  );
}

async function readPromotionIntent(options: {
  client: S3Client;
  bucket: string;
  key: string;
  expectedBucketOwner: string;
}): Promise<{ intent: ClermontPromotionIntent; etag: string }> {
  const result = await options.client.send(
    new GetObjectCommand({
      Bucket: options.bucket,
      Key: options.key,
      ExpectedBucketOwner: options.expectedBucketOwner,
    }),
  );
  const body = await bodyBytesAndDigest(result.Body, true);
  const intent = clermontPromotionIntentSchema.parse(
    JSON.parse(Buffer.concat(body.chunks).toString("utf8")),
  );
  if (result.ETag === undefined) throw new Error("Remote promotion intent has no ETag fence");
  return { intent, etag: result.ETag };
}

async function putPromotionIntent(options: {
  client: S3Client;
  bucket: string;
  key: string;
  expectedBucketOwner: string;
  intent: ClermontPromotionIntent;
  ifMatch?: string;
  ifNoneMatch?: string;
}): Promise<void> {
  const encoded = `${canonicalJson(options.intent)}\n`;
  await options.client.send(
    new PutObjectCommand({
      Bucket: options.bucket,
      Key: options.key,
      ExpectedBucketOwner: options.expectedBucketOwner,
      Body: encoded,
      ContentLength: Buffer.byteLength(encoded),
      ContentType: "application/json",
      Metadata: { sha256: sha256Text(encoded) },
      ChecksumAlgorithm: "SHA256",
      ChecksumSHA256: Buffer.from(sha256Text(encoded), "hex").toString("base64"),
      ...(options.ifMatch === undefined ? {} : { IfMatch: options.ifMatch }),
      ...(options.ifNoneMatch === undefined ? {} : { IfNoneMatch: options.ifNoneMatch }),
    }),
  );
}

async function acquirePromotionIntent(options: {
  client: S3Client;
  bucket: string;
  prefix: string;
  expectedBucketOwner: string;
  expectedPriorSha256: string | null;
  baselineSha256: string;
  expectedArtifacts: ClermontImmutableArtifact[];
  maxRetainedBytes: number;
  now: Date;
}): Promise<PromotionIntentFence> {
  const predecessor = options.expectedPriorSha256 ?? "empty";
  const key = `${options.prefix}/promotion-intents/${predecessor}.json`;
  const intent = promotionIntentFor(options, options.now);
  try {
    await putPromotionIntent({
      client: options.client,
      bucket: options.bucket,
      key,
      expectedBucketOwner: options.expectedBucketOwner,
      intent,
      ifNoneMatch: "*",
    });
    const readback = await readPromotionIntent({
      client: options.client,
      bucket: options.bucket,
      key,
      expectedBucketOwner: options.expectedBucketOwner,
    });
    if (canonicalJson(readback.intent) !== canonicalJson(intent)) {
      throw new Error("Remote promotion intent failed readback");
    }
    return { key, intent };
  } catch (error) {
    let existing: Awaited<ReturnType<typeof readPromotionIntent>>;
    try {
      existing = await readPromotionIntent({
        client: options.client,
        bucket: options.bucket,
        key,
        expectedBucketOwner: options.expectedBucketOwner,
      });
    } catch {
      // Preserve the conditional-write failure when no exact intent exists.
      throw new Error(
        `Another Clermont candidate already reserved predecessor ${options.expectedPriorSha256 ?? "empty"}`,
        { cause: error },
      );
    }
    const expired = Date.parse(existing.intent.expiresAt) <= options.now.getTime();
    if (samePromotionReservation(existing.intent, intent) && !expired) {
      return { key, intent: existing.intent };
    }
    if (expired) {
      try {
        await putPromotionIntent({
          client: options.client,
          bucket: options.bucket,
          key,
          expectedBucketOwner: options.expectedBucketOwner,
          intent,
          ifMatch: existing.etag,
        });
        const readback = await readPromotionIntent({
          client: options.client,
          bucket: options.bucket,
          key,
          expectedBucketOwner: options.expectedBucketOwner,
        });
        if (canonicalJson(readback.intent) !== canonicalJson(intent)) {
          throw new Error("Remote promotion-intent takeover failed readback");
        }
        return { key, intent };
      } catch (takeoverError) {
        throw new Error(
          `Another Clermont candidate took over predecessor ${options.expectedPriorSha256 ?? "empty"}`,
          { cause: takeoverError },
        );
      }
    }
    throw new Error(
      `Another Clermont candidate already reserved predecessor ${options.expectedPriorSha256 ?? "empty"}`,
      { cause: error },
    );
  }
}

async function assertPromotionIntent(options: {
  client: S3Client;
  bucket: string;
  expectedBucketOwner: string;
  fence: PromotionIntentFence;
  now: Date;
}): Promise<void> {
  const current = await readPromotionIntent({
    client: options.client,
    bucket: options.bucket,
    key: options.fence.key,
    expectedBucketOwner: options.expectedBucketOwner,
  });
  if (!samePromotionReservation(current.intent, options.fence.intent)) {
    throw new Error("Remote Clermont promotion intent was fenced by another candidate");
  }
  if (Date.parse(current.intent.expiresAt) <= options.now.getTime()) {
    throw new Error("Remote Clermont promotion intent expired before commit");
  }
}

export async function syncPromoteClermontBaselineToS3(options: {
  client?: S3Client;
  stsClient?: STSClient;
  accountId: string;
  region: string;
  bucket: string;
  prefix: string;
  maxRetainedBytes: number;
  localBaselineStore: string;
  baselineSha256: string;
  expectedPriorSha256: string | null;
  now: string;
  recoverOnly?: boolean;
  clock?: () => Date;
}): Promise<ClermontS3PromotionReceipt> {
  const currentTime = options.clock ?? (() => new Date());
  const prefix = normalizePrefix(options.prefix);
  const localPointer = clermontBaselinePointerSchema.parse(
    JSON.parse(await readFile(path.join(options.localBaselineStore, "last-good.json"), "utf8")),
  );
  if (localPointer.baselineSha256 !== options.baselineSha256) {
    throw new Error("Local last-good pointer is not the requested immutable baseline");
  }
  if (localPointer.baselineRelativePath !== `baselines/${options.baselineSha256}/baseline.json`) {
    throw new Error("Local last-good pointer path is not the exact immutable baseline path");
  }
  const immutableRoot = path.join(options.localBaselineStore, "baselines", options.baselineSha256);
  const baseline = clermontCertifiedBaselineSchema.parse(
    JSON.parse(await readFile(path.join(immutableRoot, "baseline.json"), "utf8")),
  );
  if (sha256Text(canonicalJson(baseline)) !== options.baselineSha256) {
    throw new Error("Local baseline bytes do not match its content-addressed identity");
  }
  const expectedArtifacts = exactBaselineArtifacts(baseline, options.baselineSha256);
  const actualRelativePaths = (await listFiles(immutableRoot)).map((filePath) =>
    path.relative(immutableRoot, filePath).split(path.sep).join("/"),
  );
  if (
    canonicalJson(actualRelativePaths) !==
    canonicalJson(expectedArtifacts.map(({ logicalPath }) => logicalPath))
  ) {
    throw new Error("Local immutable baseline contains missing or extra files");
  }
  const client = options.client ?? new S3Client({ region: options.region });
  const stsClient = options.stsClient ?? new STSClient({ region: options.region });
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  if (identity.Account !== options.accountId) {
    throw new Error("Active AWS account does not match the prepared Clermont destination");
  }
  const pointerKey = `${prefix}/last-good.json`;
  const remote = await readRemotePointer({
    client,
    bucket: options.bucket,
    key: pointerKey,
    expectedBucketOwner: options.accountId,
  });
  const remoteBaselineSha256 = remote?.pointer.baselineSha256 ?? null;
  const recoveringCommittedPointer = remoteBaselineSha256 === options.baselineSha256;
  if (options.recoverOnly && !recoveringCommittedPointer) {
    throw new Error("Recorded S3 promotion is not present at the remote pointer");
  }
  if (!recoveringCommittedPointer && remoteBaselineSha256 !== options.expectedPriorSha256) {
    throw new Error("Remote Clermont last-good pointer changed; refusing unfenced promotion");
  }
  const remotePointer = clermontBaselinePointerSchema.parse({
    ...localPointer,
    promotedAt: options.now,
  });
  const encodedPointer = `${canonicalJson(remotePointer)}\n`;
  const intentPreview = promotionIntentFor(
    {
      bucket: options.bucket,
      prefix,
      expectedBucketOwner: options.accountId,
      expectedPriorSha256: options.expectedPriorSha256,
      baselineSha256: options.baselineSha256,
      expectedArtifacts,
      maxRetainedBytes: options.maxRetainedBytes,
    },
    currentTime(),
  );
  const retentionCheck = {
    client,
    bucket: options.bucket,
    prefix,
    expectedBucketOwner: options.accountId,
    baselineSha256: options.baselineSha256,
    expectedArtifacts,
    maxRetainedBytes: options.maxRetainedBytes,
  };
  let intentFence: PromotionIntentFence | null = null;
  if (!recoveringCommittedPointer) {
    await assertRetainedStorageLimit({
      ...retentionCheck,
      additionalControlPlaneBytes:
        Buffer.byteLength(`${canonicalJson(intentPreview)}\n`) +
        Buffer.byteLength(encodedPointer),
    });
    intentFence = await acquirePromotionIntent({
      ...retentionCheck,
      expectedPriorSha256: options.expectedPriorSha256,
      now: currentTime(),
    });
    await assertRetainedStorageLimit({
      ...retentionCheck,
      additionalControlPlaneBytes: Buffer.byteLength(encodedPointer),
    });
  } else {
    await assertRetainedStorageLimit({
      ...retentionCheck,
      additionalControlPlaneBytes: 0,
    });
  }
  const objectReceipts: S3ObjectReceipt[] = [];
  for (const artifact of expectedArtifacts) {
    if (intentFence !== null) {
      await assertPromotionIntent({
        client,
        bucket: options.bucket,
        expectedBucketOwner: options.accountId,
        fence: intentFence,
        now: currentTime(),
      });
    }
    const filePath = path.join(immutableRoot, artifact.logicalPath);
    objectReceipts.push(
      await reconcileImmutableObject({
        client,
        bucket: options.bucket,
        key: `${prefix}/baselines/${options.baselineSha256}/${artifact.logicalPath}`,
        expectedBucketOwner: options.accountId,
        filePath,
        expected: artifact,
        allowUpload: !recoveringCommittedPointer,
      }),
    );
    if (intentFence !== null) {
      await assertPromotionIntent({
        client,
        bucket: options.bucket,
        expectedBucketOwner: options.accountId,
        fence: intentFence,
        now: currentTime(),
      });
    }
  }
  if (recoveringCommittedPointer) {
    if (
      remote === null ||
      remote.pointer.baselineRelativePath !== localPointer.baselineRelativePath
    ) {
      throw new Error("Remote Clermont pointer does not match the local immutable baseline");
    }
    return clermontS3PromotionReceiptSchema.parse({
      accountId: options.accountId,
      region: options.region,
      bucket: options.bucket,
      prefix,
      baselineSha256: options.baselineSha256,
      pointerKey,
      objects: objectReceipts,
      pointerEtag: remote.etag.replace(/^"|"$/g, ""),
      readBackAt: options.now,
    });
  }
  if (intentFence === null) {
    throw new Error("Remote Clermont promotion is missing its intent fence");
  }
  await assertPromotionIntent({
    client,
    bucket: options.bucket,
    expectedBucketOwner: options.accountId,
    fence: intentFence,
    now: currentTime(),
  });
  const putResult = await client.send(
    new PutObjectCommand({
      Bucket: options.bucket,
      Key: pointerKey,
      ExpectedBucketOwner: options.accountId,
      Body: encodedPointer,
      ContentLength: Buffer.byteLength(encodedPointer),
      ContentType: "application/json",
      Metadata: { sha256: sha256Text(encodedPointer) },
      ...(remote === null ? { IfNoneMatch: "*" } : { IfMatch: remote.etag }),
    }),
  );
  const readback = await readRemotePointer({
    client,
    bucket: options.bucket,
    key: pointerKey,
    expectedBucketOwner: options.accountId,
  });
  if (readback === null || canonicalJson(readback.pointer) !== canonicalJson(remotePointer)) {
    throw new Error("Remote Clermont last-good pointer failed readback");
  }
  return clermontS3PromotionReceiptSchema.parse({
    accountId: options.accountId,
    region: options.region,
    bucket: options.bucket,
    prefix,
    baselineSha256: options.baselineSha256,
    pointerKey,
    objects: objectReceipts,
    pointerEtag: stripEtag(putResult.ETag) ?? readback.etag.replace(/^"|"$/g, ""),
    readBackAt: options.now,
  });
}
