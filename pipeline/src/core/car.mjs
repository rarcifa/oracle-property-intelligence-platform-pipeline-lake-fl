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
import * as dagPB from "@ipld/dag-pb";
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
      throw new TypeError(`block ${block?.cid ?? "?"} must carry Uint8Array bytes`);
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
    frames.push(encodeVarint(cid.bytes.length + block.bytes.length), cid.bytes, block.bytes);
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
  const header = dagCbor.decode(car.subarray(prefixLength, prefixLength + headerLength));
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

/**
 * Validate an importable archive, not just its header. Every addressed block
 * must hash correctly and every link reachable from every declared root must
 * be present. This checks the same bytes a third party will import, offline.
 * @param {Uint8Array} car CARv1 bytes
 * @returns {{ roots: string[], blocks: Array<{cid: string, bytes: Uint8Array}> }}
 */
export function validateCarArchive(car) {
  const prefix = decodeVarint(car, 0);
  const start = prefix.length + prefix.value;
  if (prefix.value === 0 || start > car.length) throw new Error("CAR header is truncated or empty");
  const header = dagCbor.decode(car.subarray(prefix.length, start));
  if (header?.version !== CAR_VERSION) throw new Error("Unsupported CAR version");
  const roots = normalizeRoots(header.roots);
  const blocks = new Map();
  let offset = start;
  while (offset < car.length) {
    const frame = decodeVarint(car, offset);
    offset += frame.length;
    const end = offset + frame.value;
    if (frame.value === 0 || end > car.length) throw new Error("CAR block is truncated or empty");
    const [cid, bytes] = CID.decodeFirst(car.subarray(offset, end));
    if (cid.version !== 1 || cid.multihash.code !== 0x12)
      throw new Error("CAR blocks require CIDv1 sha2-256");
    if (cid.code !== 0x55 && cid.code !== 0x70)
      throw new Error("CAR contains an unsupported DAG codec");
    const digest = createHash("sha256").update(bytes).digest();
    if (!digest.equals(Buffer.from(cid.multihash.digest)))
      throw new Error(`CAR block ${cid} does not hash to its CID`);
    blocks.set(cid.toString(), { cid: cid.toString(), bytes });
    offset = end;
  }
  const seen = new Set();
  const visit = (cidString) => {
    if (seen.has(cidString)) return;
    seen.add(cidString);
    const block = blocks.get(cidString);
    if (!block) throw new Error(`CAR is missing reachable block ${cidString}`);
    if (CID.parse(cidString).code === 0x70) {
      for (const link of dagPB.decode(block.bytes).Links) visit(link.Hash.toString());
    }
  };
  for (const root of roots) visit(root);
  return { roots, blocks: [...blocks.values()] };
}

/**
 * Sum unique CID-bound block bytes for one complete frozen DAG. This excludes
 * CAR framing and differs from decoded UnixFS file bytes. Lighthouse reported
 * this representation for the observed Lake imports; it is not a universal
 * provider-size guarantee or proof of remote retention.
 * @param {Uint8Array} car Frozen CARv1 transport.
 * @param {string} expectedCid Exact single root CID.
 * @returns {number} Unique root-reachable block bytes.
 */
export function computeCarDagBlockBytes(car, expectedCid) {
  const validated = validateCarArchive(car);
  if (validated.roots.length !== 1 || validated.roots[0] !== expectedCid)
    throw new Error("DAG byte measurement requires the exact single frozen root");
  const blocks = new Map(validated.blocks.map((block) => [block.cid, block.bytes]));
  const pending = [expectedCid];
  const seen = new Set();
  let bytes = 0;
  while (pending.length > 0) {
    const cid = pending.pop();
    if (seen.has(cid)) continue;
    seen.add(cid);
    const block = blocks.get(cid);
    bytes += block.byteLength;
    if (!Number.isSafeInteger(bytes)) throw new Error("DAG byte measurement exceeds safe range");
    if (CID.parse(cid).code === 0x70)
      for (const link of dagPB.decode(block).Links) pending.push(link.Hash.toString());
  }
  if (seen.size !== blocks.size)
    throw new Error("DAG byte measurement rejects unreachable CAR blocks");
  return bytes;
}

/**
 * Prove a complete imported DAG, independently of CAR record ordering.
 * Filebase imports CAR blocks; an IPFS export is not the original upload file.
 * Only one bounded block is allocated at a time; local blocks remain views.
 * @param {{body: AsyncIterable<Uint8Array> & {destroy: () => void}, expected: Buffer, signal: AbortSignal}} options
 * @returns {Promise<{representation: "imported-dag", roots: string[], verifiedBlocks: number, exportedBytes: number, exportedSha256: string}>}
 */
export async function verifyImportedCarStream({ body, expected, signal }) {
  const local = validateCarArchive(expected);
  const blocks = new Map(local.blocks.map((block) => [block.cid, block.bytes]));
  const seen = new Set();
  const maxFrame = local.blocks.reduce(
    (maximum, block) => Math.max(maximum, CID.parse(block.cid).bytes.length + block.bytes.length),
    65536,
  );
  const maxBytes = expected.length + (blocks.size + 1) * 9 + 4096;
  const hash = createHash("sha256");
  const iterator = body[Symbol.asyncIterator]();
  let chunk = Buffer.alloc(0);
  let offset = 0;
  let received = 0;
  const fail = (code) => {
    throw Object.assign(new Error(code), { code });
  };
  const destroy = () => body.destroy();
  const refill = async () => {
    signal.throwIfAborted();
    while (offset === chunk.length) {
      const next = await iterator.next();
      signal.throwIfAborted();
      if (next.done) return false;
      if (!(next.value instanceof Uint8Array)) fail("CAR_DAG_UNREADABLE");
      chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      offset = 0;
      received += chunk.length;
      if (received > maxBytes) fail("CAR_DAG_OVERSIZED");
      hash.update(chunk);
    }
    return true;
  };
  const readByte = async (allowEnd = false) => {
    if (!(await refill())) {
      if (allowEnd) return null;
      fail("CAR_DAG_TRUNCATED");
    }
    return chunk[offset++];
  };
  const readLength = async (allowEnd = false) => {
    let value = 0;
    let scale = 1;
    for (let index = 0; index < 9; index++) {
      const byte = await readByte(allowEnd && index === 0);
      if (byte === null) return null;
      value += (byte & 0x7f) * scale;
      if (!Number.isSafeInteger(value) || value > maxFrame) fail("CAR_DAG_FRAME_LIMIT");
      if ((byte & 0x80) === 0) {
        if (value === 0) fail("CAR_DAG_EMPTY_FRAME");
        return value;
      }
      scale *= 128;
    }
    fail("CAR_DAG_FRAME_LIMIT");
  };
  const readFrame = async (length) => {
    const frame = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      if (!(await refill())) fail("CAR_DAG_TRUNCATED");
      const count = Math.min(length - written, chunk.length - offset);
      chunk.copy(frame, written, offset, offset + count);
      offset += count;
      written += count;
    }
    return frame;
  };
  signal.addEventListener("abort", destroy, { once: true });
  try {
    signal.throwIfAborted();
    const header = dagCbor.decode(await readFrame(await readLength()));
    const roots = normalizeRoots(header?.roots);
    if (
      header?.version !== CAR_VERSION ||
      Object.keys(header).sort().join(",") !== "roots,version" ||
      JSON.stringify(roots) !== JSON.stringify(local.roots)
    )
      fail("CAR_DAG_ROOT_MISMATCH");
    for (;;) {
      const length = await readLength(true);
      if (length === null) break;
      const [cid, bytes] = CID.decodeFirst(await readFrame(length));
      const name = cid.toString();
      const frozen = blocks.get(name);
      if (seen.has(name)) fail("CAR_DAG_DUPLICATE_BLOCK");
      if (!frozen) fail("CAR_DAG_UNEXPECTED_BLOCK");
      if (
        !Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(frozen) ||
        !createHash("sha256").update(bytes).digest().equals(Buffer.from(cid.multihash.digest))
      )
        fail("CAR_DAG_BLOCK_MISMATCH");
      seen.add(name);
    }
    if (seen.size !== blocks.size) fail("CAR_DAG_MISSING_BLOCK");
    signal.throwIfAborted();
    // The local archive already proved reachability; identical roots and every
    // identical block prove the same complete graph, not merely a root node.
    return {
      representation: "imported-dag",
      roots: local.roots,
      verifiedBlocks: seen.size,
      exportedBytes: received,
      exportedSha256: `sha256:${hash.digest("hex")}`,
    };
  } catch (error) {
    destroy();
    const code = signal.aborted
      ? "CAR_DAG_TIMEOUT"
      : [
            "CAR_DAG_UNREADABLE",
            "CAR_DAG_OVERSIZED",
            "CAR_DAG_TRUNCATED",
            "CAR_DAG_FRAME_LIMIT",
            "CAR_DAG_EMPTY_FRAME",
            "CAR_DAG_ROOT_MISMATCH",
            "CAR_DAG_DUPLICATE_BLOCK",
            "CAR_DAG_UNEXPECTED_BLOCK",
            "CAR_DAG_BLOCK_MISMATCH",
            "CAR_DAG_MISSING_BLOCK",
          ].includes(error?.code)
        ? error.code
        : "CAR_DAG_READ_FAILED";
    throw new Error(
      `Imported CAR DAG readback failed: received=${received} verifiedBlocks=${seen.size}/${blocks.size} code=${code}`,
    );
  } finally {
    signal.removeEventListener("abort", destroy);
  }
}
