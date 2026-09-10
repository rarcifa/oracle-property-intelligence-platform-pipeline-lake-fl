import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CAR_VERSION, readCarRoots, writeCarFile } from "../src/core/car.mjs";
import {
  UNIXFS_CHUNK_SIZE,
  buildUnixfsDirectory,
  computeRawCid,
  computeUnixfsFileCid,
} from "../src/core/cid.mjs";

const temporaryDirectories = [];

/**
 * @returns {Promise<string>} a fresh scratch directory removed after the test
 */
async function scratchDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "oracle-car-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("writeCarFile", () => {
  it("round-trips the root of a single-file DAG", async () => {
    const directory = await scratchDirectory();
    const file = computeUnixfsFileCid("hello world");
    const carPath = path.join(directory, "hello.car");
    const result = await writeCarFile({
      roots: [file.cid],
      blocks: file.blocks,
      outputPath: carPath,
    });
    expect(result.rootCid).toBe(file.cid);
    expect(result.path).toBe(carPath);
    expect(await readCarRoots(carPath)).toEqual([file.cid]);
  });

  it("round-trips the root of a nested multi-chunk directory DAG", async () => {
    const directory = await scratchDirectory();
    const big = computeUnixfsFileCid(new Uint8Array(UNIXFS_CHUNK_SIZE + 5));
    const small = computeUnixfsFileCid("small");
    const child = buildUnixfsDirectory([
      { name: "big.bin", cid: big.cid, size: big.size, blocks: big.blocks },
    ]);
    const root = buildUnixfsDirectory([
      { name: "data", cid: child.cid, size: child.size, blocks: child.blocks },
      {
        name: "small.txt",
        cid: small.cid,
        size: small.size,
        blocks: small.blocks,
      },
    ]);
    const carPath = path.join(directory, "nested", "snapshot.car");
    const result = await writeCarFile({
      roots: [root.cid],
      blocks: root.blocks,
      outputPath: carPath,
    });
    expect(await readCarRoots(carPath)).toEqual([root.cid]);
    expect(result.rootCid).toBe(root.cid);
  });

  it("reports the byte length and digest of the file it wrote", async () => {
    const directory = await scratchDirectory();
    const file = computeUnixfsFileCid("integrity");
    const carPath = path.join(directory, "integrity.car");
    const result = await writeCarFile({
      roots: file.cid,
      blocks: file.blocks,
      outputPath: carPath,
    });
    const onDisk = await readFile(carPath);
    expect(result.bytes).toBe(onDisk.length);
    expect(result.sha256).toBe(
      `sha256:${createHash("sha256").update(onDisk).digest("hex")}`,
    );
    expect(result.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("writes a CARv1 header that declares version 1", async () => {
    const directory = await scratchDirectory();
    const file = computeUnixfsFileCid("version");
    const carPath = path.join(directory, "version.car");
    await writeCarFile({
      roots: [file.cid],
      blocks: file.blocks,
      outputPath: carPath,
    });
    const car = await readFile(carPath);
    expect(CAR_VERSION).toBe(1);
    // The header is length-prefixed by a single-byte varint for these sizes.
    expect(car[0]).toBeGreaterThan(0);
    expect(car.length).toBeGreaterThan(car[0] + 1);
  });

  it("de-duplicates repeated blocks", async () => {
    const directory = await scratchDirectory();
    const file = computeUnixfsFileCid("duplicated");
    const once = await writeCarFile({
      roots: [file.cid],
      blocks: file.blocks,
      outputPath: path.join(directory, "once.car"),
    });
    const twice = await writeCarFile({
      roots: [file.cid],
      blocks: [...file.blocks, ...file.blocks],
      outputPath: path.join(directory, "twice.car"),
    });
    expect(twice.bytes).toBe(once.bytes);
    expect(twice.sha256).toBe(once.sha256);
  });

  it("refuses a root that is not among the blocks", async () => {
    const directory = await scratchDirectory();
    const file = computeUnixfsFileCid("present");
    await expect(
      writeCarFile({
        roots: [computeRawCid("absent")],
        blocks: file.blocks,
        outputPath: path.join(directory, "missing-root.car"),
      }),
    ).rejects.toThrow(/missing from the supplied blocks/);
  });

  it("refuses a block whose bytes do not hash to its CID", async () => {
    const directory = await scratchDirectory();
    await expect(
      writeCarFile({
        roots: [computeRawCid("claimed")],
        blocks: [
          {
            cid: computeRawCid("claimed"),
            bytes: new TextEncoder().encode("actual"),
          },
        ],
        outputPath: path.join(directory, "bad-block.car"),
      }),
    ).rejects.toThrow(/does not hash to its CID/);
  });

  it("refuses a CIDv0 root", async () => {
    const directory = await scratchDirectory();
    const file = computeUnixfsFileCid("v0");
    await expect(
      writeCarFile({
        roots: ["QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"],
        blocks: file.blocks,
        outputPath: path.join(directory, "v0.car"),
      }),
    ).rejects.toThrow(/CIDv1/);
  });
});

describe("readCarRoots", () => {
  it("rejects a truncated archive", async () => {
    const directory = await scratchDirectory();
    const file = computeUnixfsFileCid("truncated");
    const carPath = path.join(directory, "truncated.car");
    await writeCarFile({
      roots: [file.cid],
      blocks: file.blocks,
      outputPath: carPath,
    });
    const car = await readFile(carPath);
    const brokenPath = path.join(directory, "broken.car");
    await writeFile(brokenPath, car.subarray(0, 5));
    await expect(readCarRoots(brokenPath)).rejects.toThrow(/truncated/);
  });
});
