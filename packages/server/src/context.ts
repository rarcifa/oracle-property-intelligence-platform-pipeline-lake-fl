/**
 * The application context every surface shares: one config, one DuckDB store,
 * and one cached view of which published run is being served.
 */

import type { ServerConfig } from "./config.js";
import type { OracleDataStore } from "./data/duckdb.js";
import type { ProvenanceContext } from "./data/queries.js";
import { readRunIdentity } from "./data/run.js";

export interface AppContext {
  config: ServerConfig;
  store: OracleDataStore;
  /** Provenance for a response, refreshed from disk at most once a minute. */
  provenance(): Promise<ProvenanceContext>;
}

const RUN_IDENTITY_TTL_MS = 60_000;

/** Wire a context around a config and an initialised store. */
export function createContext(config: ServerConfig, store: OracleDataStore): AppContext {
  let cached: { at: number; value: ProvenanceContext } | null = null;

  return {
    config,
    store,
    async provenance(): Promise<ProvenanceContext> {
      const now = Date.now();
      if (cached !== null && now - cached.at < RUN_IDENTITY_TTL_MS) return cached.value;
      const identity = await readRunIdentity(config);
      const value: ProvenanceContext = {
        ...identity,
        dataSource: store.source,
        dataSourceKind: store.sourceKind,
      };
      cached = { at: now, value };
      return value;
    },
  };
}
