import { describe, expect, it } from "vitest";

import { buildArtifactManifest } from "../src/core/artifact-manifest.mjs";
import {
  buildUnixfsDirectory,
  computeUnixfsFileCid,
  sha256Hex,
} from "../src/core/cid.mjs";
import {
  DEFAULT_GATEWAYS,
  verifyArtifactAcrossGateways,
  verifyManifestAcrossGateways,
} from "../src/core/gateway-verify.mjs";

const body = "parcel,owner\n1,ACME\n";
const file = computeUnixfsFileCid(body);
const expectedSha256 = `sha256:${sha256Hex(body)}`;

/**
 * Build a fake `fetch` that answers per gateway host, records the URLs it was
 * asked for, and never touches the network.
 *
 * @param {Record<string, { status?: number, body?: string, throws?: string }>} routes host -> reply
 * @returns {{ fetchImpl: (input: string) => Promise<Response>, calls: string[] }}
 */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(input);
    const host = new URL(input).host;
    const route = routes[host];
    if (route === undefined) return { status: 404 };
    if (route.throws !== undefined) throw new Error(route.throws);
    const bytes = new TextEncoder().encode(route.body ?? "");
    return {
      status: route.status ?? 200,
      arrayBuffer: async () => bytes.buffer.slice(0, bytes.byteLength),
    };
  };
  return { fetchImpl, calls };
}

const sleepCalls = [];
/**
 * @param {number} ms requested delay
 * @returns {Promise<void>}
 */
async function recordSleep(ms) {
  sleepCalls.push(ms);
}

describe("DEFAULT_GATEWAYS", () => {
  it("puts the fastest, most reliable gateways first and the rate-limiting ones last", () => {
    expect(DEFAULT_GATEWAYS).toEqual([
      "https://ipfs.filebase.io",
      "https://gw.ipfs-lens.dev",
      "https://gateway.pinata.cloud",
      "https://ipfs.io",
      "https://dweb.link",
    ]);
    expect(DEFAULT_GATEWAYS.indexOf("https://ipfs.io")).toBeGreaterThan(
      DEFAULT_GATEWAYS.indexOf("https://gw.ipfs-lens.dev"),
    );
  });
});

describe("verifyArtifactAcrossGateways", () => {
  it("passes when two independent gateways return matching bytes", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "gateway.pinata.cloud": { body },
      "gw.ipfs-lens.dev": { body },
    });
    const report = await verifyArtifactAcrossGateways({
      cid: file.cid,
      expectedSize: body.length,
      expectedSha256,
      gateways: ["https://gateway.pinata.cloud", "https://gw.ipfs-lens.dev"],
      fetchImpl,
      sleep: recordSleep,
    });
    expect(report.verified).toBe(true);
    expect(report.matchedGateways).toEqual([
      "https://gateway.pinata.cloud",
      "https://gw.ipfs-lens.dev",
    ]);
    expect(calls).toEqual([
      `https://gateway.pinata.cloud/ipfs/${file.cid}`,
      `https://gw.ipfs-lens.dev/ipfs/${file.cid}`,
    ]);
    expect(report.results.every((result) => result.ok)).toBe(true);
    expect(report.results[0]).toEqual({
      gateway: "https://gateway.pinata.cloud",
      ok: true,
      status: 200,
      bytes: body.length,
      sha256: expectedSha256,
      error: null,
    });
  });

  it("requests gateways sequentially with a delay between them", async () => {
    sleepCalls.length = 0;
    const { fetchImpl } = fakeFetch({
      "gateway.pinata.cloud": { body },
      "gw.ipfs-lens.dev": { body },
    });
    await verifyArtifactAcrossGateways({
      cid: file.cid,
      expectedSize: body.length,
      expectedSha256,
      gateways: ["https://gateway.pinata.cloud", "https://gw.ipfs-lens.dev"],
      fetchImpl,
      delayMs: 1500,
      sleep: recordSleep,
    });
    expect(sleepCalls).toEqual([1500]);
  });

  it("fails when only one gateway matches", async () => {
    const { fetchImpl } = fakeFetch({
      "gateway.pinata.cloud": { body },
      "gw.ipfs-lens.dev": { status: 504 },
    });
    const report = await verifyArtifactAcrossGateways({
      cid: file.cid,
      expectedSize: body.length,
      expectedSha256,
      gateways: ["https://gateway.pinata.cloud", "https://gw.ipfs-lens.dev"],
      fetchImpl,
      sleep: recordSleep,
    });
    expect(report.verified).toBe(false);
    expect(report.matchedGateways).toEqual(["https://gateway.pinata.cloud"]);
    expect(report.results[1]).toMatchObject({ ok: false, status: 504 });
  });

  it("fails on a digest mismatch even when the size matches", async () => {
    const tampered = "parcel,owner\n1,EVIL\n";
    expect(tampered.length).toBe(body.length);
    const { fetchImpl } = fakeFetch({
      "gateway.pinata.cloud": { body },
      "gw.ipfs-lens.dev": { body: tampered },
    });
    const report = await verifyArtifactAcrossGateways({
      cid: file.cid,
      expectedSize: body.length,
      expectedSha256,
      gateways: ["https://gateway.pinata.cloud", "https://gw.ipfs-lens.dev"],
      fetchImpl,
      sleep: recordSleep,
    });
    expect(report.verified).toBe(false);
    expect(report.results[1]).toMatchObject({
      ok: false,
      status: 200,
      bytes: body.length,
      sha256: `sha256:${sha256Hex(tampered)}`,
    });
    expect(report.results[1].error).toMatch(/received 20 bytes/);
  });

  it("tolerates a 429 from one gateway and still verifies on the others", async () => {
    const { fetchImpl } = fakeFetch({
      "ipfs.io": { status: 429 },
      "gateway.pinata.cloud": { body },
      "gw.ipfs-lens.dev": { body },
    });
    const report = await verifyArtifactAcrossGateways({
      cid: file.cid,
      expectedSize: body.length,
      expectedSha256,
      gateways: [
        "https://ipfs.io",
        "https://gateway.pinata.cloud",
        "https://gw.ipfs-lens.dev",
      ],
      fetchImpl,
      sleep: recordSleep,
    });
    expect(report.verified).toBe(true);
    expect(report.results[0]).toMatchObject({
      gateway: "https://ipfs.io",
      ok: false,
      status: 429,
      error: "HTTP 429",
    });
    expect(report.matchedGateways).toHaveLength(2);
  });

  it("tolerates a thrown network error", async () => {
    const { fetchImpl } = fakeFetch({
      "dweb.link": { throws: "socket hang up" },
      "gateway.pinata.cloud": { body },
      "gw.ipfs-lens.dev": { body },
    });
    const report = await verifyArtifactAcrossGateways({
      cid: file.cid,
      expectedSize: body.length,
      expectedSha256,
      gateways: [
        "https://dweb.link",
        "https://gateway.pinata.cloud",
        "https://gw.ipfs-lens.dev",
      ],
      fetchImpl,
      sleep: recordSleep,
    });
    expect(report.verified).toBe(true);
    expect(report.results[0]).toMatchObject({
      ok: false,
      status: null,
      error: "socket hang up",
    });
  });

  it("never counts the same host twice", async () => {
    const { fetchImpl } = fakeFetch({ "gateway.pinata.cloud": { body } });
    const report = await verifyArtifactAcrossGateways({
      cid: file.cid,
      expectedSize: body.length,
      expectedSha256,
      gateways: [
        "https://gateway.pinata.cloud",
        "https://gateway.pinata.cloud/",
      ],
      fetchImpl,
      sleep: recordSleep,
    });
    expect(report.verified).toBe(false);
    expect(report.matchedGateways).toEqual(["https://gateway.pinata.cloud"]);
  });

  it("honours a raised minimum", async () => {
    const { fetchImpl } = fakeFetch({
      "gateway.pinata.cloud": { body },
      "gw.ipfs-lens.dev": { body },
    });
    const report = await verifyArtifactAcrossGateways({
      cid: file.cid,
      expectedSize: body.length,
      expectedSha256,
      gateways: ["https://gateway.pinata.cloud", "https://gw.ipfs-lens.dev"],
      minimumIndependentGateways: 3,
      fetchImpl,
      sleep: recordSleep,
    });
    expect(report.verified).toBe(false);
    expect(report.minimumIndependentGateways).toBe(3);
  });

  it("refuses inputs it cannot check honestly", async () => {
    const { fetchImpl } = fakeFetch({});
    await expect(
      verifyArtifactAcrossGateways({
        cid: file.cid,
        expectedSize: body.length,
        expectedSha256: sha256Hex(body),
        fetchImpl,
        sleep: recordSleep,
      }),
    ).rejects.toThrow(/sha256:<64-hex>/);
    await expect(
      verifyArtifactAcrossGateways({
        cid: file.cid,
        expectedSize: -1,
        expectedSha256,
        fetchImpl,
        sleep: recordSleep,
      }),
    ).rejects.toThrow(/expectedSize/);
  });
});

describe("verifyManifestAcrossGateways", () => {
  const coverageBody = '{"county":"lake"}\n';
  const coverage = computeUnixfsFileCid(coverageBody);
  const root = buildUnixfsDirectory([
    {
      name: "properties.csv",
      cid: file.cid,
      size: file.size,
      blocks: file.blocks,
    },
    {
      name: "dataset-coverage.json",
      cid: coverage.cid,
      size: coverage.size,
      blocks: coverage.blocks,
    },
  ]);
  const manifest = buildArtifactManifest({
    runId: "2026-09-09T00-00-00Z",
    county: "lake",
    generatedAt: "2026-09-09T00:00:00.000Z",
    rootCid: root.cid,
    rootCarPath: "lake.car",
    entries: [
      {
        cid: root.cid,
        name: ".",
        size: root.size,
        codec: "directory",
        sha256: `sha256:${sha256Hex(root.bytes)}`,
      },
      {
        cid: file.cid,
        name: "properties.csv",
        size: body.length,
        codec: "file",
        sha256: expectedSha256,
      },
      {
        cid: coverage.cid,
        name: "dataset-coverage.json",
        size: coverageBody.length,
        codec: "file",
        sha256: `sha256:${sha256Hex(coverageBody)}`,
      },
    ],
  });

  it("verifies every file entry and skips directory entries", async () => {
    const bodies = new Map([
      [file.cid, body],
      [coverage.cid, coverageBody],
    ]);
    const calls = [];
    const fetchImpl = async (input) => {
      calls.push(input);
      const cid = input.split("/ipfs/")[1];
      const bytes = new TextEncoder().encode(bodies.get(cid) ?? "");
      return {
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(0, bytes.byteLength),
      };
    };
    const summary = await verifyManifestAcrossGateways({
      manifest,
      gateways: ["https://gateway.pinata.cloud", "https://gw.ipfs-lens.dev"],
      fetchImpl,
      sleep: recordSleep,
    });
    expect(summary.verified).toBe(true);
    expect(summary.checkedArtifacts).toBe(2);
    expect(summary.verifiedArtifacts).toBe(2);
    expect(summary.runId).toBe("2026-09-09T00-00-00Z");
    expect(summary.county).toBe("lake");
    expect(summary.artifacts.map((artifact) => artifact.name)).toEqual([
      "dataset-coverage.json",
      "properties.csv",
    ]);
    expect(calls).toHaveLength(4);
    expect(calls.some((url) => url.includes(root.cid))).toBe(false);
  });

  it("fails the summary when one artifact cannot be proven twice", async () => {
    const fetchImpl = async (input) => {
      const cid = input.split("/ipfs/")[1];
      if (cid === coverage.cid && input.includes("ipfs-lens")) {
        return { status: 429 };
      }
      const bytes = new TextEncoder().encode(
        cid === file.cid ? body : coverageBody,
      );
      return {
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(0, bytes.byteLength),
      };
    };
    const summary = await verifyManifestAcrossGateways({
      manifest,
      gateways: ["https://gateway.pinata.cloud", "https://gw.ipfs-lens.dev"],
      fetchImpl,
      sleep: recordSleep,
    });
    expect(summary.verified).toBe(false);
    expect(summary.verifiedArtifacts).toBe(1);
    expect(
      summary.artifacts.find(
        (artifact) => artifact.name === "dataset-coverage.json",
      ).verified,
    ).toBe(false);
  });

  it("rejects an invalid manifest and a bad concurrency", async () => {
    const fetchImpl = async () => ({
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      verifyManifestAcrossGateways({
        manifest: { schemaVersion: "nope" },
        fetchImpl,
      }),
    ).rejects.toThrow(/Invalid artifact manifest/);
    await expect(
      verifyManifestAcrossGateways({ manifest, concurrency: 0, fetchImpl }),
    ).rejects.toThrow(/concurrency/);
  });
});
