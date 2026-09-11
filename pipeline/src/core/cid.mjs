/**
 * Local CIDv1 computation for every object this runtime publishes.
 *
 * The bundled Filebase path uploads plain objects and accepts whatever CID the
 * provider assigns, which for a plain S3 PUT is a CIDv0 (`Qm...`, dag-pb,
 * base58). That is neither self-describing nor reproducible outside Filebase,
 * so a published snapshot cannot be re-derived or re-pinned by anybody else.
 * This module derives the identifiers locally instead, using the layout an
 * IPFS implementation produces by default: fixed 262144-byte chunks, raw
 * leaves, a balanced UnixFS file DAG, and dag-pb directory nodes. Every CID it
 * returns is a CIDv1 in lowercase base32 (`b...`), and every block it returns
 * is exactly the bytes that must be stored under that CID, so the same blocks
 * can be framed into a CAR file and pinned verbatim.
 *
 * @module core/cid
 */

import { createHash } from "node:crypto";
import * as dagPB from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

/** Multicodec code for the `raw` codec used by UnixFS leaves. */
export const RAW_CODE = 0x55;
/** Multicodec code for `dag-pb`, used by UnixFS file roots and directories. */
export const DAG_PB_CODE = 0x70;
/** Multihash code for sha2-256. */
export const SHA256_CODE = 0x12;
/** Fixed chunk size, in bytes, applied to every UnixFS file. */
export const UNIXFS_CHUNK_SIZE = 262144;
/** Fan-out of the balanced UnixFS layout; matches the go-ipfs default. */
export const MAX_CHILDREN_PER_NODE = 174;

/**
 * Coerce accepted byte inputs into a `Uint8Array` view.
 *
 * @param {Uint8Array | Buffer | string} value bytes, or utf8 text
 * @param {string} field field name used in the thrown error
 * @returns {Uint8Array}
 */
function asBytes(value, field) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  throw new TypeError(`${field} must be a Uint8Array, Buffer or string`);
}

/**
 * Lowercase hex sha2-256 of the raw bytes, without the `sha256:` prefix used
 * by manifests.
 *
 * @param {Uint8Array | Buffer | string} bytes content to digest
 * @returns {string} 64 lowercase hex characters
 */
export function sha256Hex(bytes) {
  return createHash("sha256").update(asBytes(bytes, "bytes")).digest("hex");
}

/**
 * Build a sha2-256 multihash without touching the async WebCrypto path, so
 * every CID helper in this module stays synchronous and deterministic.
 *
 * @param {Uint8Array} bytes content to digest
 * @returns {import("multiformats/hashes/digest").Digest<18, number>}
 */
function sha256Multihash(bytes) {
  return Digest.create(
    SHA256_CODE,
    createHash("sha256").update(bytes).digest(),
  );
}

/**
 * CIDv1 of arbitrary bytes stored as a single raw block.
 *
 * @param {Uint8Array | Buffer | string} bytes block content
 * @returns {string} CIDv1, raw codec, sha2-256, lowercase base32
 */
export function computeRawCid(bytes) {
  const content = asBytes(bytes, "bytes");
  return CID.create(1, RAW_CODE, sha256Multihash(content)).toString();
}

/**
 * Split content into the fixed-size chunks used as UnixFS leaves.
 *
 * @param {Uint8Array} bytes file content
 * @returns {Uint8Array[]} at least one chunk, even for empty content
 */
function chunkContent(bytes) {
  if (bytes.length === 0) return [bytes];
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += UNIXFS_CHUNK_SIZE) {
    chunks.push(bytes.subarray(offset, offset + UNIXFS_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * Encode one intermediate UnixFS file node over already-built children.
 *
 * @param {Array<{ cid: string, size: number, fileSize: number }>} children ordered children
 * @returns {{ node: { cid: string, size: number, fileSize: number }, block: { cid: string, bytes: Uint8Array } }}
 */
function encodeFileNode(children) {
  const unixfs = new UnixFS({
    type: "file",
    blockSizes: children.map((child) => BigInt(child.fileSize)),
  });
  const bytes = dagPB.encode(
    dagPB.prepare({
      Data: unixfs.marshal(),
      Links: children.map((child) => ({
        Name: "",
        Tsize: child.size,
        Hash: CID.parse(child.cid),
      })),
    }),
  );
  const cid = CID.create(1, DAG_PB_CODE, sha256Multihash(bytes)).toString();
  return {
    node: {
      cid,
      size:
        bytes.length + children.reduce((total, child) => total + child.size, 0),
      fileSize: children.reduce((total, child) => total + child.fileSize, 0),
    },
    block: { cid, bytes },
  };
}

/**
 * CIDv1 of a UnixFS file with raw leaves and a balanced layout.
 *
 * Content of 262144 bytes or less is a single raw block, so its CID equals
 * `computeRawCid`. Larger content is chunked, each chunk becomes a raw leaf,
 * and the leaves are reduced into balanced dag-pb file nodes until one root
 * remains.
 *
 * @param {Uint8Array | Buffer | string} bytes file content
 * @returns {{ cid: string, size: number, blocks: Array<{ cid: string, bytes: Uint8Array }> }}
 *   the root CID, the cumulative DAG size to use as a parent link `size`, and
 *   every block of the DAG in dependency order (leaves first)
 */
export function computeUnixfsFileCid(bytes) {
  const content = asBytes(bytes, "bytes");
  const chunks = chunkContent(content);
  const blocks = [];
  let level = chunks.map((chunk) => {
    const cid = computeRawCid(chunk);
    blocks.push({ cid, bytes: chunk });
    return { cid, size: chunk.length, fileSize: chunk.length };
  });
  while (level.length > 1) {
    const parents = [];
    for (
      let offset = 0;
      offset < level.length;
      offset += MAX_CHILDREN_PER_NODE
    ) {
      const group = level.slice(offset, offset + MAX_CHILDREN_PER_NODE);
      const { node, block } = encodeFileNode(group);
      blocks.push(block);
      parents.push(node);
    }
    level = parents;
  }
  return { cid: level[0].cid, size: level[0].size, blocks };
}

/**
 * Compare two directory entry names the way dag-pb orders links: by UTF-8
 * bytes, not by JavaScript code units.
 *
 * @param {string} left first name
 * @param {string} right second name
 * @returns {number}
 */
function compareNames(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Build a dag-pb UnixFS directory node over already-published entries.
 *
 * Entries may be files or other directories, so nesting is expressed by
 * passing the `cid`, `size` and `blocks` returned by a previous call to this
 * function or to `computeUnixfsFileCid`. Child blocks are carried through and
 * de-duplicated so the caller ends up with the whole DAG in one array.
 *
 * @param {Array<{ name: string, cid: string, size: number, blocks?: Array<{ cid: string, bytes: Uint8Array }> }>} entries
 *   directory entries; `size` is the cumulative DAG size of the entry
 * @returns {{ cid: string, size: number, bytes: Uint8Array, blocks: Array<{ cid: string, bytes: Uint8Array }> }}
 *   the directory CID, its cumulative DAG size, the encoded dag-pb node bytes
 *   the CID addresses, and every block of the subtree. `bytes` is returned
 *   because a directory has no content of its own beyond that node: it is the
 *   only thing a caller can honestly digest for a directory entry.
 */
export function buildUnixfsDirectory(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("entries must be an array of directory entries");
  }
  const names = new Set();
  const sorted = [...entries].sort((left, right) =>
    compareNames(String(left?.name), String(right?.name)),
  );
  for (const entry of sorted) {
    if (typeof entry?.name !== "string" || entry.name.length === 0) {
      throw new TypeError("each directory entry needs a non-empty name");
    }
    if (entry.name.includes("/")) {
      throw new TypeError(
        `directory entry '${entry.name}' must be a single path segment`,
      );
    }
    if (names.has(entry.name)) {
      throw new Error(`directory contains duplicate entry '${entry.name}'`);
    }
    names.add(entry.name);
    if (!isCidV1Base32(entry.cid)) {
      throw new TypeError(
        `directory entry '${entry.name}' must carry a CIDv1 base32 string`,
      );
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new TypeError(
        `directory entry '${entry.name}' must carry a non-negative size`,
      );
    }
  }
  const bytes = dagPB.encode(
    dagPB.prepare({
      Data: new UnixFS({ type: "directory" }).marshal(),
      Links: sorted.map((entry) => ({
        Name: entry.name,
        Tsize: entry.size,
        Hash: CID.parse(entry.cid),
      })),
    }),
  );
  const cid = CID.create(1, DAG_PB_CODE, sha256Multihash(bytes)).toString();
  const blocks = [];
  const seen = new Set();
  for (const entry of sorted) {
    for (const block of entry.blocks ?? []) {
      if (seen.has(block.cid)) continue;
      seen.add(block.cid);
      blocks.push(block);
    }
  }
  if (!seen.has(cid)) blocks.push({ cid, bytes });
  return {
    cid,
    size: bytes.length + sorted.reduce((total, entry) => total + entry.size, 0),
    bytes,
    blocks,
  };
}

/**
 * True when the value is a CIDv1 string in lowercase base32.
 *
 * @param {unknown} value candidate CID string
 * @returns {boolean}
 */
export function isCidV1Base32(value) {
  if (typeof value !== "string" || !value.startsWith("b")) return false;
  try {
    const cid = CID.parse(value);
    return cid.version === 1 && cid.toString() === value;
  } catch {
    return false;
  }
}
