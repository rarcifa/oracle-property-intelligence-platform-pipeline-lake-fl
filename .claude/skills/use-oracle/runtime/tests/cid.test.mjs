import * as dagPB from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { describe, expect, it } from "vitest";

import {
  MAX_CHILDREN_PER_NODE,
  UNIXFS_CHUNK_SIZE,
  buildUnixfsDirectory,
  computeRawCid,
  computeUnixfsFileCid,
  isCidV1Base32,
  sha256Hex,
} from "../src/core/cid.mjs";

/**
 * Deterministic filler so the multi-chunk vectors below can never drift with
 * the machine that runs them.
 *
 * @param {number} size byte length
 * @returns {Uint8Array}
 */
function pattern(size) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + 7) % 251;
  }
  return bytes;
}

describe("sha256Hex", () => {
  it("digests utf8 text and raw bytes identically", () => {
    expect(sha256Hex("hello world")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    expect(sha256Hex(new TextEncoder().encode("hello world"))).toBe(
      sha256Hex("hello world"),
    );
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("computeRawCid", () => {
  it("matches the published raw CIDv1 vectors", () => {
    expect(computeRawCid("hello world")).toBe(
      "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e",
    );
    expect(computeRawCid(new Uint8Array(0))).toBe(
      "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    );
  });

  it("always returns a CIDv1 base32 string", () => {
    const cid = computeRawCid("lake county");
    expect(cid.startsWith("b")).toBe(true);
    expect(isCidV1Base32(cid)).toBe(true);
  });

  it("rejects inputs that are not bytes", () => {
    expect(() => computeRawCid(42)).toThrow(/Uint8Array/);
  });
});

describe("computeUnixfsFileCid", () => {
  it("keeps a single-chunk file as one raw leaf", () => {
    const result = computeUnixfsFileCid("hello world");
    expect(result.cid).toBe(computeRawCid("hello world"));
    expect(result.blocks).toHaveLength(1);
    expect(result.size).toBe(11);
  });

  it("still produces a block for empty content", () => {
    const result = computeUnixfsFileCid(new Uint8Array(0));
    expect(result.cid).toBe(
      "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    );
    expect(result.blocks).toHaveLength(1);
  });

  it("builds a balanced DAG over a multi-chunk file", () => {
    const bytes = pattern(UNIXFS_CHUNK_SIZE * 2 + 1234);
    const result = computeUnixfsFileCid(bytes);
    expect(result.cid).toBe(
      "bafybeid6n53jrymcqioytjaz6yhogl2bt7whaezrdoc3vas422mamta7oy",
    );
    expect(result.cid.startsWith("bafybei")).toBe(true);
    expect(result.blocks).toHaveLength(4);
    expect(result.blocks.at(-1).cid).toBe(result.cid);
    expect(result.blocks.slice(0, 3).map((block) => block.cid)).toEqual([
      computeRawCid(bytes.subarray(0, UNIXFS_CHUNK_SIZE)),
      computeRawCid(bytes.subarray(UNIXFS_CHUNK_SIZE, UNIXFS_CHUNK_SIZE * 2)),
      computeRawCid(bytes.subarray(UNIXFS_CHUNK_SIZE * 2)),
    ]);
  });

  it("describes the file in its UnixFS root node", () => {
    const bytes = pattern(UNIXFS_CHUNK_SIZE * 2 + 1234);
    const result = computeUnixfsFileCid(bytes);
    const root = dagPB.decode(result.blocks.at(-1).bytes);
    const unixfs = UnixFS.unmarshal(root.Data);
    expect(unixfs.type).toBe("file");
    expect(root.Links).toHaveLength(3);
    expect(root.Links.every((link) => link.Name === "")).toBe(true);
    expect(unixfs.blockSizes.map(Number)).toEqual([
      UNIXFS_CHUNK_SIZE,
      UNIXFS_CHUNK_SIZE,
      1234,
    ]);
    expect(Number(unixfs.fileSize())).toBe(bytes.length);
    expect(result.size).toBeGreaterThan(bytes.length);
  });

  it("is deterministic", () => {
    const bytes = pattern(UNIXFS_CHUNK_SIZE + 1);
    expect(computeUnixfsFileCid(bytes).cid).toBe(
      computeUnixfsFileCid(bytes).cid,
    );
  });

  it("chunks at 262144 bytes with the go-ipfs fan-out", () => {
    expect(UNIXFS_CHUNK_SIZE).toBe(262144);
    expect(MAX_CHILDREN_PER_NODE).toBe(174);
  });
});

describe("buildUnixfsDirectory", () => {
  it("matches the published empty-directory CIDv1", () => {
    expect(buildUnixfsDirectory([]).cid).toBe(
      "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354",
    );
  });

  it("sorts entries so input order cannot change the CID", () => {
    const first = computeUnixfsFileCid("alpha");
    const second = computeUnixfsFileCid("beta");
    const forwards = buildUnixfsDirectory([
      { name: "a.txt", cid: first.cid, size: first.size },
      { name: "b.txt", cid: second.cid, size: second.size },
    ]);
    const backwards = buildUnixfsDirectory([
      { name: "b.txt", cid: second.cid, size: second.size },
      { name: "a.txt", cid: first.cid, size: first.size },
    ]);
    expect(backwards.cid).toBe(forwards.cid);
  });

  it("carries child blocks through nested directories exactly once", () => {
    const file = computeUnixfsFileCid("nested");
    const child = buildUnixfsDirectory([
      { name: "leaf.txt", cid: file.cid, size: file.size, blocks: file.blocks },
    ]);
    const parent = buildUnixfsDirectory([
      { name: "child", cid: child.cid, size: child.size, blocks: child.blocks },
      { name: "leaf.txt", cid: file.cid, size: file.size, blocks: file.blocks },
    ]);
    const cids = parent.blocks.map((block) => block.cid);
    expect(new Set(cids).size).toBe(cids.length);
    expect(cids).toContain(file.cid);
    expect(cids).toContain(child.cid);
    expect(cids.at(-1)).toBe(parent.cid);
    expect(parent.size).toBeGreaterThan(child.size);
  });

  it("refuses malformed entries", () => {
    const file = computeUnixfsFileCid("x");
    expect(() =>
      buildUnixfsDirectory([
        { name: "a.txt", cid: file.cid, size: file.size },
        { name: "a.txt", cid: file.cid, size: file.size },
      ]),
    ).toThrow(/duplicate entry/);
    expect(() =>
      buildUnixfsDirectory([
        { name: "dir/a.txt", cid: file.cid, size: file.size },
      ]),
    ).toThrow(/single path segment/);
    expect(() =>
      buildUnixfsDirectory([
        {
          name: "a.txt",
          cid: "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
          size: 1,
        },
      ]),
    ).toThrow(/CIDv1/);
    expect(() =>
      buildUnixfsDirectory([{ name: "a.txt", cid: file.cid, size: -1 }]),
    ).toThrow(/non-negative size/);
  });
});

describe("isCidV1Base32", () => {
  it("accepts CIDv1 base32 and rejects everything else", () => {
    expect(isCidV1Base32(computeRawCid("x"))).toBe(true);
    expect(
      isCidV1Base32("QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"),
    ).toBe(false);
    expect(isCidV1Base32("not-a-cid")).toBe(false);
    expect(isCidV1Base32(null)).toBe(false);
  });
});
