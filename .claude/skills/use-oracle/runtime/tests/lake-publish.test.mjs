import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRunDag, listFiles, parseArgs, readIpnsPointer, runIdToIso, runStatus } from "../scripts/lake/publish-run.mjs";
import { computeRawCid, isCidV1Base32, sha256Hex } from "../src/core/cid.mjs";
import { CID } from "multiformats/cid";

describe("run identifiers", () => {
  it("derives a stable ISO timestamp so a run's manifest CID is reproducible", () => {
    expect(runIdToIso("20260909T182356Z")).toBe("2026-09-09T18:23:56.000Z");
    expect(runIdToIso("20260909T182356Z")).toBe(runIdToIso("20260909T182356Z"));
  });

  it("refuses a run id that is not a compact UTC timestamp", () => {
    expect(() => runIdToIso("latest")).toThrow(/compact UTC timestamp/);
    expect(() => runIdToIso("2026-09-09T18:23:56Z")).toThrow(/compact UTC timestamp/);
  });
});

describe("run status", () => {
  it("reports succeeded only when every artifact verified", () => {
    expect(runStatus(false, [{ verified: true }, { verified: true }])).toBe("succeeded");
    expect(runStatus(false, [{ verified: true }, { verified: false }])).toBe("partial");
    expect(runStatus(false, [{ verified: false }])).toBe("failed");
  });

  it("never claims success for a dry run or an unverified run", () => {
    expect(runStatus(true, [{ verified: true }])).toBe("partial");
    expect(runStatus(false, [])).toBe("partial");
  });
});

describe("CLI flags", () => {
  it("parses valued and boolean flags", () => {
    expect(parseArgs(["--run-id", "20260909T182356Z", "--dry-run", "--mode", "incremental"])).toEqual({
      "run-id": "20260909T182356Z",
      "dry-run": true,
      mode: "incremental",
    });
  });
});

describe("IPNS readback", () => {
  const names = [
    {
      label: "oracle-open-data-lake",
      network_key: "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un",
      cid: "bafybeigb3grzqolyja5lefcf3pkfxb5tuhkdtbidnitigq4zzomivrltee",
      sequence: 4,
    },
    { label: "someone-elses-label", network_key: "k51other", cid: "bafyother", sequence: 1 },
  ];

  it("returns the county's own label and ignores others", async () => {
    const pointer = await readIpnsPointer("token", async () => ({ ok: true, status: 200, json: async () => names }));
    expect(pointer).toEqual({
      networkKey: "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un",
      cid: "bafybeigb3grzqolyja5lefcf3pkfxb5tuhkdtbidnitigq4zzomivrltee",
      sequence: 4,
    });
  });

  it("returns null when the label does not exist rather than guessing", async () => {
    const pointer = await readIpnsPointer("token", async () => ({
      ok: true,
      status: 200,
      json: async () => [names[1]],
    }));
    expect(pointer).toBeNull();
  });

  it("fails closed when the provider errors", async () => {
    await expect(
      readIpnsPointer("token", async () => ({ ok: false, status: 401, json: async () => [] })),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe("run DAG", () => {
  let runDir;

  beforeAll(async () => {
    runDir = await mkdtemp(path.join(tmpdir(), "lake-dag-"));
    await mkdir(path.join(runDir, "shards"), { recursive: true });
    await mkdir(path.join(runDir, "samples"), { recursive: true });
    await writeFile(path.join(runDir, "coverage.json"), '{"county":"lake"}\n', "utf8");
    await writeFile(path.join(runDir, "index.json"), '{"propertyCount":2}\n', "utf8");
    await writeFile(path.join(runDir, "shards", "shard-0000.json"), '{"shard":0}\n', "utf8");
    await writeFile(path.join(runDir, "samples", "aged-roofs.json"), '{"rows":[]}\n', "utf8");
  });

  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("lists nested files in a stable order", async () => {
    expect(await listFiles(runDir)).toEqual([
      "coverage.json",
      "index.json",
      "samples/aged-roofs.json",
      "shards/shard-0000.json",
    ]);
  });

  it("builds a CIDv1 DAG with an entry per file plus every directory", async () => {
    const dag = await buildRunDag(runDir);
    expect(isCidV1Base32(dag.rootCid)).toBe(true);
    const names = dag.entries.map((entry) => entry.name).sort();
    expect(names).toEqual(["/", "coverage.json", "index.json", "samples/", "samples/aged-roofs.json", "shards/", "shards/shard-0000.json"]);
    for (const entry of dag.entries) {
      expect(isCidV1Base32(entry.cid)).toBe(true);
      expect(entry.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(["file", "directory"]).toContain(entry.codec);
    }
    const coverage = dag.entries.find((entry) => entry.name === "coverage.json");
    expect(coverage.size).toBe(Buffer.byteLength('{"county":"lake"}\n', "utf8"));
    expect(coverage.cid).toBe(computeRawCid(Buffer.from('{"county":"lake"}\n', "utf8")));
  });

  it("digests a directory's dag-pb node, not its CID string", async () => {
    // The recorded digest was `sha256(cid_string)` for every directory, which
    // is derived from the identifier and therefore agrees with it no matter
    // what bytes a provider serves. A digest that cannot disagree verifies
    // nothing. For a dag-pb node the multihash inside the CID is the sha2-256
    // of exactly those bytes, so the entry must reproduce it.
    const dag = await buildRunDag(runDir);
    for (const entry of dag.entries.filter((candidate) => candidate.codec === "directory")) {
      const embedded = Buffer.from(CID.parse(entry.cid).multihash.digest).toString("hex");
      expect(entry.sha256).toBe(`sha256:${embedded}`);
      expect(entry.sha256).not.toBe(`sha256:${sha256Hex(Buffer.from(entry.cid, "utf8"))}`);
    }
  });

  it("claims no observed providers on an artifact nothing has served yet", async () => {
    const dag = await buildRunDag(runDir);
    for (const entry of dag.entries) {
      expect(Object.keys(entry)).not.toContain("origins");
    }
  });

  it("is deterministic: the same directory hashes to the same root", async () => {
    const first = await buildRunDag(runDir);
    const second = await buildRunDag(runDir);
    expect(second.rootCid).toBe(first.rootCid);
  });

  it("changes the root when any file changes, so a new run is a new CID", async () => {
    const before = await buildRunDag(runDir);
    await writeFile(path.join(runDir, "coverage.json"), '{"county":"lake","runId":"2"}\n', "utf8");
    const after = await buildRunDag(runDir);
    expect(after.rootCid).not.toBe(before.rootCid);
  });
});
