/** Real SDK serialization and streamed CAR fixtures; no network or credentials. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uploadImmutableCar } from "../scripts/lake/publish-run.mjs";
import { verifyImportedCarStream, writeCarFile } from "../src/core/car.mjs";
import { buildUnixfsDirectory, computeRawCid, computeUnixfsFileCid } from "../src/core/cid.mjs";

let directory;
let local;
let reordered;
const file = computeUnixfsFileCid(Buffer.alloc(262145, 7));
let nextFile = 0;
async function car(roots, blocks) {
  const outputPath = path.join(directory, `${nextFile++}.car`);
  await writeCarFile({ roots, blocks, outputPath });
  return readFile(outputPath);
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lake-imported-car-"));
  local = await car([file.cid], file.blocks);
  reordered = await car([file.cid], [...file.blocks].reverse());
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function verify(bytes, deadlineMs = 1000) {
  return verifyImportedCarStream({
    body: Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 81), bytes.subarray(81)]),
    expected: local,
    signal: AbortSignal.timeout(deadlineMs),
  });
}

describe("complete imported DAG stream verification", () => {
  it("verifies every directory descendant, raw manifest and archive-file block", async () => {
    const directoryDag = buildUnixfsDirectory([
      { name: "query-table.parquet", cid: file.cid, size: file.size },
    ]);
    const manifestBytes = Buffer.from('{"artifacts":[]}');
    const manifest = { cid: computeRawCid(manifestBytes), bytes: manifestBytes };
    const archiveFile = computeUnixfsFileCid(local);
    for (const dag of [
      { cid: directoryDag.cid, blocks: [...file.blocks, ...directoryDag.blocks] },
      { cid: manifest.cid, blocks: [manifest] },
      archiveFile,
    ]) {
      const expected = await car([dag.cid], dag.blocks);
      const exported = await car([dag.cid], [...dag.blocks].reverse());
      await expect(
        verifyImportedCarStream({
          body: Readable.from([exported]),
          expected,
          signal: AbortSignal.timeout(1000),
        }),
      ).resolves.toMatchObject({ roots: [dag.cid], verifiedBlocks: dag.blocks.length });
    }
  });
  it("accepts reordered blocks but records the distinct export digest", async () => {
    expect(reordered.equals(local)).toBe(false);
    const result = await verify(reordered);
    expect(result).toMatchObject({
      representation: "imported-dag",
      roots: [file.cid],
      verifiedBlocks: file.blocks.length,
      exportedBytes: reordered.length,
    });
    expect(result.exportedSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects a missing reachable descendant", async () => {
    const bytes = await car(
      [file.cid],
      file.blocks.filter((block) => block.cid === file.cid),
    );
    await expect(verify(bytes)).rejects.toThrow(/CAR_DAG_MISSING_BLOCK/);
  });

  it("rejects an additional valid but unreachable block", async () => {
    const bytes = Buffer.from("unexpected");
    const added = await car([file.cid], [...file.blocks, { cid: computeRawCid(bytes), bytes }]);
    await expect(verify(added)).rejects.toThrow(/CAR_DAG_UNEXPECTED_BLOCK/);
  });

  it("rejects a substituted root", async () => {
    const bytes = Buffer.from("another-root");
    await expect(
      verify(await car([computeRawCid(bytes)], [{ cid: computeRawCid(bytes), bytes }])),
    ).rejects.toThrow(/CAR_DAG_ROOT_MISMATCH/);
  });

  it("rejects different block bytes, truncated framing and directory HTML", async () => {
    const corrupt = Buffer.from(reordered);
    corrupt[corrupt.length - 1] ^= 1;
    await expect(verify(corrupt)).rejects.toThrow(/CAR_DAG_BLOCK_MISMATCH/);
    await expect(verify(reordered.subarray(0, -1))).rejects.toThrow(/CAR_DAG_TRUNCATED/);
    await expect(verify(Buffer.from("<!doctype html>directory listing"))).rejects.toThrow();
  });

  it("rejects a duplicate block even when its bytes are correct", async () => {
    // Re-append the exported first frame: skip the one-byte header prefix and header.
    const start = 1 + reordered[0];
    let length = 0;
    let scale = 1;
    let prefix = 0;
    for (;;) {
      const byte = reordered[start + prefix++];
      length += (byte & 127) * scale;
      if (!(byte & 128)) break;
      scale *= 128;
    }
    const duplicated = Buffer.concat([
      reordered,
      reordered.subarray(start, start + prefix + length),
    ]);
    await expect(verify(duplicated)).rejects.toThrow(/CAR_DAG_DUPLICATE_BLOCK|CAR_DAG_OVERSIZED/);
  });

  it("destroys an interrupted stream and hides the vendor message", async () => {
    const body = Readable.from(
      (async function* () {
        yield reordered.subarray(0, 81);
        throw new Error("DO_NOT_LOG_SECRET");
      })(),
    );
    const error = await verifyImportedCarStream({
      body,
      expected: local,
      signal: AbortSignal.timeout(1000),
    }).catch((value) => value);
    expect(error.message).toContain("CAR_DAG_READ_FAILED");
    expect(error.message).not.toContain("DO_NOT_LOG_SECRET");
    expect(body.destroyed).toBe(true);
  });

  it("bounds a stalled stream with a deadline", async () => {
    const body = new Readable({ read() {} });
    await expect(
      verifyImportedCarStream({ body, expected: local, signal: AbortSignal.timeout(20) }),
    ).rejects.toThrow(/CAR_DAG_TIMEOUT/);
    expect(body.destroyed).toBe(true);
  });
});

async function withClient(
  {
    exists = true,
    status = 200,
    cid = file.cid,
    bytes = reordered,
    contentType = "application/vnd.ipld.car",
    length,
    importMode = "car",
    gatewayStatus = 200,
    lostAcknowledgement = false,
  } = {},
  test,
) {
  const requests = [];
  let present = exists;
  const client = new S3Client({
    endpoint: "https://offline.invalid",
    region: "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: "OFFLINE_ONLY", secretAccessKey: "OFFLINE_ONLY" },
    requestHandler: {
      async handle(request) {
        requests.push(request);
        if (request.method === "PUT") {
          expect(request.headers["if-none-match"]).toBe("*");
          expect(request.headers["x-amz-meta-import"]).toBe("car");
          expect(Buffer.from(request.body)).toEqual(local);
          present = true;
          if (lostAcknowledgement) throw new Error("LOST_ACK_DO_NOT_LOG_SECRET");
          return {
            response: {
              statusCode: 200,
              headers: { "x-amz-meta-cid": cid },
              body: Readable.from([]),
            },
          };
        }
        expect(request.method).toBe("HEAD");
        return {
          response: {
            statusCode: present ? status : 404,
            headers: {
              "content-length": String(length ?? local.length),
              "x-amz-meta-cid": cid,
              "x-amz-meta-import": importMode,
            },
            body: Readable.from([]),
          },
        };
      },
      destroy() {},
    },
  });
  const beforeCreate = vi.fn(async () => {});
  const fetchImpl = vi.fn(
    async () =>
      new globalThis.Response(bytes, {
        status: gatewayStatus,
        headers: { "content-type": contentType },
      }),
  );
  try {
    await test({
      client,
      requests,
      beforeCreate,
      fetchImpl,
      options: {
        client,
        bucket: "offline-fixture",
        key: "runs/fixture/root.car",
        body: local,
        expectedCid: file.cid,
        beforeCreate,
        primaryReadback: "imported-dag",
        fetchImpl,
      },
    });
  } finally {
    client.destroy();
  }
}

describe("explicit imported-DAG immutable readback", () => {
  it("binds the existing key with HEAD, verifies all blocks and sends zero PUTs", async () => {
    await withClient({}, async ({ options, requests, beforeCreate, fetchImpl }) => {
      const receipt = await uploadImmutableCar(options);
      expect(receipt).toMatchObject({
        action: "reconciled-existing",
        reportedCid: file.cid,
        transportVerified: false,
        readback: { representation: "imported-dag", verifiedBlocks: file.blocks.length },
      });
      expect(requests.map((r) => r.method)).toEqual(["HEAD"]);
      expect(beforeCreate).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledWith(
        `https://ipfs.filebase.io/ipfs/${file.cid}?format=car`,
        expect.objectContaining({ redirect: "error" }),
      );
    });
  });

  it.each([403, 500])("never creates or fetches after ambiguous HEAD HTTP%s", async (status) => {
    await withClient({ status }, async ({ options, requests, fetchImpl, beforeCreate }) => {
      await expect(uploadImmutableCar(options)).rejects.toThrow(/HEAD failed/);
      expect(requests.map((r) => r.method)).toEqual(["HEAD"]);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(beforeCreate).not.toHaveBeenCalled();
    });
  });

  it("rejects a wrong key CID without fetching another public object", async () => {
    await withClient({ cid: computeRawCid("wrong") }, async ({ options, requests, fetchImpl }) => {
      await expect(uploadImmutableCar(options)).rejects.toThrow(/metadata differs/);
      expect(requests.map((r) => r.method)).toEqual(["HEAD"]);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it.each([{ length: 1 }, { importMode: "plain" }, { importMode: "" }])(
    "rejects incorrect key size/import metadata %j",
    async (variant) => {
      await withClient(variant, async ({ options, requests, fetchImpl }) => {
        await expect(uploadImmutableCar(options)).rejects.toThrow(/metadata differs/);
        expect(requests.map((r) => r.method)).toEqual(["HEAD"]);
        expect(fetchImpl).not.toHaveBeenCalled();
      });
    },
  );

  it.each([404, 500])("never treats gateway HTTP%s as permission to PUT", async (gatewayStatus) => {
    await withClient({ gatewayStatus }, async ({ options, requests, beforeCreate }) => {
      await expect(uploadImmutableCar(options)).rejects.toThrow(/gateway readback failed/);
      expect(requests.map((r) => r.method)).toEqual(["HEAD"]);
      expect(beforeCreate).not.toHaveBeenCalled();
    });
  });

  it("reconciles after a lost create acknowledgement without replaying PUT", async () => {
    await withClient(
      { exists: false, lostAcknowledgement: true },
      async ({ options, requests }) => {
        await expect(uploadImmutableCar(options)).rejects.toThrow(/outcome uncertain/);
        await expect(uploadImmutableCar(options)).resolves.toMatchObject({
          action: "reconciled-existing",
          transportVerified: false,
        });
        expect(requests.map((r) => r.method)).toEqual(["HEAD", "PUT", "HEAD"]);
      },
    );
  });

  it("creates only after definite absence, using the existing guard and exact upload bytes", async () => {
    await withClient({ exists: false }, async ({ options, requests, beforeCreate }) => {
      await expect(uploadImmutableCar(options)).resolves.toMatchObject({
        action: "created",
        transportVerified: false,
      });
      expect(requests.map((r) => r.method)).toEqual(["HEAD", "PUT", "HEAD"]);
      expect(beforeCreate).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["text/html", "application/json"])(
    "does not accept %s as an imported DAG",
    async (contentType) => {
      await withClient({ contentType }, async ({ options, requests }) => {
        await expect(uploadImmutableCar(options)).rejects.toThrow(/gateway readback failed/);
        expect(requests.map((r) => r.method)).toEqual(["HEAD"]);
      });
    },
  );

  it("does not record a receipt or create after a corrupt gateway CAR", async () => {
    const bytes = Buffer.from(reordered);
    bytes[bytes.length - 1] ^= 1;
    await withClient({ bytes }, async ({ options, requests }) => {
      await expect(uploadImmutableCar(options)).rejects.toThrow(/CAR_DAG_BLOCK_MISMATCH/);
      expect(requests.map((r) => r.method)).toEqual(["HEAD"]);
    });
  });

  it("creates nothing if the fresh authorization/predecessor guard fails", async () => {
    await withClient({ exists: false }, async ({ options, requests, beforeCreate, fetchImpl }) => {
      beforeCreate.mockRejectedValue(new Error("authorization expired or predecessor changed"));
      await expect(uploadImmutableCar(options)).rejects.toThrow(/authorization expired/);
      expect(requests.map((r) => r.method)).toEqual(["HEAD"]);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("refuses implicit PUT retries under the imported-DAG contract too", async () => {
    await withClient({ exists: false }, async ({ options, client, requests, beforeCreate }) => {
      client.config.maxAttempts = async () => 3;
      await expect(uploadImmutableCar(options)).rejects.toThrow(/maxAttempts=1/);
      expect(requests.map((r) => r.method)).toEqual(["HEAD"]);
      expect(beforeCreate).not.toHaveBeenCalled();
    });
  });
});
