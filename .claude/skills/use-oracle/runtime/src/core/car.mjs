/**
 * CARv1 writing and header read-back for published snapshot roots.
 *
 * A published CID is only useful if somebody else can hold the bytes. Handing
 * a consumer a directory CID alone forces them to re-fetch every block from a
 * gateway, and handing them the loose files forces them to re-encode the DAG
 * and hope they picked the same chunker. A CAR file avoids both: it carries
 * the exact blocks under the exact CIDs this runtime computed, so
 * `ipfs dag import` reproduces the snapshot bit for bit and re-pins the same
 * root. The format is deliberately implemented here rather than pulled in as a
 * dependency, because it is a varint-framed header plus varint-framed
 * `(cid, bytes)` records and nothing else.
 *
 * @module core/car
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";

/** CAR version this module writes and accepts. */
export const CAR_VERSION = 1;

/**
 * Encode an unsigned LEB128 varint, the length prefix used by CAR framing.
 *
 * @param {number} value non-negative safe integer
 * @returns {Uint8Array}
 */
function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("varint value must be a non-negative safe integer");
  }
  const out = [];
  let remaining = value;
  while (remaining >= 0x80) {
    out.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  out.push(remaining);
  return Uint8Array.from(out);
}

/**
 * Decode an unsigned LEB128 varint.
 *
 * @param {Uint8Array} bytes buffer to read from
 * @param {number} offset byte offset to start at
 * @returns {{ value: number, length: number }} decoded value and bytes consumed
 */
function decodeVarint(bytes, offset) {
  let value = 0;
  let shift = 1;
  for (let index = offset; index < bytes.length; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) {
        throw new Error("CAR varint exceeds the safe integer range");
      }
      return { value, length: index - offset + 1 };
    }
    shift *= 128;
    if (index - offset > 8) throw new Error("CAR varint is malformed");
  }
  throw new Error("CAR data ended inside a varint");
}

/**
 * @param {unknown} roots value to normalize
 * @returns {string[]} CIDv1 strings
 */
function normalizeRoots(roots) {
  const list = typeof roots === "string" ? [roots] : roots;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError("roots must be a non-empty array of CID strings");
  }
  return list.map((root) => {
    const cid = typeof root === "string" ? CID.parse(root) : CID.asCID(root);
    if (cid === null) throw new TypeError("roots must be CID strings");
    if (cid.version !== 1) throw new TypeError("roots must be CIDv1");
    return cid.toString();
  });
}

/**
 * Write a CARv1 file containing the given roots and blocks.
 *
 * Blocks are written in the order supplied, de-duplicated by CID, and each one
 * is checked against its own CID so a mislabelled block can never be shipped.
 * Every root must be present among the blocks, because the point of the file
 * is to be self-contained.
 *
 * @param {{ roots: string[] | string, blocks: Array<{ cid: string, bytes: Uint8Array }>, outputPath: string }} options
 *   roots to record in the header, the blocks of the DAG, and the file to write
 * @returns {Promise<{ path: string, bytes: number, sha256: string, rootCid: string }>}
 *   the written path, its byte length, its `sha256:<hex>` digest, and the first root
 */
export async function writeCarFile({ roots, blocks, outputPath }) {
  const rootCids = normalizeRoots(roots);
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new TypeError("blocks must be a non-empty array");
  }
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("outputPath is required");
  }
  const frames = [];
  const header = dagCbor.encode({
    roots: rootCids.map((root) => CID.parse(root)),
    version: CAR_VERSION,
  });
  frames.push(encodeVarint(header.length), header);
  const seen = new Set();
  for (const block of blocks) {
    if (!(block?.bytes instanceof Uint8Array)) {
      throw new TypeError(
        `block ${block?.cid ?? "?"} must carry Uint8Array bytes`,
      );
    }
    const cid = CID.parse(block.cid);
    if (cid.version !== 1) {
      throw new TypeError(`block ${block.cid} must be addressed by a CIDv1`);
    }
    if (cid.multihash.code !== 0x12) {
      throw new TypeError(`block ${block.cid} must be addressed by sha2-256`);
    }
    const digest = createHash("sha256").update(block.bytes).digest();
    if (Buffer.compare(digest, Buffer.from(cid.multihash.digest)) !== 0) {
      throw new Error(`block ${block.cid} does not hash to its CID`);
    }
    if (seen.has(block.cid)) continue;
    seen.add(block.cid);
    frames.push(
      encodeVarint(cid.bytes.length + block.bytes.length),
      cid.bytes,
      block.bytes,
    );
  }
  for (const root of rootCids) {
    if (!seen.has(root)) {
      throw new Error(`CAR root ${root} is missing from the supplied blocks`);
    }
  }
  const car = Buffer.concat(frames.map((frame) => Buffer.from(frame)));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, car);
  return {
    path: outputPath,
    bytes: car.length,
    sha256: `sha256:${createHash("sha256").update(car).digest("hex")}`,
    rootCid: rootCids[0],
  };
}

/**
 * Read the roots declared by a CARv1 file, used to prove a written archive
 * round-trips back to the root that was published.
 *
 * @param {string} carPath path to a CARv1 file
 * @returns {Promise<string[]>} the declared roots as CIDv1 base32 strings
 */
export async function readCarRoots(carPath) {
  const car = await readFile(carPath);
  const { value: headerLength, length: prefixLength } = decodeVarint(car, 0);
  if (headerLength === 0) throw new Error("CAR header is empty");
  if (prefixLength + headerLength > car.length) {
    throw new Error("CAR header is truncated");
  }
  const header = dagCbor.decode(
    car.subarray(prefixLength, prefixLength + headerLength),
  );
  if (header?.version !== CAR_VERSION) {
    throw new Error(`Unsupported CAR version ${String(header?.version)}`);
  }
  if (!Array.isArray(header.roots) || header.roots.length === 0) {
    throw new Error("CAR header declares no roots");
  }
  return header.roots.map((root) => {
    const cid = CID.asCID(root);
    if (cid === null) throw new Error("CAR header root is not a CID");
    return cid.toString();
  });
}
