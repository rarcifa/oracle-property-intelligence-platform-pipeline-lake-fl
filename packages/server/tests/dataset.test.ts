/**
 * The published pointer must not be on the startup path, and a gateway outage
 * must not be a runtime outage.
 *
 * Resolving IPNS at cold start was correct and slow — four gateways and two
 * probe paths in front of the first byte a caller sees — and it left the
 * process with nothing to serve when no gateway answered, for data that is
 * immutable and already published. These tests pin the replacement: open on the
 * last verified pointer, check the live name behind the requests, and move to a
 * newer run only when there genuinely is one.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, type ServerConfig } from "../src/config.js";
import type { OracleDataStore } from "../src/data/duckdb.js";
import type { PublishedRunPointer } from "../src/data/ipns.js";
import { readLastKnownGood, resolveDataSource, RuntimeDataset } from "../src/data/source.js";

const NAME = "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un";
const OLD = "bafybeif5vpiyp2v5foc7k3swsgoujzlvo7exaspntdsrmc4tp5vkuok67q";
const NEW = "bafybeibshsx6h6xtbqb65at6oycndtpp3ufdou5i5unahulvtn46n4fr4m";

function configWithLatest(latest: Record<string, unknown> | null): ServerConfig {
  const dir = mkdtempSync(join(tmpdir(), "oracle-latest-"));
  const latestPath = join(dir, "latest.json");
  if (latest !== null) writeFileSync(latestPath, JSON.stringify(latest), "utf8");
  return {
    ...loadConfig({}),
    parquetSource: "",
    parquetSourceKind: "ipfs",
    ipnsName: NAME,
    latestPath,
  };
}

const publishedLatest = {
  runId: "20260910T153418Z",
  rootCid: NEW,
  ipnsName: NAME,
  // The publish step re-reads the pointer back from the provider and refuses to
  // record a run whose readback disagrees. Equality here is that evidence.
  resolvedCid: NEW,
  propertyCount: 215806,
};

const pointer = (rootCid: string, runId: string | null): PublishedRunPointer => ({
  ipnsName: NAME,
  rootCid,
  runId,
  propertyCount: null,
  gateway: "https://ipfs.io",
  origin: "ipns",
});

/** A store stand-in: opening is instant and closing is observable. */
function fakeStore(source: string): OracleDataStore {
  return {
    source,
    sourceKind: "ipfs",
    activeSource: source,
    close: vi.fn(),
  } as unknown as OracleDataStore;
}

describe("readLastKnownGood", () => {
  it("replays the pointer the last publication resolved and read back", () => {
    const known = readLastKnownGood(configWithLatest(publishedLatest));
    expect(known).toMatchObject({
      rootCid: NEW,
      runId: "20260910T153418Z",
      origin: "last-known-good",
    });
  });

  it("ignores a record whose IPNS readback did not confirm the root", () => {
    // rootCid published, resolvedCid something else: the name was never seen
    // pointing at this root, so the runtime must not serve it unchecked.
    expect(
      readLastKnownGood(configWithLatest({ ...publishedLatest, resolvedCid: OLD })),
    ).toBeNull();
    expect(
      readLastKnownGood(configWithLatest({ ...publishedLatest, resolvedCid: null })),
    ).toBeNull();
  });

  it("ignores a record for a different IPNS name, and a missing file", () => {
    expect(
      readLastKnownGood(configWithLatest({ ...publishedLatest, ipnsName: "k51other" })),
    ).toBeNull();
    expect(readLastKnownGood(configWithLatest(null))).toBeNull();
  });
});

describe("resolveDataSource", () => {
  it("opens on the cached pointer without touching the network", async () => {
    const resolve = vi.fn();
    const result = await resolveDataSource(configWithLatest(publishedLatest), resolve);
    expect(result.source).toContain(`/ipfs/${NEW}/query-table.parquet`);
    expect(result.stale).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves inline when there is nothing cached to replay", async () => {
    const resolve = vi.fn().mockResolvedValue(pointer(NEW, "20260910T153418Z"));
    const result = await resolveDataSource(configWithLatest(null), resolve);
    expect(resolve).toHaveBeenCalledOnce();
    expect(result.stale).toBe(false);
  });
});

describe("RuntimeDataset", () => {
  const open = async (
    config: ServerConfig,
    resolve: ReturnType<typeof vi.fn>,
    openStore = vi.fn(async (source: string) => fakeStore(source)),
  ) => {
    const opened = await RuntimeDataset.open(config, {
      resolve,
      openStore,
      refreshIntervalMs: 0,
    });
    return { ...opened, openStore };
  };

  it("serves immediately from the cached pointer, then confirms it live", async () => {
    const resolve = vi.fn().mockResolvedValue(pointer(NEW, "20260910T153418Z"));
    const { dataset, resolveMs } = await open(configWithLatest(publishedLatest), resolve);
    // Nothing was resolved to open, so the caller waited on no gateway at all.
    expect(resolve).not.toHaveBeenCalled();
    expect(resolveMs).toBeLessThan(50);
    expect(dataset.pointer?.origin).toBe("last-known-good");

    const outcome = await dataset.refresh();
    expect(outcome.status).toBe("current");
    expect(dataset.pointer?.origin).toBe("ipns");
    expect(dataset.store.source).toContain(NEW);
  });

  it("moves to a newer run and closes the store it replaced", async () => {
    const stale = { ...publishedLatest, rootCid: OLD, resolvedCid: OLD, runId: "20260910T135850Z" };
    const resolve = vi.fn().mockResolvedValue(pointer(NEW, "20260910T153418Z"));
    const { dataset, openStore } = await open(configWithLatest(stale), resolve);
    const replaced = dataset.store;

    const outcome = await dataset.refresh();
    expect(outcome.status).toBe("upgraded");
    expect(dataset.store.source).toContain(NEW);
    expect(replaced.close).toHaveBeenCalledOnce();
    expect(openStore).toHaveBeenCalledTimes(2);
  });

  it("refuses an older run, however confidently a gateway reports it", async () => {
    // Gateways cache IPNS per path and can serve a superseded record, so a
    // different CID is not necessarily a newer one.
    const resolve = vi.fn().mockResolvedValue(pointer(OLD, "20260910T135850Z"));
    const { dataset } = await open(configWithLatest(publishedLatest), resolve);
    const outcome = await dataset.refresh();
    expect(outcome.status).toBe("current");
    expect(dataset.store.source).toContain(NEW);
  });

  it("keeps serving when no gateway answers", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("No gateway resolved IPNS name"));
    const { dataset } = await open(configWithLatest(publishedLatest), resolve);
    const outcome = await dataset.refresh();
    expect(outcome.status).toBe("failed");
    // The whole point: a gateway outage is degraded freshness, not an outage.
    expect(dataset.store.source).toContain(NEW);
    expect(dataset.pointer?.rootCid).toBe(NEW);
  });

  it("keeps serving when the newer run cannot be opened", async () => {
    const stale = { ...publishedLatest, rootCid: OLD, resolvedCid: OLD, runId: "20260910T135850Z" };
    const resolve = vi.fn().mockResolvedValue(pointer(NEW, "20260910T153418Z"));
    const openStore = vi
      .fn(async (source: string) => fakeStore(source))
      .mockImplementationOnce(async (source: string) => fakeStore(source))
      .mockImplementationOnce(() => Promise.reject(new Error("gateway 429")));
    const { dataset } = await open(configWithLatest(stale), resolve, openStore);
    const held = dataset.store;

    expect((await dataset.refresh()).status).toBe("failed");
    expect(dataset.store).toBe(held);
    expect(held.close).not.toHaveBeenCalled();
    expect(dataset.pointer?.rootCid).toBe(OLD);
  });

  it("runs one refresh at a time and rate-limits the rest", async () => {
    let release: (value: PublishedRunPointer) => void = () => {};
    const resolve = vi.fn().mockImplementation(
      () =>
        new Promise<PublishedRunPointer>((resolveWith) => {
          release = resolveWith;
        }),
    );
    let clock = 1_000_000;
    const opened = await RuntimeDataset.open(configWithLatest(publishedLatest), {
      resolve,
      openStore: async (source: string) => fakeStore(source),
      now: () => clock,
      refreshIntervalMs: 300_000,
    });
    const first = opened.dataset.refresh();
    const second = opened.dataset.refresh();
    release(pointer(NEW, "20260910T153418Z"));
    await Promise.all([first, second]);
    expect(resolve).toHaveBeenCalledOnce();

    // Inside the interval nothing is attempted; past it, a real attempt again.
    expect((await opened.dataset.refresh()).status).toBe("skipped");
    clock += 300_001;
    const later = opened.dataset.refresh();
    release(pointer(NEW, "20260910T153418Z"));
    await later;
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
