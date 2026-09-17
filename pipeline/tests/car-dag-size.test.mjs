/** Offline frozen-DAG accounting fixtures; no provider calls or data changes. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CID } from "multiformats/cid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCarDagBlockBytes, writeCarFile } from "../src/core/car.mjs";
import { buildUnixfsDirectory, computeRawCid, computeUnixfsFileCid } from "../src/core/cid.mjs";

let directory;
let sequence = 0;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lake-dag-size-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function car(roots, blocks) {
  const outputPath = path.join(directory, `${sequence++}.car`);
  await writeCarFile({ roots, blocks, outputPath });
  return readFile(outputPath);
}
const uniqueBytes = (blocks) =>
  [...new Map(blocks.map((block) => [block.cid, block.bytes])).values()].reduce(
    (sum, bytes) => sum + bytes.byteLength,
    0,
  );

describe("unique CID-bound DAG block byte measurement", () => {
  it.each([Buffer.from('{"artifacts":[]}'), Buffer.alloc(0)])(
    "measures a raw manifest/file including zero bytes",
    async (bytes) => {
      const cid = computeRawCid(bytes);
      const transport = await car([cid], [{ cid, bytes }]);
      expect(computeCarDagBlockBytes(transport, cid)).toBe(bytes.length);
      expect(transport.length).toBeGreaterThan(bytes.length);
    },
  );

  it("measures a directory root with all descendants, separately from transport and file size", async () => {
    const file = computeUnixfsFileCid(Buffer.alloc(300_000, 7));
    const root = buildUnixfsDirectory([
      { name: "query-table.parquet", cid: file.cid, size: file.size },
    ]);
    const blocks = [...file.blocks, ...root.blocks];
    const transport = await car([root.cid], blocks);
    expect(computeCarDagBlockBytes(transport, root.cid)).toBe(uniqueBytes(blocks));
    expect(computeCarDagBlockBytes(transport, root.cid)).not.toBe(transport.length);
    expect(computeCarDagBlockBytes(transport, root.cid)).not.toBe(file.size);
  });

  it("measures a multiblock snapshot CAR file without redefining its logical bytes", async () => {
    const snapshot = Buffer.alloc(700_000, 7);
    const archive = computeUnixfsFileCid(snapshot);
    const transport = await car([archive.cid], archive.blocks);
    expect(archive.blocks.length).toBeGreaterThan(1);
    const expected = uniqueBytes(archive.blocks);
    expect(computeCarDagBlockBytes(transport, archive.cid)).toBe(expected);
    expect(expected).not.toBe(snapshot.length);
    expect(expected).not.toBe(transport.length);
  });

  it("counts a shared leaf CID once even when the UnixFS file references it repeatedly", async () => {
    const file = computeUnixfsFileCid(Buffer.alloc(700_000, 7));
    expect(new Set(file.blocks.map((block) => block.cid)).size).toBeLessThan(file.blocks.length);
    const transport = await car([file.cid], file.blocks);
    expect(computeCarDagBlockBytes(transport, file.cid)).toBe(uniqueBytes(file.blocks));
    expect(uniqueBytes(file.blocks)).toBeLessThan(
      file.blocks.reduce((sum, b) => sum + b.bytes.byteLength, 0),
    );
  });

  it("does not count duplicate CAR records or reordered framing twice", async () => {
    const bytes = Buffer.from("object");
    const cid = computeRawCid(bytes);
    const transport = await car([cid], [{ cid, bytes }]);
    const cidBytes = CID.parse(cid).bytes;
    const frameSize = cidBytes.length + bytes.length;
    expect(frameSize).toBeLessThan(128);
    const duplicate = Buffer.concat([transport, Buffer.from([frameSize]), cidBytes, bytes]);
    expect(computeCarDagBlockBytes(duplicate, cid)).toBe(bytes.length);
    const file = computeUnixfsFileCid(Buffer.alloc(300_000, 7));
    expect(
      computeCarDagBlockBytes(await car([file.cid], [...file.blocks].reverse()), file.cid),
    ).toBe(uniqueBytes(file.blocks));
  });

  it("rejects wrong or ambiguous roots", async () => {
    const a = Buffer.from("a"),
      b = Buffer.from("b");
    const aCid = computeRawCid(a),
      bCid = computeRawCid(b);
    expect(() => computeCarDagBlockBytes(Buffer.from([]), aCid)).toThrow();
    const single = await car([aCid], [{ cid: aCid, bytes: a }]);
    expect(() => computeCarDagBlockBytes(single, bCid)).toThrow(/exact single/);
    const multi = await car(
      [aCid, bCid],
      [
        { cid: aCid, bytes: a },
        { cid: bCid, bytes: b },
      ],
    );
    expect(() => computeCarDagBlockBytes(multi, aCid)).toThrow(/exact single/);
  });

  it("rejects incomplete, corrupt or unreachable block sets", async () => {
    const file = computeUnixfsFileCid(Buffer.alloc(300_000, 7));
    const missing = await car(
      [file.cid],
      file.blocks.filter((block) => block.cid === file.cid),
    );
    expect(() => computeCarDagBlockBytes(missing, file.cid)).toThrow(/missing reachable/);
    const extra = Buffer.from("not reachable");
    const added = await car(
      [file.cid],
      [...file.blocks, { cid: computeRawCid(extra), bytes: extra }],
    );
    expect(() => computeCarDagBlockBytes(added, file.cid)).toThrow(/unreachable/);
    const corrupted = await car([file.cid], file.blocks);
    corrupted[corrupted.length - 1] ^= 1;
    expect(() => computeCarDagBlockBytes(corrupted, file.cid)).toThrow(/does not hash/);
  });
});
