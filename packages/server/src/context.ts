/**
 * The application context every surface shares: one config, one DuckDB store,
 * and one cached view of which published run is being served.
 */

import type { ServerConfig } from "./config.js";
import { rootCidOf, type OracleDataStore } from "./data/duckdb.js";
import type { PublishedRunPointer } from "./data/ipns.js";
import type { ProvenanceContext } from "./data/queries.js";
import { readRunIdentity } from "./data/run.js";
import type { DatasetHandle } from "./data/source.js";

export interface AppContext {
  config: ServerConfig;
  /**
   * The open dataset.
   *
   * A getter, not a field: the process can move to a newer published run
   * without restarting, and every surface must follow it in the same instant.
   */
  readonly store: OracleDataStore;
  /** Provenance for a response, refreshed from disk at most once a minute. */
  provenance(): Promise<ProvenanceContext>;
}

const RUN_IDENTITY_TTL_MS = 60_000;

/** Adapt a bare store into the handle shape, for tests and fixtures. */
function asHandle(
  source: OracleDataStore | DatasetHandle,
  pointer: PublishedRunPointer | null,
): DatasetHandle {
  return "store" in source ? source : { store: source, pointer };
}

/**
 * Wire a context around a config and an open dataset.
 *
 * `pointer` is the published run this process is serving. It takes precedence
 * over `artifacts/latest.json` for run identity, because a citation has to name
 * the bytes that answered the query: the deployed function ships a copy of
 * `latest.json` inside its bundle, and once the pointer moves, that copy
 * describes a run this process may not be serving. Locally there is no pointer
 * and the file is the best answer there is.
 */
export function createContext(
  config: ServerConfig,
  source: OracleDataStore | DatasetHandle,
  pointer: PublishedRunPointer | null = null,
): AppContext {
  const dataset = asHandle(source, pointer);
  let cached: { at: number; value: ProvenanceContext } | null = null;

  return {
    config,
    get store(): OracleDataStore {
      return dataset.store;
    },
    async provenance(): Promise<ProvenanceContext> {
      const now = Date.now();
      const store = dataset.store;
      const servedCid = rootCidOf(store.activeSource ?? store.source);
      // The cache is keyed on the bytes being served, so an upgrade to a newer
      // run invalidates it immediately rather than citing the old run for up to
      // a minute afterwards.
      if (
        cached !== null &&
        now - cached.at < RUN_IDENTITY_TTL_MS &&
        cached.value.rootCid === servedCid
      ) {
        return cached.value;
      }
      const identity = await readRunIdentity(config);
      const value: ProvenanceContext = {
        runId: dataset.pointer?.runId ?? identity.runId,
        // The CID actually being read wins over any recorded one.
        rootCid: servedCid ?? dataset.pointer?.rootCid ?? identity.rootCid,
        dataSource: store.source,
        dataSourceKind: store.sourceKind,
      };
      cached = { at: now, value };
      return value;
    },
  };
}
