/**
 * Deciding which bytes this process serves, once, at boot.
 *
 * Three ways to name the dataset, in descending precedence: an explicit
 * `ORACLE_PARQUET_URL`/`ORACLE_PARQUET_PATH`, a run published on this machine,
 * or the county's IPNS name. The first two are already resolved synchronously
 * in `loadConfig`; only the third needs the network, so it lives here.
 *
 * There is deliberately no fallback from the pointer to a remembered CID. The
 * deployment used to bake the newest CID into the function's environment at
 * `cdk deploy` time, which made a scheduled publish invisible to the runtime
 * until someone redeployed — the pointer moved and the served data did not.
 */

import { parquetUrl } from "@oracle-lake/shared";
import type { ServerConfig } from "../config.js";
import { type PublishedRunPointer, resolvePublishedRun } from "./ipns.js";

/** The Parquet this process will open, and how it was arrived at. */
export interface ResolvedDataSource {
  source: string;
  /** The pointer that produced it, when the IPNS name was resolved. */
  pointer: PublishedRunPointer | null;
}

/**
 * Resolve the configured dataset to a concrete Parquet location.
 *
 * @throws when nothing names a dataset, or when the IPNS name resolves nowhere.
 */
export async function resolveDataSource(
  config: ServerConfig,
  resolve: (name: string) => Promise<PublishedRunPointer> = resolvePublishedRun,
): Promise<ResolvedDataSource> {
  if (config.parquetSource.length > 0) return { source: config.parquetSource, pointer: null };
  if (config.ipnsName === null) {
    throw new Error(
      "No dataset configured. Set ORACLE_PARQUET_PATH to a local file, ORACLE_PARQUET_URL to a " +
        "gateway URL, or ORACLE_IPNS_NAME to the county's published IPNS name.",
    );
  }
  const pointer = await resolve(config.ipnsName);
  // The candidate list in `OracleDataStore` re-hosts this CID across every
  // range-read gateway, so naming one here picks a starting point, not a vendor.
  return { source: parquetUrl(pointer.rootCid), pointer };
}
