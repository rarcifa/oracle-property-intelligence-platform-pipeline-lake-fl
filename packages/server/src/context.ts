/**
 * The application context every surface shares: one config, one DuckDB store,
 * and one cached view of which published run is being served.
 */

import type { ServerConfig } from "./config.js";
import { rootCidOf, type OracleDataStore } from "./data/duckdb.js";
import type { PublishedRunPointer } from "./data/ipns.js";
import type { ProvenanceContext } from "./data/queries.js";
import { readRunIdentity } from "./data/run.js";

export interface AppContext {
  config: ServerConfig;
  store: OracleDataStore;
  /** Provenance for a response, refreshed from disk at most once a minute. */
  provenance(): Promise<ProvenanceContext>;
}

const RUN_IDENTITY_TTL_MS = 60_000;

/**
 * Wire a context around a config and an initialised store.
 *
 * `pointer` is the IPNS resolution this process booted through, when it booted
 * through one. It takes precedence over `artifacts/latest.json` for run
 * identity, because a citation has to name the bytes that answered the query:
 * the deployed function ships a copy of `latest.json` inside its bundle, and
 * once the pointer moves, that copy describes a run this process is not
 * serving. Locally there is no pointer and the file is the best answer there is.
 */
export function createContext(
  config: ServerConfig,
  store: OracleDataStore,
  pointer: PublishedRunPointer | null = null,
): AppContext {
  let cached: { at: number; value: ProvenanceContext } | null = null;

  return {
    config,
    store,
    async provenance(): Promise<ProvenanceContext> {
      const now = Date.now();
      if (cached !== null && now - cached.at < RUN_IDENTITY_TTL_MS) return cached.value;
      const identity = await readRunIdentity(config);
      const servedCid = rootCidOf(store.activeSource ?? store.source);
      const value: ProvenanceContext = {
        runId: pointer?.runId ?? identity.runId,
        // The CID actually being read wins over any recorded one.
        rootCid: servedCid ?? pointer?.rootCid ?? identity.rootCid,
        dataSource: store.source,
        dataSourceKind: store.sourceKind,
      };
      cached = { at: now, value };
      return value;
    },
  };
}
