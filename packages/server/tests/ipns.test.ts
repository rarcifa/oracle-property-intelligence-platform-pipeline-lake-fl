/**
 * The runtime follows the published IPNS pointer rather than a CID baked in at
 * deploy time.
 *
 * The deployed function used to be handed `artifacts/latest.json`'s `rootCid`
 * as an environment value, so a scheduled publish moved the pointer and the
 * runtime went on serving the previous run until somebody ran `cdk deploy`.
 * These tests pin the replacement: resolve the name, take the CID it resolves
 * to, and fail loudly rather than fall back to a remembered one.
 */
import { describe, expect, it, vi } from "vitest";
import { IPNS_GATEWAYS } from "@oracle-lake/shared";
import {
  createIpnsResolver,
  IPNS_PROBE_PATHS,
  resolveIpnsRun,
  rootCidFromRootsHeader,
} from "../src/data/ipns.js";
import { resolveDataSource } from "../src/data/source.js";
import { loadConfig } from "../src/config.js";

const NAME = "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un";
const ROOT = "bafybeif5vpiyp2v5foc7k3swsgoujzlvo7exaspntdsrmc4tp5vkuok67q";
const CHILD = "bafkreiepkatrz7qjcklcld3if7nhygahd7ar32gbdbretcca5mprmeh6cy";

function answer(
  roots: string,
  body: unknown = { runId: "20260910T135850Z", propertyCount: 215806 },
) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "x-ipfs-roots": roots, "content-type": "application/json" },
  });
}

describe("rootCidFromRootsHeader", () => {
  it("takes the first CID, which is what the name resolved to", () => {
    // The header lists every CID along the path; the rest are objects inside
    // the snapshot that were walked to reach the probe file.
    expect(rootCidFromRootsHeader(`${ROOT},${CHILD}`)).toBe(ROOT);
  });

  it("refuses a missing or malformed header rather than inventing a CID", () => {
    expect(rootCidFromRootsHeader(null)).toBeNull();
    expect(rootCidFromRootsHeader("")).toBeNull();
    expect(rootCidFromRootsHeader("QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco")).toBeNull();
  });
});

describe("resolveIpnsRun", () => {
  it("probes every IPNS gateway and path, and reads the run id out of the response", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(answer(`${ROOT},${CHILD}`)));
    const pointer = await resolveIpnsRun(NAME, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(pointer).toMatchObject({
      ipnsName: NAME,
      rootCid: ROOT,
      runId: "20260910T135850Z",
      propertyCount: 215806,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(IPNS_GATEWAYS.length * IPNS_PROBE_PATHS.length);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `${IPNS_GATEWAYS[0]?.baseUrl}/ipns/${NAME}/index.json`,
    );
    // The preferred gateway wins a tie, so a healthy resolution is stable.
    expect(pointer.gateway).toBe(IPNS_GATEWAYS[0]?.baseUrl);
  });

  it("takes the newest run when gateways disagree", async () => {
    // Measured, not hypothetical: minutes after run 20260910T153418Z re-pointed
    // the name, ipfs.io served the new root while ipfs.filebase.io still served
    // the run before it from its own cache. Preferring the first answer would
    // have opened a superseded snapshot and reported it as current.
    const stale = ROOT;
    const fresh = "bafybeibshsx6h6xtbqb65at6oycndtpp3ufdou5i5unahulvtn46n4fr4m";
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(answer(stale, { runId: "20260910T135850Z", propertyCount: 215806 })),
      )
      .mockImplementation(() =>
        Promise.resolve(answer(fresh, { runId: "20260910T153418Z", propertyCount: 215806 })),
      );
    const pointer = await resolveIpnsRun(NAME, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(pointer.rootCid).toBe(fresh);
    expect(pointer.runId).toBe("20260910T153418Z");
  });

  it("moves past a gateway that will not serve IPNS", async () => {
    // Measured behaviour too: pinata and ipfs-lens answer 403 to every /ipns/
    // path, which is why they are not in IPNS_GATEWAYS at all.
    const fetchImpl = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          String(url).startsWith(`${IPNS_GATEWAYS[0]?.baseUrl}/`)
            ? new Response("no", { status: 403 })
            : answer(ROOT),
        ),
      );
    const pointer = await resolveIpnsRun(NAME, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(pointer.rootCid).toBe(ROOT);
    expect(pointer.gateway).not.toBe(IPNS_GATEWAYS[0]?.baseUrl);
  });

  it("takes a gateway's freshest path when its own caches disagree", async () => {
    // ipfs.filebase.io was measured serving index.json from one run and
    // coverage.json from a later one, in the same second. Where only one
    // gateway is reachable, probing both paths is what keeps that from pinning
    // the runtime to a superseded snapshot.
    const fresh = "bafybeibshsx6h6xtbqb65at6oycndtpp3ufdou5i5unahulvtn46n4fr4m";
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (!String(url).startsWith(`${IPNS_GATEWAYS[0]?.baseUrl}/`)) {
        return Promise.reject(new Error("HTTP 429"));
      }
      return Promise.resolve(
        String(url).endsWith("coverage.json")
          ? answer(fresh, { runId: "20260910T153418Z", propertyCount: 215806 })
          : answer(ROOT, { runId: "20260910T135850Z", propertyCount: 215806 }),
      );
    });
    const pointer = await resolveIpnsRun(NAME, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(pointer.rootCid).toBe(fresh);
    expect(pointer.gateway).toBe(IPNS_GATEWAYS[0]?.baseUrl);
  });

  it("still resolves when the body is not the index it expected", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response("<html>listing</html>", { status: 200, headers: { "x-ipfs-roots": ROOT } }),
        ),
      );
    const pointer = await resolveIpnsRun(NAME, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(pointer.rootCid).toBe(ROOT);
    expect(pointer.runId).toBeNull();
  });

  it("prefers a dateable answer over one it cannot order", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response("<html>listing</html>", { status: 200, headers: { "x-ipfs-roots": CHILD } }),
        ),
      )
      .mockImplementation(() => Promise.resolve(answer(ROOT)));
    const pointer = await resolveIpnsRun(NAME, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(pointer.rootCid).toBe(ROOT);
  });

  it("fails rather than falling back to a previously known CID", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      resolveIpnsRun(NAME, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/No gateway resolved IPNS name/);
    expect(fetchImpl).toHaveBeenCalledTimes(IPNS_GATEWAYS.length * IPNS_PROBE_PATHS.length);
  });
});

describe("createIpnsResolver", () => {
  it("resolves once per process and reuses the answer", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(answer(ROOT)));
    const resolver = createIpnsResolver({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const [first, second] = await Promise.all([resolver(NAME), resolver(NAME)]);
    expect(first.rootCid).toBe(ROOT);
    expect(second.rootCid).toBe(ROOT);
    expect(await resolver(NAME)).toMatchObject({ rootCid: ROOT });
    // One resolution, not one per call: every gateway/path probe runs once, then
    // the answer is reused for the container's lifetime.
    expect(fetchImpl).toHaveBeenCalledTimes(IPNS_GATEWAYS.length * IPNS_PROBE_PATHS.length);
  });

  it("does not cache a failure, so the next cold request is a real attempt", async () => {
    const fetchImpl = vi.fn();
    // Every IPNS gateway fails on the first resolution, none on the second.
    for (let attempt = 0; attempt < IPNS_GATEWAYS.length * IPNS_PROBE_PATHS.length; attempt += 1) {
      fetchImpl.mockImplementationOnce(() => Promise.resolve(new Response("no", { status: 502 })));
    }
    fetchImpl.mockImplementation(() => Promise.resolve(answer(ROOT)));
    const resolver = createIpnsResolver({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver(NAME)).rejects.toThrow(/No gateway resolved/);
    expect((await resolver(NAME)).rootCid).toBe(ROOT);
  });
});

describe("resolveDataSource", () => {
  const base = loadConfig({ ORACLE_PARQUET_URL: "", ORACLE_PARQUET_PATH: "" });

  it("uses an explicit source without touching the network", async () => {
    const resolve = vi.fn();
    const result = await resolveDataSource(
      { ...base, parquetSource: "/tmp/query-table.parquet", ipnsName: NAME },
      resolve,
    );
    expect(result).toEqual({ source: "/tmp/query-table.parquet", pointer: null });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("follows the IPNS name when nothing local names a dataset", async () => {
    const resolve = vi.fn().mockResolvedValue({
      ipnsName: NAME,
      rootCid: ROOT,
      runId: "20260910T135850Z",
      propertyCount: 215806,
      gateway: "https://ipfs.filebase.io",
    });
    const result = await resolveDataSource({ ...base, parquetSource: "", ipnsName: NAME }, resolve);
    expect(result.source).toContain(`/ipfs/${ROOT}/query-table.parquet`);
    expect(result.pointer?.runId).toBe("20260910T135850Z");
  });

  it("says what is missing when nothing names a dataset at all", async () => {
    await expect(
      resolveDataSource({ ...base, parquetSource: "", ipnsName: null }, vi.fn()),
    ).rejects.toThrow(/ORACLE_IPNS_NAME/);
  });
});
