/** Explicit public partial-preview selection; never writes a publication pointer. */
export interface PinnedRuntimeSelection {
  runId: string;
  rootCid: string;
  parquetUrl: string;
}

export function pinnedRuntimeSelection(
  env: Readonly<Record<string, string | undefined>>,
): PinnedRuntimeSelection | null {
  const runId = env.ORACLE_DATA_RUN_ID;
  const rootCid = env.ORACLE_DATA_ROOT_CID;
  if (runId === undefined && rootCid === undefined) return null;
  if (!runId || !/^\d{8}T\d{6}Z$/.test(runId) || !rootCid || !/^bafy[a-z2-7]+$/.test(rootCid))
    throw new Error("Pinned runtime requires an exact run ID and CIDv1 root");
  const value = env.ORACLE_PARQUET_URL;
  if (!value) throw new Error("Pinned runtime requires its CID-addressed public Parquet URL");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/ipfs/${rootCid}/query-table.parquet`
  )
    throw new Error("Pinned runtime Parquet URL must address the selected root CID exactly");
  return { runId, rootCid, parquetUrl: value };
}

export function assertRuntimeBundleIdentity(
  selected: PinnedRuntimeSelection,
  coverage: { runId?: unknown },
  index: { runId?: unknown },
  manifest: { runId?: unknown; root?: { cid?: unknown } },
): void {
  if (
    coverage.runId !== selected.runId ||
    index.runId !== selected.runId ||
    manifest.runId !== selected.runId ||
    manifest.root?.cid !== selected.rootCid
  )
    throw new Error(
      "Runtime bundle metadata/manifest do not describe the selected public snapshot",
    );
}
