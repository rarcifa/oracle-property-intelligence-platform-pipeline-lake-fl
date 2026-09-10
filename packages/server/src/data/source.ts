/**
 * Deciding which bytes this process serves, and keeping that decision current.
 *
 * Three ways to name the dataset, in descending precedence: an explicit
 * `ORACLE_PARQUET_URL`/`ORACLE_PARQUET_PATH`, a run published on this machine,
 * or the county's IPNS name. The first two are already resolved synchronously
 * in `loadConfig`; only the third needs the network.
 *
 * ## Why the network is not on the startup path
 *
 * Resolving IPNS at cold start was correct and slow: it put four gateways and
 * two probe paths in front of the first byte a caller ever sees, and a public
 * gateway that rate-limits datacenter egress turned a 4 s cold start into a
 * 13 s one. Worse, it made a gateway outage a *runtime* outage — with nothing
 * to fall back to, a boot that could not reach any gateway could not serve at
 * all, and this surface is a read-only view of data that is already immutable
 * and already published.
 *
 * So the pointer is now read from the last successful resolution — the
 * `artifacts/latest.json` written by the publish step, which records the CID
 * the IPNS name resolved to *and was read back as* at publish time — and the
 * live resolution happens behind the first requests. When it comes back with a
 * newer run, {@link RuntimeDataset} opens that one and swaps it in.
 *
 * ## Why this is not a pinned CID
 *
 * `deploy-open-data-mcp` says to leave `ORACLE_OPEN_DATA_INDEX_CID` unset when
 * an IPNS name is configured, so IPNS stays the single source of truth. That
 * rule is about pinning a fixed CID *instead of* IPNS — a second, competing
 * source that only a redeploy can move. This is the opposite: the only
 * configured source of truth is still the IPNS name, nothing here is pinned,
 * and the cached value is itself an IPNS resolution that the live pointer
 * overrides as soon as it disagrees. No CID is deployed as configuration; see
 * `docs/lake-kit-deviations.md`.
 */

import { readFileSync } from "node:fs";
import { parquetUrl, type LatestRunPointer } from "@oracle-lake/shared";
import type { ServerConfig } from "../config.js";
import { OracleDataStore } from "./duckdb.js";
import { type PublishedRunPointer, resolvePublishedRun } from "./ipns.js";

/** How long a resolved pointer is trusted before a refresh is worth attempting. */
export const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Resolve an IPNS name to the run it currently publishes. */
export type ResolvePointer = (ipnsName: string) => Promise<PublishedRunPointer>;

/** The Parquet this process will open, and how it was arrived at. */
export interface ResolvedDataSource {
  source: string;
  /** The pointer that produced it, when one was involved. */
  pointer: PublishedRunPointer | null;
  /**
   * True when `pointer` came from the cache rather than from a live
   * resolution, so the caller should refresh it behind the first requests.
   */
  stale: boolean;
}

/**
 * The pointer the last successful publication resolved, replayed from disk.
 *
 * Only an IPNS-confirmed root qualifies. `publish-run.mjs` re-reads the pointer
 * back from the provider after re-pointing it and refuses to record a run whose
 * readback disagrees with what it published, so `resolvedCid === rootCid` is
 * the evidence that this CID is one the name actually resolved to. A file that
 * names a different IPNS name, or that records no readback, is ignored rather
 * than trusted — the runtime must never serve a root nothing verified.
 *
 * @returns the cached pointer, or null when there is no usable one.
 */
export function readLastKnownGood(config: ServerConfig): PublishedRunPointer | null {
  if (config.ipnsName === null) return null;
  let latest: LatestRunPointer;
  try {
    latest = JSON.parse(readFileSync(config.latestPath, "utf8")) as LatestRunPointer;
  } catch {
    return null;
  }
  if (latest.ipnsName !== config.ipnsName) return null;
  if (typeof latest.rootCid !== "string" || latest.rootCid.length === 0) return null;
  if (latest.resolvedCid !== latest.rootCid) return null;
  return {
    ipnsName: config.ipnsName,
    rootCid: latest.rootCid,
    runId: typeof latest.runId === "string" ? latest.runId : null,
    propertyCount: typeof latest.propertyCount === "number" ? latest.propertyCount : null,
    gateway: config.latestPath,
    origin: "last-known-good",
  };
}

/**
 * Resolve the configured dataset to a concrete Parquet location.
 *
 * Never blocks on the network when a verified pointer is already known; the
 * caller refreshes that in the background. Falls back to resolving inline when
 * there is nothing cached, which is the genuinely-first-run case.
 *
 * @throws when nothing names a dataset, or when an inline resolution finds no
 *   gateway that will answer.
 */
export async function resolveDataSource(
  config: ServerConfig,
  resolve: ResolvePointer = resolvePublishedRun,
): Promise<ResolvedDataSource> {
  if (config.parquetSource.length > 0) {
    return { source: config.parquetSource, pointer: null, stale: false };
  }
  if (config.ipnsName === null) {
    throw new Error(
      "No dataset configured. Set ORACLE_PARQUET_PATH to a local file, ORACLE_PARQUET_URL to a " +
        "gateway URL, or ORACLE_IPNS_NAME to the county's published IPNS name.",
    );
  }
  const cached = readLastKnownGood(config);
  // The candidate list in `OracleDataStore` re-hosts whichever CID this is
  // across every range-read gateway, so naming one here picks a starting point,
  // not a vendor.
  if (cached !== null) return { source: parquetUrl(cached.rootCid), pointer: cached, stale: true };
  const pointer = await resolve(config.ipnsName);
  return { source: parquetUrl(pointer.rootCid), pointer, stale: false };
}

/** What a dataset holder exposes to the request path. */
export interface DatasetHandle {
  readonly store: OracleDataStore;
  readonly pointer: PublishedRunPointer | null;
}

/** Reported by a refresh, so the caller can log and meter what happened. */
export type RefreshOutcome =
  | { status: "skipped" }
  | { status: "current"; pointer: PublishedRunPointer }
  | { status: "upgraded"; pointer: PublishedRunPointer; from: string }
  | { status: "failed"; error: Error };

export interface RuntimeDatasetOptions {
  resolve?: ResolvePointer;
  openStore?: (source: string) => Promise<OracleDataStore>;
  now?: () => number;
  refreshIntervalMs?: number;
}

async function openDuckDbStore(source: string): Promise<OracleDataStore> {
  const store = new OracleDataStore({ source });
  await store.init();
  return store;
}

/**
 * The dataset this process is serving, and the machinery to move it forward.
 *
 * Holds one open store. `refresh` resolves the IPNS pointer, and when the name
 * has moved to a newer run it opens that run and swaps it in — the old store is
 * closed only once the new one is open and has passed its schema gate, so a
 * failed upgrade leaves the process serving exactly what it was serving before.
 */
export class RuntimeDataset implements DatasetHandle {
  #store: OracleDataStore;

  #pointer: PublishedRunPointer | null;

  #inFlight: Promise<RefreshOutcome> | null = null;

  #lastAttemptAt = 0;

  readonly #resolve: ResolvePointer;

  readonly #openStore: (source: string) => Promise<OracleDataStore>;

  readonly #now: () => number;

  readonly #refreshIntervalMs: number;

  private constructor(
    store: OracleDataStore,
    pointer: PublishedRunPointer | null,
    options: RuntimeDatasetOptions,
  ) {
    this.#store = store;
    this.#pointer = pointer;
    this.#resolve = options.resolve ?? resolvePublishedRun;
    this.#openStore = options.openStore ?? openDuckDbStore;
    this.#now = options.now ?? Date.now;
    this.#refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
    // A pointer replayed from cache has not been checked against the live name
    // yet, so the first refresh must not be rate-limited away.
    this.#lastAttemptAt = pointer?.origin === "last-known-good" ? 0 : this.#now();
  }

  /** Open the configured dataset. Never waits on the network when it need not. */
  static async open(
    config: ServerConfig,
    options: RuntimeDatasetOptions = {},
  ): Promise<{ dataset: RuntimeDataset; resolveMs: number; openMs: number; stale: boolean }> {
    const resolveStarted = Date.now();
    const resolved = await resolveDataSource(config, options.resolve ?? resolvePublishedRun);
    const resolveMs = Date.now() - resolveStarted;
    const openStarted = Date.now();
    const store = await (options.openStore ?? openDuckDbStore)(resolved.source);
    return {
      dataset: new RuntimeDataset(store, resolved.pointer, options),
      resolveMs,
      openMs: Date.now() - openStarted,
      stale: resolved.stale,
    };
  }

  get store(): OracleDataStore {
    return this.#store;
  }

  get pointer(): PublishedRunPointer | null {
    return this.#pointer;
  }

  /**
   * Bring the pointer up to date, at most one attempt at a time.
   *
   * Rate-limited rather than run per request: the published name moves at most
   * daily, and a container that asked a minute ago has nothing to learn. A
   * failure is never cached — the next attempt after the interval is a real one
   * — because a gateway that is rate-limiting now will not be later.
   */
  async refresh(): Promise<RefreshOutcome> {
    if (this.#inFlight !== null) return this.#inFlight;
    if (this.#pointer === null) return { status: "skipped" };
    if (this.#now() - this.#lastAttemptAt < this.#refreshIntervalMs) return { status: "skipped" };
    this.#lastAttemptAt = this.#now();
    this.#inFlight = this.#run(this.#pointer.ipnsName).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #run(ipnsName: string): Promise<RefreshOutcome> {
    let resolved: PublishedRunPointer;
    try {
      resolved = await this.#resolve(ipnsName);
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error : new Error(String(error)) };
    }
    const current = this.#pointer;
    // Same CID: the cached pointer was right, and is now live-confirmed.
    if (current !== null && resolved.rootCid === current.rootCid) {
      this.#pointer = resolved;
      return { status: "current", pointer: resolved };
    }
    // A different CID only wins if it is a NEWER run. Gateways cache IPNS per
    // path and can serve a superseded record, so "different" is not "newer".
    if ((resolved.runId ?? "") <= (current?.runId ?? "")) {
      return { status: "current", pointer: current ?? resolved };
    }
    try {
      const next = await this.#openStore(parquetUrl(resolved.rootCid));
      const previous = this.#store;
      this.#store = next;
      this.#pointer = resolved;
      previous.close();
      return { status: "upgraded", pointer: resolved, from: current?.rootCid ?? "" };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /** Release the open store. */
  close(): void {
    this.#store.close();
  }
}
