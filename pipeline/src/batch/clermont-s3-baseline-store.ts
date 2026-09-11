import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";

import { canonicalJson, sha256Text } from "./contracts.js";
import {
  clermontBaselinePointerSchema,
  clermontCertifiedBaselineSchema,
  type ClermontBaselinePointer,
} from "./clermont-contracts.js";

interface S3ObjectReceipt {
  key: string;
  sha256: string;
  bytes: number;
  etag: string | null;
  action: "reconciled" | "uploaded";
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

async function headOrNull(client: S3Client, bucket: string, key: string) {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function reconcileImmutableObject(options: {
  client: S3Client;
  bucket: string;
  key: string;
  filePath: string;
}): Promise<S3ObjectReceipt> {
  const fileStat = await stat(options.filePath);
  const sha256 = await sha256File(options.filePath);
  const existing = await headOrNull(options.client, options.bucket, options.key);
  let action: S3ObjectReceipt["action"] = "reconciled";
  if (existing !== null) {
    if (existing.ContentLength !== fileStat.size || existing.Metadata?.sha256 !== sha256) {
      throw new Error(`Immutable S3 object conflicts with local evidence: ${options.key}`);
    }
  } else {
    try {
      await options.client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: options.key,
          Body: createReadStream(options.filePath),
          ContentLength: fileStat.size,
          ContentType: options.filePath.endsWith(".json")
            ? "application/json"
            : options.filePath.endsWith(".csv")
              ? "text/csv"
              : "application/gzip",
          Metadata: { sha256 },
          IfNoneMatch: "*",
        }),
      );
      action = "uploaded";
    } catch (error) {
      const raced = await headOrNull(options.client, options.bucket, options.key);
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
    new GetObjectCommand({ Bucket: options.bucket, Key: options.key }),
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

async function readRemotePointer(options: {
  client: S3Client;
  bucket: string;
  key: string;
}): Promise<{ pointer: ClermontBaselinePointer; etag: string } | null> {
  try {
    const result = await options.client.send(
      new GetObjectCommand({ Bucket: options.bucket, Key: options.key }),
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

export async function syncPromoteClermontBaselineToS3(options: {
  client?: S3Client;
  region: string;
  bucket: string;
  prefix: string;
  localBaselineStore: string;
  baselineSha256: string;
  expectedPriorSha256: string | null;
  now: string;
}): Promise<{
  bucket: string;
  prefix: string;
  baselineSha256: string;
  pointerKey: string;
  objects: S3ObjectReceipt[];
  pointerEtag: string;
  readBackAt: string;
}> {
  const prefix = normalizePrefix(options.prefix);
  const localPointer = clermontBaselinePointerSchema.parse(
    JSON.parse(await readFile(path.join(options.localBaselineStore, "last-good.json"), "utf8")),
  );
  if (localPointer.baselineSha256 !== options.baselineSha256) {
    throw new Error("Local last-good pointer is not the requested immutable baseline");
  }
  const immutableRoot = path.join(options.localBaselineStore, "baselines", options.baselineSha256);
  const baseline = clermontCertifiedBaselineSchema.parse(
    JSON.parse(await readFile(path.join(immutableRoot, "baseline.json"), "utf8")),
  );
  if (sha256Text(canonicalJson(baseline)) !== options.baselineSha256) {
    throw new Error("Local baseline bytes do not match its content-addressed identity");
  }
  const client = options.client ?? new S3Client({ region: options.region });
  const objectReceipts: S3ObjectReceipt[] = [];
  for (const filePath of await listFiles(immutableRoot)) {
    const relative = path.relative(immutableRoot, filePath).split(path.sep).join("/");
    objectReceipts.push(
      await reconcileImmutableObject({
        client,
        bucket: options.bucket,
        key: `${prefix}/baselines/${options.baselineSha256}/${relative}`,
        filePath,
      }),
    );
  }

  const pointerKey = `${prefix}/last-good.json`;
  const remote = await readRemotePointer({ client, bucket: options.bucket, key: pointerKey });
  if ((remote?.pointer.baselineSha256 ?? null) !== options.expectedPriorSha256) {
    throw new Error("Remote Clermont last-good pointer changed; refusing unfenced promotion");
  }
  const remotePointer = clermontBaselinePointerSchema.parse({
    ...localPointer,
    promotedAt: options.now,
  });
  const encodedPointer = `${canonicalJson(remotePointer)}\n`;
  const putResult = await client.send(
    new PutObjectCommand({
      Bucket: options.bucket,
      Key: pointerKey,
      Body: encodedPointer,
      ContentLength: Buffer.byteLength(encodedPointer),
      ContentType: "application/json",
      Metadata: { sha256: sha256Text(encodedPointer) },
      ...(remote === null ? { IfNoneMatch: "*" } : { IfMatch: remote.etag }),
    }),
  );
  const readback = await readRemotePointer({ client, bucket: options.bucket, key: pointerKey });
  if (readback === null || canonicalJson(readback.pointer) !== canonicalJson(remotePointer)) {
    throw new Error("Remote Clermont last-good pointer failed readback");
  }
  return {
    bucket: options.bucket,
    prefix,
    baselineSha256: options.baselineSha256,
    pointerKey,
    objects: objectReceipts,
    pointerEtag: stripEtag(putResult.ETag) ?? readback.etag.replace(/^"|"$/g, ""),
    readBackAt: options.now,
  };
}
